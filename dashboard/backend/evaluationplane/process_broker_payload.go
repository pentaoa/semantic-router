package evaluationplane

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	maxBrokerMessages           = 64
	maxBrokerMessageBytes       = 2 * 1024 * 1024
	maxBrokerTextBytes          = 64 * 1024
	maxBrokerImageBytes         = 2 * 1024 * 1024
	maxBrokerContentParts       = 32
	maxBrokerModelBytes         = 256
	workerBrokerMaxOutputTokens = 256
)

type brokerChatPayload struct {
	Model       string          `json:"model"`
	Messages    []brokerMessage `json:"messages"`
	Temperature *float64        `json:"temperature"`
	Stream      *bool           `json:"stream"`
}

type brokerPublishedChatPayload struct {
	Model       string          `json:"model"`
	Messages    []brokerMessage `json:"messages"`
	Temperature float64         `json:"temperature"`
	Stream      bool            `json:"stream"`
	MaxTokens   int             `json:"max_tokens"`
}

type brokerRouterPayload struct {
	Model              string          `json:"model"`
	Messages           []brokerMessage `json:"messages"`
	EvaluateAllSignals *bool           `json:"evaluate_all_signals"`
}

type brokerMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Name       *string         `json:"name,omitempty"`
	ToolCallID *string         `json:"tool_call_id,omitempty"`
}

type brokerContentPartKind struct {
	Type string `json:"type"`
}

type brokerTextPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type brokerImagePart struct {
	Type     string         `json:"type"`
	ImageURL brokerImageURL `json:"image_url"`
}

type brokerImageURL struct {
	URL    string  `json:"url"`
	Detail *string `json:"detail,omitempty"`
}

func (broker *workerHTTPBroker) validatedPayload(operation string, raw json.RawMessage) ([]byte, error) {
	switch operation {
	case workerBrokerListModels, workerBrokerAgentTaskLedger, workerBrokerFaultRecoveryLedger, workerBrokerHardPolicyLedger, workerBrokerProductionExperimentLedger:
		if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, fmt.Errorf("models request payload must be null")
		}
		return nil, nil
	case workerBrokerRoutedChatCompletion, workerBrokerArmChatCompletion:
		var payload brokerChatPayload
		if err := decodeBrokerPayload(raw, &payload); err != nil {
			return nil, err
		}
		if payload.Temperature == nil || *payload.Temperature != 0 || payload.Stream == nil || *payload.Stream {
			return nil, fmt.Errorf("chat generation policy is invalid")
		}
		if err := broker.validateChatModel(operation, payload.Model); err != nil {
			return nil, err
		}
		if err := validateBrokerMessages(payload.Messages); err != nil {
			return nil, err
		}
		return json.Marshal(brokerPublishedChatPayload{
			Model: payload.Model, Messages: payload.Messages,
			Temperature: 0, Stream: false, MaxTokens: workerBrokerMaxOutputTokens,
		})
	case workerBrokerRouterEvaluate:
		var payload brokerRouterPayload
		if err := decodeBrokerPayload(raw, &payload); err != nil {
			return nil, err
		}
		if payload.EvaluateAllSignals == nil || !*payload.EvaluateAllSignals {
			return nil, fmt.Errorf("router trace policy is invalid")
		}
		if err := broker.validateRoutedModel(payload.Model); err != nil {
			return nil, err
		}
		if err := validateBrokerMessages(payload.Messages); err != nil {
			return nil, err
		}
		return json.Marshal(payload)
	default:
		return nil, fmt.Errorf("unknown broker operation")
	}
}

func decodeBrokerPayload(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode broker operation payload: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	return nil
}

func (broker *workerHTTPBroker) validateChatModel(operation, model string) error {
	if err := validateBrokerModelIdentity(model); err != nil {
		return err
	}
	if broker.manifest.Target.Mixture == nil {
		return fmt.Errorf("broker target does not freeze a mixture")
	}
	switch operation {
	case workerBrokerRoutedChatCompletion:
		return broker.validateRoutedModel(model)
	case workerBrokerArmChatCompletion:
		if model == broker.manifest.Target.Mixture.EntrypointModel ||
			containsString(broker.manifest.Target.Mixture.Aliases, model) {
			return fmt.Errorf("broker arm request cannot use a virtual mixture entrypoint")
		}
		for _, arm := range broker.manifest.Target.Mixture.ModelArms {
			if model == arm.Model {
				return nil
			}
		}
		return fmt.Errorf("broker model is not a frozen mixture arm")
	default:
		return fmt.Errorf("broker chat operation is invalid")
	}
}

func (broker *workerHTTPBroker) validateRoutedModel(model string) error {
	if err := validateBrokerModelIdentity(model); err != nil {
		return err
	}
	if broker.manifest.Target.Mixture == nil || model != broker.manifest.Target.Mixture.EntrypointModel {
		return fmt.Errorf("broker model is not the frozen mixture entrypoint")
	}
	broker.modelsMu.RLock()
	_, allowed := broker.models[model]
	broker.modelsMu.RUnlock()
	if !allowed {
		return fmt.Errorf("frozen mixture entrypoint was not discovered as selectable")
	}
	return nil
}

