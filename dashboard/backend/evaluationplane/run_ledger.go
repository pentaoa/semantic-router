package evaluationplane

import "fmt"

const quarantinedRunMessage = "Durable run status evidence is unreadable or invalid and has been quarantined."

// RunLedgerWarning is a public, path-safe description of durable run evidence
// that could not be projected into the readable run list. Detailed parse and
// filesystem diagnostics remain in the server log.
type RunLedgerWarning struct {
	Code         string `json:"code"`
	RunID        string `json:"run_id"`
	EvidenceFile string `json:"evidence_file"`
	Message      string `json:"message"`
}

// RunLedger is an atomic view of readable runs and any quarantined durable
// entries. Consumers must not use Runs for baseline selection or comparison
// conclusions unless LedgerComplete is true.
type RunLedger struct {
	SchemaVersion  string             `json:"schema_version"`
	Runs           []Run              `json:"runs"`
	LedgerComplete bool               `json:"ledger_complete"`
	Warnings       []RunLedgerWarning `json:"warnings"`
}

func publicRunLedgerWarning(warning runListWarning) RunLedgerWarning {
	return RunLedgerWarning{
		Code:         warning.Code,
		RunID:        warning.RunID,
		EvidenceFile: runFileName,
		Message:      quarantinedRunMessage,
	}
}

func (s *Service) ListRunLedger() (RunLedger, error) {
	return s.store.ListRunLedger()
}

// RequireCompleteRunLedger refreshes the durable ledger before a decision that
// depends on complete run history. It deliberately returns a conflict rather
// than allowing a partial list to support a scientific comparison.
func (s *Service) RequireCompleteRunLedger() error {
	ledger, err := s.store.ListRunLedger()
	if err != nil {
		return err
	}
	if !ledger.LedgerComplete {
		return fmt.Errorf(
			"%w: evaluation run ledger is incomplete (%d quarantined run bundle(s)); repair the durable evidence before selecting a baseline or comparing runs",
			ErrConflict,
			len(ledger.Warnings),
		)
	}
	return nil
}
