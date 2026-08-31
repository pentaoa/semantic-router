package evaluationplane

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	workerBrokerRequestFD     = 3
	workerBrokerResponseFD    = 4
	maxWorkerBrokerFrameBytes = 4 * 1024 * 1024
	maxWorkerBrokerBytes      = 512 * 1024 * 1024
	maxWorkerBrokerRequests   = 50_000
	maxWorkerBrokerTimeoutMS  = 300_000
	maxWorkerBrokerConcurrent = 128
)

const (
	workerBrokerListModels                 = "models.list"
	workerBrokerRoutedChatCompletion       = "routed-chat.completions"
	workerBrokerArmChatCompletion          = "arm-chat.completions"
	workerBrokerRouterEvaluate             = "router.evaluate"
	workerBrokerAgentTaskLedger            = "agent-task.ledger"
	workerBrokerFaultRecoveryLedger        = "fault-recovery.ledger"
	workerBrokerHardPolicyLedger           = "hard-policy.ledger"
	workerBrokerProductionExperimentLedger = "production.experiment-ledger"
)

type workerBrokerRequest struct {
	ID        uint64          `json:"id"`
	Operation string          `json:"operation"`
	TrackID   TrackID         `json:"track_id,omitempty"`
	CaseID    string          `json:"case_id,omitempty"`
	AttemptID string          `json:"attempt_id,omitempty"`
	Payload   json.RawMessage `json:"payload"`
	TimeoutMS int             `json:"timeout_ms"`
}

type workerBrokerResponse struct {
	ID            uint64            `json:"id"`
	Success       bool              `json:"success"`
	StatusCode    *int              `json:"status_code"`
	Payload       map[string]any    `json:"payload"`
	LatencyMS     float64           `json:"latency_ms"`
	FetchedAt     time.Time         `json:"fetched_at"`
	Headers       map[string]string `json:"headers"`
	Error         *string           `json:"error"`
	BrokerReceipt string            `json:"broker_receipt"`
}

type workerBrokerOperation struct {
	method       string
	url          string
	credential   string
	maxTimeoutMS int
}

type workerHTTPBroker struct {
	manifest       RunManifest
	operations     map[string]workerBrokerOperation
	client         *http.Client
	semaphore      chan struct{}
	writeMu        sync.Mutex
	modelsMu       sync.RWMutex
	models         map[string]string
	modelsValid    bool
	entriesMu      sync.Mutex
	entries        map[uint64]executionAttestationEntry
	startedAt      time.Time
	requestMax     int
	controlledPair *controlledPairRunContext
}

