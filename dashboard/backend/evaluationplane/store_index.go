package evaluationplane

import (
	"log"
	"sort"
	"sync"
)

// runMetadataIndex is a process-local projection rebuilt exclusively from
// canonical run bundles. It owns no durable facts. Stores opened on the same
// root share the coordinator and projection so mutations remain coherent
// across Store instances in the one-node backend.
type runMetadataIndex struct {
	coordinator    sync.Mutex
	mu             sync.RWMutex
	runs           []Run
	positions      map[string]int
	warnings       map[string]runListWarning
	warningCount   int
	eventSequences map[string]uint64
}

var runMetadataIndexes = struct {
	sync.Mutex
	byRoot map[string]*runMetadataIndex
}{byRoot: make(map[string]*runMetadataIndex)}

func sharedRunMetadataIndex(root string) *runMetadataIndex {
	runMetadataIndexes.Lock()
	defer runMetadataIndexes.Unlock()
	if existing := runMetadataIndexes.byRoot[root]; existing != nil {
		return existing
	}
	created := &runMetadataIndex{
		positions: make(map[string]int), warnings: make(map[string]runListWarning),
		eventSequences: make(map[string]uint64),
	}
	runMetadataIndexes.byRoot[root] = created
	return created
}

func (index *runMetadataIndex) replace(runs []Run, warnings map[string]runListWarning, warningCount int) {
	sort.Slice(runs, func(left, right int) bool { return runNewer(runs[left], runs[right]) })
	index.mu.Lock()
	defer index.mu.Unlock()
	for evidenceID, warning := range warnings {
		if previous, unchanged := index.warnings[evidenceID]; unchanged && previous == warning {
			continue
		}
		log.Printf(
			"evaluationplane: warning_code=%s evidence_id=%q message=%q",
			warning.Code, warning.EvidenceID, warning.Message,
		)
	}
	index.runs = append([]Run(nil), runs...)
	index.positions = make(map[string]int, len(index.runs))
	index.rebuildPositions(0)
	activeSequences := make(map[string]uint64, len(index.runs))
	for _, run := range index.runs {
		if sequence, exists := index.eventSequences[run.ID]; exists {
			activeSequences[run.ID] = sequence
		}
	}
	index.eventSequences = activeSequences
	index.warnings = warnings
	index.warningCount = warningCount
}

func (index *runMetadataIndex) upsert(run Run) {
	index.mu.Lock()
	defer index.mu.Unlock()
	if position, exists := index.positions[run.ID]; exists {
		if index.runs[position].CreatedAt.Equal(run.CreatedAt) {
			index.runs[position] = run
			return
		}
		copy(index.runs[position:], index.runs[position+1:])
		index.runs = index.runs[:len(index.runs)-1]
		delete(index.positions, run.ID)
		index.rebuildPositions(position)
	}
	position := sort.Search(len(index.runs), func(candidate int) bool {
		return runNewer(run, index.runs[candidate])
	})
	index.runs = append(index.runs, Run{})
	copy(index.runs[position+1:], index.runs[position:])
	index.runs[position] = run
	index.rebuildPositions(position)
}

func (index *runMetadataIndex) remove(runID string) {
	index.mu.Lock()
	defer index.mu.Unlock()
	position, exists := index.positions[runID]
	if !exists {
		return
	}
	copy(index.runs[position:], index.runs[position+1:])
	index.runs = index.runs[:len(index.runs)-1]
	delete(index.positions, runID)
	delete(index.eventSequences, runID)
	index.rebuildPositions(position)
}

func (index *runMetadataIndex) eventSequence(runID string) (uint64, bool) {
	index.mu.RLock()
	defer index.mu.RUnlock()
	sequence, exists := index.eventSequences[runID]
	return sequence, exists
}

func (index *runMetadataIndex) setEventSequence(runID string, sequence uint64) {
	index.mu.Lock()
	defer index.mu.Unlock()
	index.eventSequences[runID] = sequence
}

func (index *runMetadataIndex) rebuildPositions(start int) {
	if index.positions == nil {
		index.positions = make(map[string]int, len(index.runs))
	}
	for position := start; position < len(index.runs); position++ {
		index.positions[index.runs[position].ID] = position
	}
}

func (index *runMetadataIndex) allRuns() []Run {
	index.mu.RLock()
	defer index.mu.RUnlock()
	return append(make([]Run, 0, len(index.runs)), index.runs...)
}

func (index *runMetadataIndex) page(cursor *runListCursor, limit int) (runs []Run, total int, warnings []runListWarning, warningCount int) {
	index.mu.RLock()
	defer index.mu.RUnlock()
	start := 0
	if cursor != nil {
		start = sort.Search(len(index.runs), func(position int) bool {
			return runOlderThanCursor(index.runs[position], *cursor)
		})
	}
	end := start + limit + 1
	if end > len(index.runs) {
		end = len(index.runs)
	}
	runs = append(make([]Run, 0, end-start), index.runs[start:end]...)
	warnings = make([]runListWarning, 0, len(index.warnings))
	for _, warning := range index.warnings {
		warnings = append(warnings, warning)
	}
	return runs, len(index.runs), warnings, index.warningCount
}

func (index *runMetadataIndex) activeWarnings() []runListWarning {
	index.mu.RLock()
	defer index.mu.RUnlock()
	warnings := make([]runListWarning, 0, len(index.warnings))
	for _, warning := range index.warnings {
		warnings = append(warnings, warning)
	}
	sort.Slice(warnings, func(left, right int) bool { return warnings[left].EvidenceID < warnings[right].EvidenceID })
	return warnings
}
