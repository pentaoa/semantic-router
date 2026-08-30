package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/vllm-project/semantic-router/dashboard/backend/evaluationplane"
)

func (h *EvaluationPlaneHandler) events(w http.ResponseWriter, r *http.Request, runID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeEvaluationError(w, evaluationplane.ErrConflict)
		return
	}
	live, unsubscribe, subscribeErr := h.service.Subscribe(runID)
	if subscribeErr != nil {
		writeEvaluationError(w, subscribeErr)
		return
	}
	defer unsubscribe()
	replay, replayErr := h.service.EventsAfter(runID, r.Header.Get("Last-Event-ID"))
	if replayErr != nil {
		writeEvaluationError(w, replayErr)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	lastID := decodeEventID(r.Header.Get("Last-Event-ID"))
	terminalReplayed := false
	for _, event := range replay {
		if _, writeErr := w.Write(encodeSSE(event)); writeErr != nil {
			return
		}
		lastID = decodeEventID(event.ID)
		terminalReplayed = terminalReplayed || terminalEventType(event.Type)
	}
	flusher.Flush()
	if terminalReplayed {
		return
	}
	// A terminal transition can commit after the first replay snapshot but
	// before this status read. Re-read strictly after the last emitted ID so
	// that window closes with the derived terminal event instead of silently
	// ending the stream. A client already at the terminal ID receives no
	// duplicate and the stream closes immediately.
	run, err := h.service.GetRun(runID)
	if err != nil {
		return
	}
	if terminalRunStatus(run.Status) {
		catchup, catchupErr := h.service.EventsAfter(runID, strconv.FormatUint(lastID, 10))
		if catchupErr != nil {
			return
		}
		for _, event := range catchup {
			if decodeEventID(event.ID) <= lastID {
				continue
			}
			if _, err := w.Write(encodeSSE(event)); err != nil {
				return
			}
			lastID = decodeEventID(event.ID)
		}
		flusher.Flush()
		return
	}
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, open := <-live:
			if !open {
				return
			}
			if decodeEventID(event.ID) <= lastID {
				continue
			}
			if _, err := w.Write(encodeSSE(event)); err != nil {
				return
			}
			lastID = decodeEventID(event.ID)
			flusher.Flush()
			if terminalEventType(event.Type) {
				return
			}
		case <-keepalive.C:
			if _, err := w.Write([]byte(": keepalive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func terminalEventType(eventType string) bool {
	return eventType == "completed" || eventType == "failed" || eventType == "cancelled"
}

func terminalRunStatus(status evaluationplane.RunStatus) bool {
	return status == evaluationplane.StatusCompleted || status == evaluationplane.StatusFailed || status == evaluationplane.StatusCancelled
}
