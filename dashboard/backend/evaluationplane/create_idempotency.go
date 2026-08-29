package evaluationplane

import (
	"encoding/json"
	"fmt"
	"sort"
)

type canonicalCreateRequest struct {
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	SuiteIDs      []string      `json:"suite_ids"`
	TrackIDs      []TrackID     `json:"track_ids"`
	Mode          Mode          `json:"mode"`
	TargetID      string        `json:"target_id"`
	ChangeProfile ChangeProfile `json:"change_profile"`
	SampleLimit   int           `json:"sample_limit"`
	Concurrency   int           `json:"concurrency"`
	Seed          int64         `json:"seed"`
	BaselineRunID string        `json:"baseline_run_id,omitempty"`
}

func createRequestDigest(request CreateRunRequest) (string, error) {
	suiteIDs := append([]string(nil), request.SuiteIDs...)
	trackIDs := append([]TrackID(nil), request.TrackIDs...)
	sort.Strings(suiteIDs)
	sort.Slice(trackIDs, func(i, j int) bool { return trackIDs[i] < trackIDs[j] })
	encoded, err := json.Marshal(canonicalCreateRequest{
		Name: request.Name, Description: request.Description,
		SuiteIDs: suiteIDs, TrackIDs: trackIDs, Mode: request.Mode,
		TargetID: request.TargetID, ChangeProfile: request.ChangeProfile,
		SampleLimit: request.SampleLimit, Concurrency: request.Concurrency, Seed: request.Seed,
		BaselineRunID: request.BaselineRunID,
	})
	if err != nil {
		return "", fmt.Errorf("encode client request identity: %w", err)
	}
	return digestBytes(encoded), nil
}

func createRequestFromRun(run Run) CreateRunRequest {
	return CreateRunRequest{
		ClientRequestID: run.ClientRequestID,
		Name:            run.Name, Description: run.Description,
		SuiteIDs: append([]string(nil), run.SuiteIDs...), TrackIDs: append([]TrackID(nil), run.TrackIDs...),
		Mode: run.Mode, TargetID: run.TargetID, ChangeProfile: run.ChangeProfile,
		SampleLimit: run.SampleLimit, Concurrency: run.Concurrency, Seed: run.Seed,
		BaselineRunID: run.BaselineRunID,
	}
}

func (s *Service) resolveIndexedCreate(
	request CreateRunRequest,
	requestDigest string,
	entry clientRequestIndexEntry,
) (Run, error) {
	if entry.RequestDigest != requestDigest {
		return Run{}, fmt.Errorf("%w: client_request_id was already used for a different evaluation run", ErrConflict)
	}
	run, err := s.store.GetRun(entry.RunID)
	if err != nil {
		return Run{}, fmt.Errorf(
			"%w: client_request_id is quarantined because its indexed run is unavailable",
			ErrConflict,
		)
	}
	if run.ClientRequestID != request.ClientRequestID || !createRequestMatchesRun(request, run) {
		return Run{}, fmt.Errorf("%w: client_request_id index does not match its durable run", ErrConflict)
	}
	return run, nil
}

func createRequestMatchesRun(request CreateRunRequest, run Run) bool {
	return request.Name == run.Name && request.Description == run.Description &&
		request.Mode == run.Mode && request.TargetID == run.TargetID &&
		request.ChangeProfile == run.ChangeProfile && request.SampleLimit == run.SampleLimit &&
		request.Concurrency == run.Concurrency && request.Seed == run.Seed &&
		request.BaselineRunID == run.BaselineRunID &&
		sameStringSet(request.SuiteIDs, run.SuiteIDs) && sameTrackSet(request.TrackIDs, run.TrackIDs)
}