func newWorkerHTTPBroker(manifest RunManifest, credentials workerBrokerCredentials) *workerHTTPBroker {
	operations := make(map[string]workerBrokerOperation, 8)
	add := func(name, method, rawURL, credential string, maxTimeoutMS int) {
		operations[name] = workerBrokerOperation{
			method: method, url: rawURL, credential: credential, maxTimeoutMS: maxTimeoutMS,
		}
	}
	if manifest.Target.EnvoyURL != "" {
		add(workerBrokerListModels, http.MethodGet, manifest.Target.EnvoyURL+"/v1/models", credentials.envoy, 0)
		add(workerBrokerRoutedChatCompletion, http.MethodPost, manifest.Target.EnvoyURL+"/v1/chat/completions", credentials.envoy, 0)
		add(workerBrokerArmChatCompletion, http.MethodPost, manifest.Target.EnvoyURL+"/v1/chat/completions", credentials.envoy, 0)
	}
	if manifest.Target.RouterAPIURL != "" {
		add(workerBrokerRouterEvaluate, http.MethodPost, manifest.Target.RouterAPIURL+"/api/v1/eval?trace=true", credentials.router, 0)
	}
	if endpoint := manifest.Target.AgentTaskLedger; endpoint != nil {
		add(workerBrokerAgentTaskLedger, http.MethodGet, endpoint.URL, credentials.agentTaskLedger, endpointTimeoutMS(endpoint))
	}
	if endpoint := manifest.Target.FaultRecoveryLedger; endpoint != nil {
		add(workerBrokerFaultRecoveryLedger, http.MethodGet, endpoint.URL, credentials.faultRecoveryLedger, endpointTimeoutMS(endpoint))
	}
	if endpoint := manifest.Target.HardPolicyLedger; endpoint != nil {
		add(workerBrokerHardPolicyLedger, http.MethodGet, endpoint.URL, credentials.hardPolicyLedger, endpointTimeoutMS(endpoint))
	}
	if endpoint := manifest.Target.ProductionExperimentLedger; endpoint != nil {
		add(workerBrokerProductionExperimentLedger, http.MethodGet, endpoint.URL, credentials.productionExperimentLedger, endpointTimeoutMS(endpoint))
	}
	concurrency := manifest.Concurrency
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > maxWorkerBrokerConcurrent {
		concurrency = maxWorkerBrokerConcurrent
	}
	perCaseRequestBudget := int64(len(manifest.TrackIDs) + 2)
	if manifest.Target.Mixture != nil && containsTrack(manifest.TrackIDs, "model_pool") {
		perCaseRequestBudget += int64(len(manifest.Target.Mixture.ModelArms))
	}
	caseBudget := int64(manifest.SampleLimit)
	if len(manifest.SuiteIDs) > 1 {
		caseBudget *= int64(len(manifest.SuiteIDs))
	}
	requestMaxBudget := int64(64) + caseBudget*perCaseRequestBudget
	if manifest.CapacityLoadProtocol != nil {
		requestMaxBudget += capacityLoadRequestBudget(*manifest.CapacityLoadProtocol)
	}
	if requestMaxBudget > maxWorkerBrokerRequests {
		requestMaxBudget = maxWorkerBrokerRequests
	}
	requestMax := int(requestMaxBudget)
	transport := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 10 * time.Second, KeepAlive: 30 * time.Second,
		}).DialContext,
		DisableCompression:  true,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        concurrency,
		MaxIdleConnsPerHost: concurrency,
		IdleConnTimeout:     30 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	return &workerHTTPBroker{
		manifest:   manifest,
		operations: operations,
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		semaphore:  make(chan struct{}, concurrency),
		models:     make(map[string]string),
		entries:    make(map[uint64]executionAttestationEntry),
		startedAt:  time.Now().UTC(),
		requestMax: requestMax,
	}
}

func endpointTimeoutMS(endpoint *ServiceEndpoint) int {
	return int(math.Ceil(endpoint.TimeoutSeconds * 1000))
}

func (broker *workerHTTPBroker) serve(ctx context.Context, reader io.Reader, writer io.Writer) error {
	buffered := bufio.NewReaderSize(reader, 64*1024)
	var workers sync.WaitGroup
	defer workers.Wait()
	var lastID uint64
	var transferred int64
	for count := 0; ; count++ {
		frame, err := readWorkerBrokerFrame(buffered)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		transferred += int64(len(frame))
		if count >= broker.requestMax || transferred > maxWorkerBrokerBytes {
			return fmt.Errorf("evaluation worker HTTP broker request limit exceeded")
		}
		request, err := decodeWorkerBrokerRequest(frame, lastID, broker.operations)
		if err != nil {
			return err
		}
		lastID = request.ID
		select {
		case broker.semaphore <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-broker.semaphore }()
			response := broker.execute(ctx, request)
			broker.writeMu.Lock()
			writeErr := writeWorkerBrokerFrame(writer, response)
			broker.writeMu.Unlock()
			if writeErr != nil {
				// Closing the response pipe is the fail-closed signal to the worker.
				if closer, ok := writer.(io.Closer); ok {
					_ = closer.Close()
				}
			}
		}()
	}
}

