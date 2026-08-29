package evaluationplane

import (
	"strings"
	"time"
)

func canonicalizeReportRun(run Run, report *Report, completedAt time.Time) {
	report.Run.ClientRequestID = run.ClientRequestID
	report.Run.Name = run.Name
	report.Run.Description = run.Description
	report.Run.CreatedAt = run.CreatedAt
	report.Run.StartedAt = copyTime(run.StartedAt)
	report.Run.CompletedAt = copyTime(&completedAt)
	report.Run.Status = StatusCompleted
	report.Run.Error = ""
	report.Run.Progress = RunProgress{
		Percent: 100, Completed: run.Progress.Total, Total: run.Progress.Total, Message: "Evaluation completed",
	}
}

func reportRunNameMatches(run Run, reported Run) bool {
	return reported.Name == run.Name || reported.Name == run.ID
}

func reportRunDescriptionMatches(run Run, reported Run) bool {
	legacy := "Evaluation suites: " + strings.Join(run.SuiteIDs, ", ")
	return reported.Description == run.Description || reported.Description == legacy
}

func reportRunClientRequestIDMatches(run Run, reported Run) bool {
	return reported.ClientRequestID == run.ClientRequestID || reported.ClientRequestID == ""
}

func reportRunTimesMatch(run Run, reported Run) bool {
	if sameOptionalTime(run.StartedAt, reported.StartedAt) && sameOptionalTime(run.CompletedAt, reported.CompletedAt) {
		return true
	}
	// Reports sealed before the server-owned identity contract used worker-clock
	// start/completion timestamps and report.run.name equal to the run UUID. Keep
	// those durable reports readable while bounding both timestamps to the
	// server-owned execution window.
	if reported.Name != run.ID || run.StartedAt == nil || run.CompletedAt == nil ||
		reported.StartedAt == nil || reported.CompletedAt == nil {
		return false
	}
	return !reported.StartedAt.Before(*run.StartedAt) &&
		!reported.CompletedAt.Before(*reported.StartedAt) &&
		!reported.CompletedAt.After(*run.CompletedAt)
}

func sameOptionalTime(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func copyTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
