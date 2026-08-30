import type {
  EvaluationRun,
  EvaluationRunStatus,
  EvaluationTrackId,
} from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import { RunStatusBadge } from './EvaluationPrimitives'
import planeStyles from './EvaluationPlane.module.css'
import styles from './EvaluationRuns.module.css'
import type { EvaluationRunLedgerModel } from './useEvaluationRunLedger'

interface EvaluationRunLedgerFiltersProps {
  model: EvaluationRunLedgerModel
  runLedgerAvailable: boolean
  loadedRuns: number
  totalRuns: number
  hasMoreRuns: boolean
}

export function EvaluationRunLedgerFilters({
  model,
  runLedgerAvailable,
  loadedRuns,
  totalRuns,
  hasMoreRuns,
}: EvaluationRunLedgerFiltersProps) {
  const { search, status, track, filteredRuns, setSearch, setStatus, setTrack } = model
  return (
    <>
      <div className={styles.filters}>
        <label>
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Run, target, profile, or ID"
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as EvaluationRunStatus | 'all')}
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="sealing">Sealing evidence</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          <span>Track</span>
          <select
            value={track}
            onChange={(event) => setTrack(event.target.value as EvaluationTrackId | 'all')}
          >
            <option value="all">All tracks</option>
            {EVALUATION_TRACK_IDS.map((id) => (
              <option key={id} value={id}>
                {TRACK_PRESENTATION[id].label}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.resultCount} aria-live="polite">
          {runLedgerAvailable
            ? `${filteredRuns.length} matching among loaded · ${loadedRuns} of ${totalRuns} runs loaded`
            : 'Run ledger unavailable'}
        </span>
      </div>
      {hasMoreRuns ? (
        <p className={planeStyles.scopeNotice} role="status">
          Search and filters cover only the {loadedRuns} loaded runs. Load older records to search
          and filter the full ledger.
        </p>
      ) : null}
    </>
  )
}

interface EvaluationRunLedgerProps {
  runs: EvaluationRun[]
  selectedRunID: string | null
  runLedgerAvailable: boolean
  totalRuns: number
  hasMoreRuns: boolean
  loadingMore: boolean
  refreshing: boolean
  model: EvaluationRunLedgerModel
  onSelect: (run: EvaluationRun) => void
  onLoadMore: () => void
}

export default function EvaluationRunLedger({
  runs,
  selectedRunID,
  runLedgerAvailable,
  totalRuns,
  hasMoreRuns,
  loadingMore,
  refreshing,
  model,
  onSelect,
  onLoadMore,
}: EvaluationRunLedgerProps) {
  const { page, pages, visibleRuns, filtersActive, resetFilters, setPage } = model

  return (
    <div className={styles.runLedger}>
      {visibleRuns.length === 0 ? (
        <div className={planeStyles.emptyState}>
          <div>
            <strong>
              {!runLedgerAvailable
                ? 'Run ledger is unavailable.'
                : runs.length
                  ? 'No runs match these filters.'
                  : 'No evaluation runs yet.'}
            </strong>
            <p>
              {!runLedgerAvailable
                ? 'Retry the ledger before interpreting run history.'
                : runs.length
                  ? 'Reset filters to return to the full ledger.'
                  : 'Create an experiment to establish the first evidence baseline.'}
            </p>
          </div>
          {filtersActive ? (
            <button type="button" className={planeStyles.secondaryButton} onClick={resetFilters}>
              Reset filters
            </button>
          ) : null}
        </div>
      ) : (
        <ol className={styles.runList} aria-label="Evaluation run ledger">
          {visibleRuns.map((run) => (
            <li
              key={run.id}
              className={`${styles.runRow} ${selectedRunID === run.id ? styles.runSelected : ''}`}
            >
              <button
                type="button"
                className={styles.runSummary}
                aria-label={`Inspect ${run.name}`}
                aria-current={selectedRunID === run.id ? 'true' : undefined}
                onClick={() => onSelect(run)}
              >
                <span className={styles.runRowTop}>
                  <strong>{run.name}</strong>
                  <RunStatusBadge status={run.status} />
                </span>
                <span className={styles.runRowMeta}>
                  {run.mixture?.entrypoint_model || run.mode} ·{' '}
                  {run.mixture?.recipe_name || run.change_profile} ·{' '}
                  {formatDateTime(run.created_at)}
                </span>
                <span className={styles.runRowProgress}>
                  {Math.round(run.progress.percent)}% ·{' '}
                  {run.progress.message || 'Awaiting execution'}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {pages > 1 ? (
        <nav className={styles.pagination} aria-label="Run ledger pages">
          <button
            type="button"
            className={planeStyles.secondaryButton}
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className={planeStyles.secondaryButton}
            disabled={page === pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
      {hasMoreRuns ? (
        <div className={styles.pagination} aria-label="Load more evaluation runs">
          <span>
            {runs.length} of {totalRuns} runs loaded
          </span>
          <button
            type="button"
            className={planeStyles.secondaryButton}
            disabled={loadingMore || refreshing}
            onClick={onLoadMore}
          >
            {loadingMore ? 'Loading more…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
