package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"sort"
)

const capacityProfileArtifactName = "capacity-profile.json"

type capacityProfileEvidence struct {
	SchemaVersion string                 `json:"schema_version"`
	Kind          string                 `json:"kind"`
	Levels        []capacityProfileLevel `json:"levels"`
	SLO           json.RawMessage        `json:"slo"`
}

type capacityProfileLevel struct {
	Concurrency  *int64          `json:"concurrency"`
	Requests     *int64          `json:"requests"`
	Successes    *int64          `json:"successes"`
	Errors       *int64          `json:"errors"`
	Elapsed      *float64        `json:"elapsed_seconds"`
	Throughput   *float64        `json:"throughput_rps"`
	LatencyP50   json.RawMessage `json:"latency_p50_ms"`
	LatencyP95   json.RawMessage `json:"latency_p95_ms"`
	LatencyP99   json.RawMessage `json:"latency_p99_ms"`
	InputTokens  *int64          `json:"input_tokens"`
	OutputTokens *int64          `json:"output_tokens"`
	RuntimeCost  *float64        `json:"runtime_cost_usd"`
}

func validateCapacityProfileArtifact(
	runDir string,
	manifest RunManifest,
	report Report,
	records recordAttestation,
) error {
	artifact, present := findArtifactByName(report, capacityProfileArtifactName)
	if !present {
		if manifest.Mode == ModeLive && containsTrack(manifest.TrackIDs, "capacity") {
			return fmt.Errorf("%w: live capacity evidence requires a capacity profile", ErrInvalid)
		}
		return nil
	}
	if manifest.Mode != ModeLive || !containsTrack(manifest.TrackIDs, "capacity") {
		return fmt.Errorf("%w: capacity profile is valid only for a live capacity run", ErrInvalid)
	}
	if artifact.MediaType != "application/json" {
		return fmt.Errorf("%w: capacity profile media_type must be application/json", ErrInvalid)
	}
	var profile capacityProfileEvidence
	if err := decodeStrictEvidence(filepath.Join(runDir, capacityProfileArtifactName), &profile); err != nil {
		return fmt.Errorf("%w: invalid capacity profile: %w", ErrInvalid, err)
	}
	if err := validateCapacityProfile(profile); err != nil {
		return fmt.Errorf("%w: invalid capacity profile: %w", ErrInvalid, err)
	}
	if err := validateCapacityProfileAgainstRecords(runDir, profile, records); err != nil {
		return fmt.Errorf("%w: capacity profile does not match validated records: %w", ErrInvalid, err)
	}
	return nil
}

type capacityRecordLevel struct {
	Concurrency  int64
	Requests     int64
	Successes    int64
	Elapsed      float64
	Throughput   float64
	Latencies    []float64
	InputTokens  int64
	OutputTokens int64
	RuntimeCost  float64
}

