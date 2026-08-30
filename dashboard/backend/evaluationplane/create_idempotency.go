package evaluationplane

import (
	"fmt"
	"reflect"
)

func (s *Service) resolveExistingCreate(
	request CreateRunRequest,
	run Run,
) (Run, error) {
	if _, _, err := s.readDurableManifest(run.ID); err != nil {
		return Run{}, fmt.Errorf("%w: existing client_request_id bundle is invalid", ErrConflict)
	}
	if run.ID != request.ClientRequestID ||
		run.ClientRequestID != request.ClientRequestID || !createRequestMatchesRun(request, run) {
		return Run{}, fmt.Errorf("%w: client_request_id was already used for a different evaluation run", ErrConflict)
	}
	return run, nil
}

func createRequestMatchesRun(request CreateRunRequest, run Run) bool {
	return request.Name == run.Name && request.Description == run.Description &&
		request.Mode == run.Mode && request.TargetID == run.TargetID &&
		request.ChangeProfile == run.ChangeProfile && request.SampleLimit == run.SampleLimit &&
		request.Concurrency == run.Concurrency && request.Seed == run.Seed &&
		reflect.DeepEqual(request.CapacitySLO, run.CapacitySLO) &&
		reflect.DeepEqual(request.CapacityLoadProtocol, run.CapacityLoadProtocol) &&
		request.BaselineRunID == run.BaselineRunID &&
		reflect.DeepEqual(request.SuiteIDs, run.SuiteIDs) && reflect.DeepEqual(request.TrackIDs, run.TrackIDs)
}
