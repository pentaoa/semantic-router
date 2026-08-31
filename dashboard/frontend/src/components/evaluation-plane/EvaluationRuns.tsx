import type { EvaluationRun, EvaluationRunEvent } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import { EvaluationActionButton } from './EvaluationPrimitives'
import EvaluationRunInspector from './EvaluationRunInspector'
import EvaluationRunLedger, { EvaluationRunLedgerFilters } from './EvaluationRunLedger'
import useEvaluationRunLedger from './useEvaluationRunLedger'
import styles from './EvaluationPlane.module.css'
import runStyles from './EvaluationRuns.module.css'

interface EvaluationRunsProps {
  runs: EvaluationRun[]
  selectedRunID: string | null
  selectedRun: EvaluationRun | null
  selectedRunLoading: boolean
  selectedRunError: string | null
  onRetrySelectedRun: () => void
  events: EvaluationRunEvent[]
  eventsConnected: boolean
  eventsError: string | null
  onReconnectEvents: () => void
  canRun: boolean
  canDelete: boolean
  refreshing: boolean
  loadingMore: boolean
  runLedgerAvailable: boolean
  autoRefreshPaused: boolean
  totalRuns: number
  hasMoreRuns: boolean
  lastUpdatedAt: Date | null
  mutationKey: string | null
  onSelect: (run: EvaluationRun) => void
  onStart: (run: EvaluationRun) => void
  onCancel: (run: EvaluationRun) => void
  onDelete: (run: EvaluationRun) => void
  onOpenReport: (run: EvaluationRun) => void
  onRefresh: () => void
  onLoadMore: () => void
}

export default function EvaluationRuns({
  runs,
  selectedRunID,
  selectedRun,
  selectedRunLoading,
  selectedRunError,
  onRetrySelectedRun,
  events,
  eventsConnected,
  eventsError,
  onReconnectEvents,
  canRun,
  canDelete,
  refreshing,
  loadingMore,
  runLedgerAvailable,
  autoRefreshPaused,
  totalRuns,
  hasMoreRuns,
  lastUpdatedAt,
  mutationKey,
  onSelect,
  onStart,
  onCancel,
  onDelete,
  onOpenReport,
  onRefresh,
  onLoadMore,
}: EvaluationRunsProps) {
  const ledger = useEvaluationRunLedger(runs)
  return (
    <div className={styles.sectionStack}>
      <section
        className={`${styles.surface} ${styles.workspaceSurface}`}
        aria-labelledby="evaluation-runs-title"
      >
        <header className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>Execution ledger</span>
            <h2 id="evaluation-runs-title">Evaluation runs</h2>
            <p>
              Search the immutable run ledger, then inspect one execution and its durable timeline.
            </p>
          </div>
          <div className={runStyles.refreshCluster}>
            <span>
              {autoRefreshPaused
                ? 'Multiple pages loaded · refresh manually'
                : lastUpdatedAt
                  ? `Updated ${formatDateTime(lastUpdatedAt.toISOString())}`
                  : 'Not refreshed yet'}
            </span>
            <EvaluationActionButton
              type="button"
              compact
              disabled={refreshing || loadingMore}
              aria-busy={refreshing}
              onClick={onRefresh}
              aria-label="Refresh evaluation runs"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </EvaluationActionButton>
          </div>
        </header>

        <EvaluationRunLedgerFilters
          model={ledger}
          runLedgerAvailable={runLedgerAvailable}
          loadedRuns={runs.length}
          totalRuns={totalRuns}
          hasMoreRuns={hasMoreRuns}
        />

        <div className={runStyles.runWorkspace}>
          <EvaluationRunLedger
            runs={runs}
            selectedRunID={selectedRunID}
            runLedgerAvailable={runLedgerAvailable}
            totalRuns={totalRuns}
            hasMoreRuns={hasMoreRuns}
            loadingMore={loadingMore}
            refreshing={refreshing}
            model={ledger}
            onSelect={onSelect}
            onLoadMore={onLoadMore}
          />
          <EvaluationRunInspector
            selectedRunID={selectedRunID}
            run={selectedRun}
            loading={selectedRunLoading}
            error={selectedRunError}
            events={events}
            eventsConnected={eventsConnected}
            eventsError={eventsError}
            canRun={canRun}
            canDelete={canDelete}
            mutationKey={mutationKey}
            onRetry={onRetrySelectedRun}
            onReconnectEvents={onReconnectEvents}
            onStart={onStart}
            onCancel={onCancel}
            onDelete={onDelete}
            onOpenReport={onOpenReport}
          />
        </div>
      </section>
    </div>
  )
}