func decodeWorkerBrokerRequest(
	frame []byte,
	lastID uint64,
	operations map[string]workerBrokerOperation,
) (workerBrokerRequest, error) {
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	var request workerBrokerRequest
	if err := decoder.Decode(&request); err != nil {
		return workerBrokerRequest{}, fmt.Errorf("decode evaluation worker HTTP broker request: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return workerBrokerRequest{}, err
	}
	if request.ID == 0 || request.ID != lastID+1 ||
		request.TimeoutMS < 1 || request.TimeoutMS > maxWorkerBrokerTimeoutMS {
		return workerBrokerRequest{}, fmt.Errorf("evaluation worker HTTP broker request envelope is invalid")
	}
	operation, ok := operations[request.Operation]
	if !ok || operation.method == "" || operation.url == "" {
		return workerBrokerRequest{}, fmt.Errorf("evaluation worker requested an unapproved HTTP operation")
	}
	payload := bytes.TrimSpace(request.Payload)
	if operation.maxTimeoutMS > 0 && request.TimeoutMS > operation.maxTimeoutMS {
		return workerBrokerRequest{}, fmt.Errorf("evaluation worker HTTP broker timeout exceeds the endpoint contract")
	}
	if operation.method == http.MethodGet {
		if !bytes.Equal(payload, []byte("null")) {
			return workerBrokerRequest{}, fmt.Errorf("evaluation worker HTTP GET payload is invalid")
		}
		switch request.Operation {
		case workerBrokerListModels:
			if request.TrackID != "" || request.CaseID != "" || request.AttemptID != "" {
				return workerBrokerRequest{}, fmt.Errorf("model discovery cannot bind evidence")
			}
		case workerBrokerAgentTaskLedger:
			if request.TrackID != "agentic" || !validBrokerEvidenceAttempt(request) {
				return workerBrokerRequest{}, fmt.Errorf("agent-task ledger requests must bind agentic evidence")
			}
		case workerBrokerFaultRecoveryLedger:
			if request.TrackID != "agentic" || !validBrokerEvidenceAttempt(request) {
				return workerBrokerRequest{}, fmt.Errorf("fault-recovery ledger requests must bind agentic evidence")
			}
		case workerBrokerHardPolicyLedger:
			if request.TrackID != "safety" || !validBrokerEvidenceAttempt(request) {
				return workerBrokerRequest{}, fmt.Errorf("hard-policy ledger requests must bind safety evidence")
			}
		case workerBrokerProductionExperimentLedger:
			if request.TrackID != "preference" || !validBrokerEvidenceAttempt(request) {
				return workerBrokerRequest{}, fmt.Errorf("production experiment ledger requests must bind preference evidence")
			}
		}
	} else {
		if !validBrokerEvidenceAttempt(request) || len(payload) < 2 || payload[0] != '{' ||
			payload[len(payload)-1] != '}' || !json.Valid(payload) {
			return workerBrokerRequest{}, fmt.Errorf("evaluation worker HTTP POST evidence envelope is invalid")
		}
		if request.Operation == workerBrokerRouterEvaluate && request.TrackID != "routing" {
			return workerBrokerRequest{}, fmt.Errorf("router evaluation requests must bind routing evidence")
		}
		if request.Operation == workerBrokerRoutedChatCompletion && request.TrackID != "joint" &&
			request.TrackID != "multimodal" && request.TrackID != "capacity" {
			return workerBrokerRequest{}, fmt.Errorf("routed chat requests must bind joint, multimodal, or capacity evidence")
		}
		if request.Operation == workerBrokerArmChatCompletion && request.TrackID != "model_pool" {
			return workerBrokerRequest{}, fmt.Errorf("arm chat requests must bind model_pool evidence")
		}
	}
	return request, nil
}

func validBrokerEvidenceAttempt(request workerBrokerRequest) bool {
	return containsTrack(allTrackIDs, request.TrackID) && evidenceIDPattern.MatchString(request.CaseID) &&
		evidenceIDPattern.MatchString(request.AttemptID)
}

func (broker *workerHTTPBroker) execute(ctx context.Context, request workerBrokerRequest) (response workerBrokerResponse) {
	started := time.Now()
	response = workerBrokerResponse{ID: request.ID, Headers: map[string]string{}}
	requestPayload := bytes.TrimSpace(request.Payload)
	var responsePayloadBytes []byte
	upstreamAttempted := false
	var pairing *controlledPairObservation
	var pairLease *controlledPairLease
	defer func() {
		completedAt := time.Now().UTC()
		response.FetchedAt = completedAt
		if pairing != nil {
			if pairing.ObservedAt.IsZero() {
				pairing.ObservedAt = started.UTC()
			}
			pairing.CompletedAt = completedAt
			pairLease.complete(completedAt)
		}
		elapsed := time.Since(started).Microseconds()
		if elapsed < 0 {
			elapsed = 0
		}
		response.LatencyMS = float64(elapsed) / 1000
		entry := broker.attestResponse(
			request, requestPayload, responsePayloadBytes, response, upstreamAttempted, elapsed, pairing,
		)
		response.BrokerReceipt = entry.BrokerReceipt
	}()
	operation, ok := broker.operations[request.Operation]
	if !ok {
		return failedWorkerBrokerResponse(response, "request_error")
	}
	validatedPayload, err := broker.validatedPayload(request.Operation, request.Payload)
	if err != nil {
		return failedWorkerBrokerResponse(response, "request_error")
	}
	requestPayload = validatedPayload
	if broker.controlledPair != nil {
		pairing, pairLease, err = broker.controlledPair.coordinator.before(
			ctx, broker.controlledPair.role, request, requestPayload,
		)
		if err != nil {
			broker.controlledPair.coordinator.abort(err)
			return failedWorkerBrokerResponse(response, "controlled_pair_error")
		}
		started = time.Now()
		if pairing != nil {
			pairing.ObservedAt = started.UTC()
		}
	}
	requestContext, cancel := context.WithTimeout(ctx, time.Duration(request.TimeoutMS)*time.Millisecond)
	defer cancel()
	httpRequest, err := newWorkerBrokerHTTPRequest(requestContext, operation, requestPayload)
	if err != nil {
		return failedWorkerBrokerResponse(response, "request_error")
	}
	upstreamAttempted = true
	httpResponse, err := broker.client.Do(httpRequest)
	if err != nil {
		return failedWorkerBrokerResponse(response, "request_error")
	}
	defer func() {
		if closeErr := httpResponse.Body.Close(); closeErr != nil {
			response = failedWorkerBrokerResponse(response, "response_error")
		}
	}()
	response, responsePayloadBytes = broker.readUpstreamResponse(request.Operation, httpResponse, response)
	return response
}

func newWorkerBrokerHTTPRequest(
	ctx context.Context,
	operation workerBrokerOperation,
	payload []byte,
) (*http.Request, error) {
	var body io.Reader
	if operation.method == http.MethodPost {
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, operation.method, operation.url, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if operation.method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
	}
	if operation.credential != "" {
		request.Header.Set("Authorization", "Bearer "+operation.credential)
	}
	return request, nil
}

func (broker *workerHTTPBroker) readUpstreamResponse(
	operation string,
	httpResponse *http.Response,
	response workerBrokerResponse,
) (workerBrokerResponse, []byte) {
	response.StatusCode = &httpResponse.StatusCode
	for _, name := range []string{
		"x-vsr-selected-model", "x-vsr-selected-algorithm",
		"x-vsr-selected-recipe", "x-vsr-selected-decision",
	} {
		value := httpResponse.Header.Get(name)
		if value != "" && len(value) <= 256 && !strings.ContainsAny(value, "\r\n") {
			response.Headers[name] = value
		}
	}
	limited := io.LimitReader(httpResponse.Body, maxWorkerBrokerFrameBytes+1)
	data, readErr := io.ReadAll(limited)
	if readErr != nil || len(data) > maxWorkerBrokerFrameBytes {
		return failedWorkerBrokerResponse(response, "response_error"), data
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var responsePayload map[string]any
	if err := decoder.Decode(&responsePayload); err == nil && ensureJSONEOF(decoder) == nil && responsePayload != nil {
		response.Payload = responsePayload
	}
	if operation == workerBrokerListModels && response.Payload != nil {
		broker.captureSelectableModels(response.Payload)
	}
	response.Success = httpResponse.StatusCode >= 200 && httpResponse.StatusCode < 300 && response.Payload != nil
	if operation == workerBrokerListModels && response.Success && !broker.frozenEntrypointDiscovered() {
		response.Success = false
	}
	if !response.Success {
		message := "HTTP " + strconv.Itoa(httpResponse.StatusCode)
		response.Error = &message
	}
	return response, data
}

func (broker *workerHTTPBroker) frozenEntrypointDiscovered() bool {
	if broker.manifest.Target.Mixture == nil || len(broker.manifest.Target.Mixture.Aliases) == 0 {
		return false
	}
	broker.modelsMu.RLock()
	valid := broker.modelsValid
	for _, alias := range broker.manifest.Target.Mixture.Aliases {
		recipe, present := broker.models[alias]
		if !present || recipe != broker.manifest.Target.Mixture.RecipeName {
			valid = false
			break
		}
	}
	broker.modelsMu.RUnlock()
	return valid
}

func failedWorkerBrokerResponse(response workerBrokerResponse, message string) workerBrokerResponse {
	response.Success = false
	response.Error = &message
	return response
}

func (broker *workerHTTPBroker) attestResponse(
	request workerBrokerRequest,
	requestPayload []byte,
	responsePayload []byte,
	response workerBrokerResponse,
	upstreamAttempted bool,
	latencyMicroseconds int64,
	pairing *controlledPairObservation,
) executionAttestationEntry {
	entry := executionAttestationEntry{
		RequestID: request.ID, Operation: request.Operation, TrackID: request.TrackID,
		CaseID: request.CaseID, AttemptID: request.AttemptID,
		RequestDigest: digestBytes(requestPayload), ResponseDigest: digestBytes(responsePayload),
		UpstreamAttempted: upstreamAttempted, Success: response.Success,
		StatusCode: copyInt(response.StatusCode), LatencyMicroseconds: latencyMicroseconds,
		Headers: copyStringMap(response.Headers), responsePayload: response.Payload,
		ControlledPair: pairing, FetchedAt: copyTime(&response.FetchedAt),
	}
	entry.RequestedModel = brokerRequestedModel(request.Operation, requestPayload)
	entry.LedgerSealedAt = brokerLedgerSealedAt(request.Operation, response.Payload)
	populateBrokerObservedFields(&entry, response.Payload)
	// Router diagnostics expose both the configured decision algorithm and the
	// method that actually selected this request. Execution evidence is bound to
	// the realized method; the configured algorithm remains in routing traces.
	if request.Operation == workerBrokerRouterEvaluate {
		entry.Algorithm = copyString(entry.SelectionMethod)
	}
	if entry.SelectedModel == nil && (request.Operation == workerBrokerRoutedChatCompletion ||
		request.Operation == workerBrokerArmChatCompletion) {
		entry.SelectedModel = nonEmptyStringPointer(response.Headers["x-vsr-selected-model"])
	}
	if response.Success && request.Operation == workerBrokerRoutedChatCompletion {
		method := nonEmptyStringPointer(response.Headers["x-vsr-selected-algorithm"])
		if entry.Algorithm == nil {
			entry.Algorithm = method
		}
		if entry.SelectionMethod == nil {
			entry.SelectionMethod = method
		}
		if entry.SelectionStatus == nil {
			entry.SelectionStatus = nonEmptyStringPointer("selected")
		}
	} else if request.Operation == workerBrokerRoutedChatCompletion {
		entry.SelectionStatus = nil
		entry.SelectionMethod = nil
		entry.Algorithm = nil
	}
	if entry.Recipe == nil && request.Operation == workerBrokerRoutedChatCompletion {
		entry.Recipe = nonEmptyStringPointer(response.Headers["x-vsr-selected-recipe"])
	}
	if entry.DecisionName == nil && request.Operation == workerBrokerRoutedChatCompletion {
		entry.DecisionName = nonEmptyStringPointer(response.Headers["x-vsr-selected-decision"])
	}
	if entry.Recipe == nil && (request.Operation == workerBrokerRoutedChatCompletion ||
		request.Operation == workerBrokerRouterEvaluate) && broker.manifest.Target.Mixture != nil {
		recipe := broker.manifest.Target.Mixture.RecipeName
		entry.Recipe = &recipe
	}
	entry.ArmID = broker.resolveAttestedArmID(entry)
	if content := brokerResponseContent(response.Payload); content != nil {
		digest := digestString(normalizedAnswer(*content))
		entry.ResponseContentDigest = &digest
	}
	receipt, err := brokerEntryReceipt(entry)
	if err == nil {
		entry.BrokerReceipt = receipt
	}
	broker.entriesMu.Lock()
	broker.entries[request.ID] = entry
	broker.entriesMu.Unlock()
	return entry
}

func brokerLedgerSealedAt(operation string, payload map[string]any) *time.Time {
	if !isMethodLedgerOperation(operation) || payload == nil {
		return nil
	}
	raw, ok := payload["sealed_at"].(string)
	if !ok {
		return nil
	}
	sealedAt, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return nil
	}
	sealedAt = sealedAt.UTC()
	return &sealedAt
}

func brokerRequestedModel(operation string, payload []byte) *string {
	switch operation {
	case workerBrokerRoutedChatCompletion, workerBrokerArmChatCompletion, workerBrokerRouterEvaluate:
	default:
		return nil
	}
	var envelope struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.Model == "" {
		return nil
	}
	return &envelope.Model
}

func (broker *workerHTTPBroker) resolveAttestedArmID(entry executionAttestationEntry) *string {
	if broker.manifest.Target.Mixture == nil {
		return nil
	}
	candidate := entry.SelectedModel
	if entry.Operation == workerBrokerArmChatCompletion {
		candidate = entry.RequestedModel
	}
	if candidate == nil {
		return nil
	}
	for _, arm := range broker.manifest.Target.Mixture.ModelArms {
		if *candidate == arm.ID || *candidate == arm.Model {
			armID := arm.ID
			return &armID
		}
	}
	return nil
}

func nonEmptyStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func copyString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func populateBrokerObservedFields(entry *executionAttestationEntry, payload map[string]any) {
	if payload == nil {
		return
	}
	entry.SelectedModel = mapStringPointer(payload, "selected_model")
	entry.SelectionStatus = mapStringPointer(payload, "selection_status")
	entry.SelectionMethod = mapStringPointer(payload, "selection_method")
	entry.Recipe = mapStringPointer(payload, "recipe")
	if decision, ok := payload["decision_result"].(map[string]any); ok {
		entry.DecisionName = mapStringPointer(decision, "decision_name")
		entry.Algorithm = mapStringPointer(decision, "algorithm")
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		entry.InputTokens = mapNonNegativeIntegerPointer(usage, "prompt_tokens")
		entry.OutputTokens = mapNonNegativeIntegerPointer(usage, "completion_tokens")
	}
}

func mapStringPointer(value map[string]any, key string) *string {
	text, ok := value[key].(string)
	if !ok {
		return nil
	}
	return &text
}

func mapNonNegativeIntegerPointer(value map[string]any, key string) *int64 {
	raw, ok := value[key]
	if !ok {
		return nil
	}
	var parsed int64
	switch number := raw.(type) {
	case json.Number:
		converted, err := number.Int64()
		if err != nil {
			return nil
		}
		parsed = converted
	case int64:
		parsed = number
	case int:
		parsed = int64(number)
	default:
		return nil
	}
	if parsed < 0 {
		return nil
	}
	return &parsed
}

func copyInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyStringMap(value map[string]string) map[string]string {
	copy := make(map[string]string, len(value))
	for key, item := range value {
		copy[key] = item
	}
	return copy
}

func (broker *workerHTTPBroker) transcript(completedAt time.Time) brokerExecutionTranscript {
	broker.entriesMu.Lock()
	entries := orderedExecutionEntries(broker.entries)
	broker.entriesMu.Unlock()
	return brokerExecutionTranscript{
		SchemaVersion: SchemaVersion, ContractVersion: executionAttestationContractVersion,
		RunID: broker.manifest.RunID, ManifestDigest: broker.manifest.ManifestDigest,
		TargetID: broker.manifest.Target.ID, Mode: broker.manifest.Mode,
		PolicySnapshotDigest:  broker.manifest.PolicySnapshotDigest,
		BackendTopologyDigest: broker.manifest.Target.BackendTopologyDigest,
		StartedAt:             broker.startedAt, CompletedAt: completedAt.UTC(), Entries: entries,
	}
}

func readWorkerBrokerFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size < 2 || size > maxWorkerBrokerFrameBytes {
		return nil, fmt.Errorf("evaluation worker HTTP broker frame is outside its bound")
	}
	frame := make([]byte, int(size))
	if _, err := io.ReadFull(reader, frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func writeWorkerBrokerFrame(writer io.Writer, value workerBrokerResponse) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) < 2 || len(data) > maxWorkerBrokerFrameBytes {
		return fmt.Errorf("encode evaluation worker HTTP broker response")
	}
	var header [4]byte
	// The protocol limit above is 4 MiB, well within uint32's range.
	//nolint:gosec // Conversion is bounded by maxWorkerBrokerFrameBytes.
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	if _, writeErr := writer.Write(header[:]); writeErr != nil {
		return writeErr
	}
	_, writeErr := writer.Write(data)
	return writeErr
}

