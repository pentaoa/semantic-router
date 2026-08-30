package evaluationplane

import (
	"fmt"
	"strings"
	"testing"
)

func TestResolvedLineageAcceptsOnlyCurrentIdentityWrapper(t *testing.T) {
	resolved := fmt.Sprintf(
		`{"schema_version":%q,"manifest_digest":%q}`,
		SchemaVersion,
		"sha256:"+strings.Repeat("a", 64),
	)
	current := fmt.Sprintf(
		`{"resolved_snapshot":%s,"normalized_suite_identities":{}}`,
		resolved,
	)
	if _, err := decodeLineageDocument([]byte(current)); err != nil {
		t.Fatalf("current lineage identity wrapper rejected: %v", err)
	}
	retiredAlias := fmt.Sprintf(
		`{"resolved_snapshot":%s,"normalized_suite_aliases":{}}`,
		resolved,
	)
	if _, err := decodeLineageDocument([]byte(retiredAlias)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("retired lineage alias wrapper error=%v", err)
	}
}

func TestLineageExecutorsMustExactlyMatchManifest(t *testing.T) {
	manifest := RunManifest{
		Mode: ModeLive, SuiteIDs: []string{"live-mom-core"},
		SuiteExecutors: map[string]string{"live-mom-core": "live-runtime.v1"},
		TrackIDs:       []TrackID{"routing"},
	}
	valid := []lineageExecutor{{
		SchemaVersion: SchemaVersion, TrackID: "routing",
		ExecutorID: "live-runtime.v1", Mode: ModeLive,
	}}
	if err := validateLineageExecutors(manifest, valid); err != nil {
		t.Fatalf("valid lineage executor rejected: %v", err)
	}
	for _, mutate := range []func([]lineageExecutor) []lineageExecutor{
		func([]lineageExecutor) []lineageExecutor { return nil },
		func(values []lineageExecutor) []lineageExecutor { values[0].ExecutorID = "other.v1"; return values },
		func(values []lineageExecutor) []lineageExecutor { values[0].TrackID = "capacity"; return values },
		func(values []lineageExecutor) []lineageExecutor { values[0].Mode = ModeReplay; return values },
	} {
		candidate := append([]lineageExecutor(nil), valid...)
		if err := validateLineageExecutors(manifest, mutate(candidate)); err == nil {
			t.Fatal("lineage executor drift was accepted")
		}
	}
}
