package evaluationplane

import "fmt"

const (
	defaultRunPageLimit = 50
	maxRunPageLimit     = 200
	maxLedgerWarnings   = 100
)

const quarantinedRunMessage = "Durable run status evidence is unreadable or invalid and has been quarantined."

// RunLedgerWarning is a public, path-safe description of durable run evidence
// that could not be projected into the readable run list. Detailed parse and
// filesystem diagnostics remain in the server log.
type RunLedgerWarning struct {
	Code         string `json:"code"`
	EvidenceID   string `json:"evidence_id"`
	EvidenceFile string `json:"evidence_file"`
	Message      string `json:"message"`
}

// RunLedger is an atomic view of readable runs and any quarantined durable
// entries. Consumers must not use Runs for baseline selection or comparison
// conclusions unless LedgerComplete is true.
type RunLedger struct {
	SchemaVersion  string             `json:"schema_version"`
	Runs           []Run              `json:"runs"`
	NextCursor     string             `json:"next_cursor,omitempty"`
	TotalRuns      int                `json:"total_runs"`
	LedgerComplete bool               `json:"ledger_complete"`
	WarningCount   int                `json:"warning_count"`
	Warnings       []RunLedgerWarning `json:"warnings"`
}

type RunListQuery struct {
	Limit  int
	Cursor string
}

func publicRunLedgerWarning(warning runListWarning) RunLedgerWarning {
	return RunLedgerWarning{
		Code:         warning.Code,
		EvidenceID:   warning.EvidenceID,
		EvidenceFile: runFileName,
		Message:      quarantinedRunMessage,
	}
}

func (s *Service) ListRunLedger() (RunLedger, error) {
	return s.store.listRunLedger(RunListQuery{Limit: defaultRunPageLimit})
}

func (s *Service) ListRunLedgerPage(query RunListQuery) (RunLedger, error) {
	if query.Limit == 0 {
		query.Limit = defaultRunPageLimit
	}
	if query.Limit < 1 || query.Limit > maxRunPageLimit {
		return RunLedger{}, fmt.Errorf("%w: run list limit must be between 1 and %d", ErrInvalid, maxRunPageLimit)
	}
	return s.store.listRunLedger(query)
}

// RequireCompleteRunLedger refreshes the durable ledger before a decision that
// depends on complete run history. It deliberately returns a conflict rather
// than allowing a partial list to support a scientific comparison.
func (s *Service) RequireCompleteRunLedger() error {
	// Scientific decisions re-derive the projection from canonical evidence so
	// out-of-band corruption cannot be hidden by a previously healthy snapshot.
	// Polling list requests use the maintained index and remain O(page).
	if err := s.store.refreshRunIndex(); err != nil {
		return err
	}
	ledger, err := s.store.listRunLedger(RunListQuery{Limit: 1})
	if err != nil {
		return err
	}
	if !ledger.LedgerComplete {
		return fmt.Errorf(
			"%w: evaluation run ledger is incomplete (%d quarantined run bundle(s)); repair the durable evidence before selecting a baseline or comparing runs",
			ErrConflict,
			ledger.WarningCount,
		)
	}
	return nil
}
