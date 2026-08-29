package evaluationplane

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateCapacityProfileArtifactAcceptsStrictProfile(t *testing.T) {
	runDir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(runDir, capacityProfileArtifactName),
		capacityProfileJSON(capacityLevelJSON(1)),
		0o600,
	); err != nil {
		t.Fatalf("write capacity profile: %v", err)
	}
	if err := validateCapacityProfileArtifact(runDir, capacityManifest(), capacityReport()); err != nil {
		t.Fatalf("validateCapacityProfileArtifact: %v", err)
	}
}

func TestValidateCapacityProfileArtifactRejectsMalformedEvidence(t *testing.T) {
	validLevel := capacityLevelJSON(1)
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "malformed json", raw: []byte("{not-json\n")},
		{name: "null levels", raw: []byte(`{"schema_version":"evaluation.v1","kind":"bounded-concurrency-sweep","levels":null,"slo":null}`)},
		{name: "NaN", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"throughput_rps":1.5`, `"throughput_rps":NaN`, 1))},
		{name: "duplicate concurrency", raw: capacityProfileJSON(validLevel + "," + capacityLevelJSON(1))},
		{name: "missing required field", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"requests":2,`, "", 1))},
		{name: "negative count", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"errors":0`, `"errors":-1`, 1))},
		{name: "inconsistent outcome counts", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"successes":2`, `"successes":1`, 1))},
		{name: "non finite exponent", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"elapsed_seconds":2.0`, `"elapsed_seconds":1e1000`, 1))},
		{name: "unknown field", raw: []byte(strings.Replace(string(capacityProfileJSON(validLevel)), `"runtime_cost_usd":0.01`, `"runtime_cost_usd":0.01,"forged":true`, 1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(runDir, capacityProfileArtifactName), test.raw, 0o600); err != nil {
				t.Fatalf("write capacity profile: %v", err)
			}
			if err := validateCapacityProfileArtifact(runDir, capacityManifest(), capacityReport()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("validateCapacityProfileArtifact error=%v, want ErrInvalid", err)
			}
		})
	}
}

func capacityManifest() RunManifest {
	return RunManifest{Mode: ModeLive, TrackIDs: []TrackID{"capacity"}}
}

func capacityReport() Report {
	return Report{Artifacts: []Artifact{{
		Name: capacityProfileArtifactName, URI: capacityProfileArtifactName, MediaType: "application/json",
	}}}
}

func capacityProfileJSON(levels string) []byte {
	return []byte(fmt.Sprintf(
		`{"schema_version":"%s","kind":"bounded-concurrency-sweep","levels":[%s],"slo":null}`,
		SchemaVersion,
		levels,
	))
}

func capacityLevelJSON(concurrency int) string {
	return fmt.Sprintf(`{
		"concurrency":%d,
		"requests":2,
		"successes":2,
		"errors":0,
		"elapsed_seconds":2.0,
		"throughput_rps":1.5,
		"latency_p50_ms":10.0,
		"latency_p95_ms":20.0,
		"latency_p99_ms":30.0,
		"input_tokens":100,
		"output_tokens":20,
		"runtime_cost_usd":0.01
	}`, concurrency)
}