type workerBrokerSession struct {
	requestReader  *os.File
	requestWriter  *os.File
	responseReader *os.File
	responseWriter *os.File
	broker         *workerHTTPBroker
	done           chan error
}

func newWorkerBrokerSession(broker *workerHTTPBroker) (*workerBrokerSession, error) {
	requestReader, requestWriter, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("create evaluation worker broker request pipe: %w", err)
	}
	responseReader, responseWriter, err := os.Pipe()
	if err != nil {
		_ = requestReader.Close()
		_ = requestWriter.Close()
		return nil, fmt.Errorf("create evaluation worker broker response pipe: %w", err)
	}
	return &workerBrokerSession{
		requestReader: requestReader, requestWriter: requestWriter,
		responseReader: responseReader, responseWriter: responseWriter,
		broker: broker, done: make(chan error, 1),
	}, nil
}

func (session *workerBrokerSession) childFiles() []*os.File {
	return []*os.File{session.requestWriter, session.responseReader}
}

func (session *workerBrokerSession) start(ctx context.Context) {
	_ = session.requestWriter.Close()
	_ = session.responseReader.Close()
	go func() {
		err := session.broker.serve(ctx, session.requestReader, session.responseWriter)
		_ = session.responseWriter.Close()
		session.done <- err
	}()
}

func (session *workerBrokerSession) wait() error { return <-session.done }

func (session *workerBrokerSession) close() {
	_ = session.requestReader.Close()
	_ = session.requestWriter.Close()
	_ = session.responseReader.Close()
	_ = session.responseWriter.Close()
}