func validateBrokerModelIdentity(model string) error {
	if model == "" || model != strings.TrimSpace(model) || len(model) > maxBrokerModelBytes || strings.ContainsAny(model, "\x00\r\n") {
		return fmt.Errorf("broker model identity is invalid")
	}
	return nil
}

func validateBrokerMessages(messages []brokerMessage) error {
	if len(messages) == 0 || len(messages) > maxBrokerMessages {
		return fmt.Errorf("broker message count is invalid")
	}
	total := 0
	for _, message := range messages {
		total += len(message.Content)
		if total > maxBrokerMessageBytes {
			return fmt.Errorf("broker messages exceed their byte budget")
		}
		if err := validateBrokerMessage(message); err != nil {
			return err
		}
	}
	return nil
}

func validateBrokerMessage(message brokerMessage) error {
	switch message.Role {
	case "system", "user", "assistant", "tool":
	default:
		return fmt.Errorf("broker message role is invalid")
	}
	for _, optional := range []*string{message.Name, message.ToolCallID} {
		if optional != nil && (*optional == "" || *optional != strings.TrimSpace(*optional) || len(*optional) > 128) {
			return fmt.Errorf("broker message identity is invalid")
		}
	}
	var text string
	if err := json.Unmarshal(message.Content, &text); err == nil {
		if len(text) > maxBrokerTextBytes {
			return fmt.Errorf("broker message text exceeds its byte budget")
		}
		return nil
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(message.Content, &parts); err != nil || len(parts) == 0 || len(parts) > maxBrokerContentParts {
		return fmt.Errorf("broker message content is invalid")
	}
	for _, raw := range parts {
		var kind brokerContentPartKind
		if err := decodeBrokerPayload(raw, &kind); err != nil {
			// The discriminator probe intentionally sees the remaining fields.
			var probe map[string]json.RawMessage
			if unmarshalErr := json.Unmarshal(raw, &probe); unmarshalErr != nil {
				return fmt.Errorf("broker message part is invalid")
			}
			if typeRaw, ok := probe["type"]; !ok || json.Unmarshal(typeRaw, &kind.Type) != nil {
				return fmt.Errorf("broker message part type is invalid")
			}
		}
		switch kind.Type {
		case "text":
			var part brokerTextPart
			if err := decodeBrokerPayload(raw, &part); err != nil || part.Type != "text" || len(part.Text) > maxBrokerTextBytes {
				return fmt.Errorf("broker text part is invalid")
			}
		case "image_url":
			var part brokerImagePart
			if err := decodeBrokerPayload(raw, &part); err != nil || part.Type != "image_url" {
				return fmt.Errorf("broker image part is invalid")
			}
			if err := validateBrokerImageURL(part.ImageURL); err != nil {
				return err
			}
		default:
			return fmt.Errorf("broker message part type is unsupported")
		}
	}
	return nil
}

func validateBrokerImageURL(image brokerImageURL) error {
	if image.Detail != nil && *image.Detail != "auto" && *image.Detail != "low" && *image.Detail != "high" {
		return fmt.Errorf("broker image detail is invalid")
	}
	prefixes := []string{
		"data:image/png;base64,",
		"data:image/jpeg;base64,",
		"data:image/webp;base64,",
		"data:image/gif;base64,",
	}
	encoded := ""
	for _, prefix := range prefixes {
		if strings.HasPrefix(image.URL, prefix) {
			encoded = strings.TrimPrefix(image.URL, prefix)
			break
		}
	}
	if encoded == "" || base64.StdEncoding.DecodedLen(len(encoded)) > maxBrokerImageBytes {
		return fmt.Errorf("broker image must be a bounded inline data URI")
	}
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(encoded)))
	if _, err := base64.StdEncoding.Strict().Decode(decoded, []byte(encoded)); err != nil {
		return fmt.Errorf("broker image data URI is invalid")
	}
	return nil
}

func (broker *workerHTTPBroker) captureSelectableModels(payload map[string]any) {
	rows, ok := payload["data"].([]any)
	if !ok {
		broker.modelsMu.Lock()
		broker.models = make(map[string]string)
		broker.modelsValid = false
		broker.modelsMu.Unlock()
		return
	}
	discovered := make(map[string]string)
	frozenAliases := make(map[string]struct{})
	if broker.manifest.Target.Mixture != nil {
		for _, alias := range broker.manifest.Target.Mixture.Aliases {
			frozenAliases[alias] = struct{}{}
		}
	}
	seenFrozenRows := make(map[string]struct{}, len(frozenAliases))
	valid := true
	for _, value := range rows {
		row, ok := value.(map[string]any)
		if !ok {
			continue
		}
		model, ok := row["id"].(string)
		if !ok || model == "" || len(model) > maxBrokerModelBytes {
			continue
		}
		if _, frozen := frozenAliases[model]; frozen {
			if _, duplicate := seenFrozenRows[model]; duplicate {
				valid = false
			}
			seenFrozenRows[model] = struct{}{}
		}
		routing, ok := row["routing"].(map[string]any)
		if !ok || routing["resolution"] != "virtual" || routing["selectable"] != true {
			continue
		}
		recipe, ok := routing["recipe"].(string)
		if !ok || recipe == "" {
			continue
		}
		discovered[model] = recipe
	}
	broker.modelsMu.Lock()
	broker.models = discovered
	broker.modelsValid = valid
	broker.modelsMu.Unlock()
}