func validateCapacityProfileAgainstRecords(
	runDir string,
	profile capacityProfileEvidence,
	records recordAttestation,
) error {
	if !records.validated {
		return fmt.Errorf("records attestation is unavailable")
	}
	levels := make(map[int64]*capacityRecordLevel)
	capacityRows := 0
	err := scanEvidenceJSONLines(
		filepath.Join(runDir, "records.jsonl"),
		maxWorkerArtifactBytes,
		maxRecordLineBytes,
		maxRecordsPerRun,
		func(line []byte, lineNumber int) error {
			var record executionRecordEvidence
			if err := decodeStrictJSONLine(line, &record); err != nil {
				return fmt.Errorf("records.jsonl line %d is invalid: %w", lineNumber, err)
			}
			if record.TrackID != "capacity" {
				return nil
			}
			capacityRows++
			if record.Concurrency == nil {
				return nil
			}
			level := levels[*record.Concurrency]
			if level == nil {
				level = &capacityRecordLevel{Concurrency: *record.Concurrency}
				levels[*record.Concurrency] = level
			}
			level.Requests++
			if record.Success != nil && *record.Success {
				level.Successes++
			}
			if record.LoadElapsedSeconds != nil && *record.LoadElapsedSeconds > level.Elapsed {
				level.Elapsed = *record.LoadElapsedSeconds
			}
			if record.ThroughputRPS != nil && *record.ThroughputRPS > level.Throughput {
				level.Throughput = *record.ThroughputRPS
			}
			if record.LatencyMS != nil {
				level.Latencies = append(level.Latencies, *record.LatencyMS)
			}
			if err := addCapacityCount(&level.InputTokens, record.InputTokens); err != nil {
				return fmt.Errorf("records.jsonl line %d input_tokens: %w", lineNumber, err)
			}
			if err := addCapacityCount(&level.OutputTokens, record.OutputTokens); err != nil {
				return fmt.Errorf("records.jsonl line %d output_tokens: %w", lineNumber, err)
			}
			if record.RuntimeCost != nil {
				level.RuntimeCost += *record.RuntimeCost
				if !finiteFloat(level.RuntimeCost) {
					return fmt.Errorf("records.jsonl line %d runtime_cost aggregate is not finite", lineNumber)
				}
			}
			return nil
		},
	)
	if err != nil {
		return err
	}
	expectedCapacityRows := records.ByTrack["capacity"].total()
	if capacityRows != expectedCapacityRows {
		return fmt.Errorf("capacity record count changed after records attestation")
	}
	concurrencyLevels := make([]int64, 0, len(levels))
	for concurrency := range levels {
		concurrencyLevels = append(concurrencyLevels, concurrency)
	}
	sort.Slice(concurrencyLevels, func(left, right int) bool {
		return concurrencyLevels[left] < concurrencyLevels[right]
	})
	if len(profile.Levels) != len(concurrencyLevels) {
		return fmt.Errorf("level set differs from capacity records")
	}
	for index, concurrency := range concurrencyLevels {
		if err := validateCapacityLevelAgainstRecords(profile.Levels[index], *levels[concurrency]); err != nil {
			return fmt.Errorf("level %d: %w", index+1, err)
		}
	}
	return nil
}

func addCapacityCount(total *int64, value *int64) error {
	if value == nil {
		return nil
	}
	if *value < 0 || *total > math.MaxInt64-*value {
		return fmt.Errorf("aggregate overflows its non-negative integer budget")
	}
	*total += *value
	return nil
}

func validateCapacityLevelAgainstRecords(actual capacityProfileLevel, expected capacityRecordLevel) error {
	if actual.Concurrency == nil || actual.Requests == nil || actual.Successes == nil || actual.Errors == nil ||
		actual.Elapsed == nil || actual.Throughput == nil || actual.InputTokens == nil ||
		actual.OutputTokens == nil || actual.RuntimeCost == nil {
		return fmt.Errorf("required profile values are unavailable")
	}
	if *actual.Concurrency != expected.Concurrency || *actual.Requests != expected.Requests ||
		*actual.Successes != expected.Successes || *actual.Errors != expected.Requests-expected.Successes ||
		*actual.Elapsed != expected.Elapsed || *actual.Throughput != expected.Throughput ||
		*actual.InputTokens != expected.InputTokens || *actual.OutputTokens != expected.OutputTokens ||
		*actual.RuntimeCost != expected.RuntimeCost {
		return fmt.Errorf("counts, load, tokens, or cost differ from capacity records")
	}
	for _, quantile := range []struct {
		name string
		raw  json.RawMessage
		q    float64
	}{
		{name: "latency_p50_ms", raw: actual.LatencyP50, q: 0.50},
		{name: "latency_p95_ms", raw: actual.LatencyP95, q: 0.95},
		{name: "latency_p99_ms", raw: actual.LatencyP99, q: 0.99},
	} {
		value, present, err := decodeCapacityLatency(quantile.name, quantile.raw)
		if err != nil {
			return err
		}
		expectedValue, expectedPresent := capacityPercentile(expected.Latencies, quantile.q)
		if present != expectedPresent || (present && value != expectedValue) {
			return fmt.Errorf("%s differs from capacity records", quantile.name)
		}
	}
	return nil
}

