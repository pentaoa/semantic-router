package evaluationplane

func (s *Service) RunLifecycle(actor Actor, runID string) (RunLifecycleView, error) {
	return s.store.RunLifecycle(actor, runID)
}

func (s *Service) UpdateRunLifecycle(
	actor Actor,
	runID string,
	request UpdateRunLifecycleRequest,
) (RunLifecycleView, error) {
	return s.store.UpdateRunLifecycle(actor, runID, request)
}

func (s *Service) LifecycleUsage(actor Actor) (LifecycleUsageReport, error) {
	return s.store.Usage(actor)
}
