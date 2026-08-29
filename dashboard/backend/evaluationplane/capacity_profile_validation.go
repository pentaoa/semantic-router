package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
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

func validateCapacityProfileArtifact(runDir string, manifest RunManifest, report Report) error {
	artifact, present := findArtifactByName(report, capacityProfileArtifactName)
	if !present {
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
	return nil
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
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil || object == nil {
		return fmt.Errorf("slo must be null or an object")
	}
	return nil
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