func capacityPercentile(values []float64, quantile float64) (float64, bool) {
	if len(values) == 0 {
		return 0, false
	}
	ordered := append([]float64(nil), values...)
	sort.Float64s(ordered)
	if len(ordered) == 1 {
		return ordered[0], true
	}
	position := float64(len(ordered)-1) * quantile
	lower := int(position)
	upper := lower + 1
	if upper >= len(ordered) {
		upper = len(ordered) - 1
	}
	fraction := position - float64(lower)
	return ordered[lower] + (ordered[upper]-ordered[lower])*fraction, true
}

func validateCapacityProfile(profile capacityProfileEvidence) error {
	if profile.SchemaVersion != SchemaVersion || profile.Kind != "bounded-concurrency-sweep" {
		return fmt.Errorf("schema_version or kind is invalid")
	}
	if profile.Levels == nil {
		return fmt.Errorf("levels must be an array")
	}
	if err := validateCapacitySLO(profile.SLO); err != nil {
		return err
	}
	seenConcurrency := make(map[int64]struct{}, len(profile.Levels))
	for index, level := range profile.Levels {
		if err := validateCapacityLevel(level); err != nil {
			return fmt.Errorf("level %d: %w", index+1, err)
		}
		if _, duplicate := seenConcurrency[*level.Concurrency]; duplicate {
			return fmt.Errorf("level %d duplicates concurrency %d", index+1, *level.Concurrency)
		}
		seenConcurrency[*level.Concurrency] = struct{}{}
	}
	return nil
}

func validateCapacitySLO(raw json.RawMessage) error {
	if len(raw) == 0 {
		return fmt.Errorf("slo is required")
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	return fmt.Errorf("slo must be null in the evaluation.v1 capacity contract")
}

func validateCapacityLevel(level capacityProfileLevel) error {
	if level.Concurrency == nil || level.Requests == nil || level.Successes == nil || level.Errors == nil ||
		level.Elapsed == nil || level.Throughput == nil || level.InputTokens == nil ||
		level.OutputTokens == nil || level.RuntimeCost == nil {
		return fmt.Errorf("required field is missing or null")
	}
	if *level.Concurrency <= 0 || *level.Requests <= 0 || *level.Successes < 0 || *level.Errors < 0 ||
		*level.InputTokens < 0 || *level.OutputTokens < 0 {
		return fmt.Errorf("concurrency and requests must be positive and counts must be non-negative")
	}
	if *level.Successes > *level.Requests || *level.Errors > *level.Requests ||
		*level.Successes != *level.Requests-*level.Errors {
		return fmt.Errorf("successes plus errors must equal requests")
	}
	for name, value := range map[string]float64{
		"elapsed_seconds":  *level.Elapsed,
		"throughput_rps":   *level.Throughput,
		"runtime_cost_usd": *level.RuntimeCost,
	} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return fmt.Errorf("%s must be finite and non-negative", name)
		}
	}
	latencyP50, p50Present, err := decodeCapacityLatency("latency_p50_ms", level.LatencyP50)
	if err != nil {
		return err
	}
	latencyP95, p95Present, err := decodeCapacityLatency("latency_p95_ms", level.LatencyP95)
	if err != nil {
		return err
	}
	latencyP99, p99Present, err := decodeCapacityLatency("latency_p99_ms", level.LatencyP99)
	if err != nil {
		return err
	}
	if p50Present != p95Present || p50Present != p99Present {
		return fmt.Errorf("latency percentiles must be all numeric or all null")
	}
	if p50Present && (latencyP50 > latencyP95 || latencyP95 > latencyP99) {
		return fmt.Errorf("latency percentiles must be monotonic")
	}
	return nil
}

func decodeCapacityLatency(name string, raw json.RawMessage) (float64, bool, error) {
	if len(raw) == 0 {
		return 0, false, fmt.Errorf("%s is required", name)
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return 0, false, nil
	}
	var value float64
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if err := decoder.Decode(&value); err != nil {
		return 0, false, fmt.Errorf("%s must be numeric or null", name)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return 0, false, err
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false, fmt.Errorf("%s must be finite and non-negative", name)
	}
	return value, true, nil
}
