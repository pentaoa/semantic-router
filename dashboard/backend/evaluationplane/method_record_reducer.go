package evaluationplane

type methodRecordAttestation struct {
	Robustness robustnessMethodAttestation
	AgentTask  agentTaskMethodAttestation
	Recovery   recoveryMethodAttestation
	Production productionMethodAttestation
	HardPolicy hardPolicyMethodAttestation
}

type methodRecordReducer struct {
	records []executionRecordEvidence
}

func newMethodRecordReducer() *methodRecordReducer {
	return &methodRecordReducer{}
}

func (reducer *methodRecordReducer) observe(record executionRecordEvidence) error {
	reducer.records = append(reducer.records, record)
	return nil
}

func (reducer *methodRecordReducer) finalize() (methodRecordAttestation, error) {
	robustness, err := reduceRobustnessMethod(reducer.records)
	if err != nil {
		return methodRecordAttestation{}, err
	}
	agentTask, err := reduceAgentTaskMethod(reducer.records)
	if err != nil {
		return methodRecordAttestation{}, err
	}
	recovery, err := reduceRecoveryMethod(reducer.records)
	if err != nil {
		return methodRecordAttestation{}, err
	}
	production, err := reduceProductionMethod(reducer.records)
	if err != nil {
		return methodRecordAttestation{}, err
	}
	hardPolicy, err := reduceHardPolicyMethod(reducer.records)
	if err != nil {
		return methodRecordAttestation{}, err
	}
	return methodRecordAttestation{
		Robustness: robustness, AgentTask: agentTask, Recovery: recovery,
		Production: production, HardPolicy: hardPolicy,
	}, nil
}
