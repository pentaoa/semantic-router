import { useDeferredValue, useEffect, useMemo, useState } from 'react'

import type {
  EvaluationRun,
  EvaluationRunEvent,
  EvaluationRunStatus,
  EvaluationTrackId,
} from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { formatDateTime, formatDurationBetween } from '../../utils/dateTime'
import ProductIcon from '../ProductIcon'
import { RunStatusBadge, TrackChips } from './EvaluationPrimitives'
import EvaluationRunTimeline from './EvaluationRunTimeline'
import styles from './EvaluationPlane.module.css'

const PAGE_SIZE = 10

interface EvaluationRunsProps {
  runs: EvaluationRun[]
  selectedRunID: string | null
  events: EvaluationRunEvent[]
  eventsConnected: boolean
  eventsError: string | null
  onReconnectEvents: () => void
  canRun: boolean
  canDelete: boolean
  refreshing: boolean
  lastUpdatedAt: Date | null
  mutationKey: string | null
  onSelect: (run: EvaluationRun) => void
  onStart: (run: EvaluationRun) => void
  onCancel: (run: EvaluationRun) => void
  onDelete: (run: EvaluationRun) => void
  onOpenReport: (run: EvaluationRun) => void
  onRefresh: () => void
}

export default function EvaluationRuns({
  runs,
  selectedRunID,
  events,
  eventsConnected,
  eventsError,
  onReconnectEvents,
  canRun,
  canDelete,
  refreshing,
  lastUpdatedAt,
  mutationKey,
  onSelect,
  onStart,
  onCancel,
  onDelete,
  onOpenReport,
  onRefresh,
}: EvaluationRunsProps) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<EvaluationRunStatus | 'all'>('all')
  const [track, setTrack] = useState<EvaluationTrackId | 'all'>('all')
  const [page, setPage] = useState(1)
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const selectedRun = runs.find((run) => run.id === selectedRunID) || null
  const filteredRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (status !== 'all' && run.status !== status) return false
        if (track !== 'all' && !run.track_ids.includes(track)) return false
        if (!deferredSearch) return true
        return [
          run.id,
          run.name,
          run.description,
          run.target_id,
          run.change_profile,
          ...run.track_ids,
        ]
          .join(' ')
          .toLowerCase()
          .includes(deferredSearch)
      }),
    [deferredSearch, runs, status, track],
  )
  const pages = Math.max(1, Math.ceil(filteredRuns.length / PAGE_SIZE))
  const visibleRuns = filteredRuns.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => setPage(1), [deferredSearch, status, track])
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])

  const resetFilters = () => {
    setSearch('')
    setStatus('all')
    setTrack('all')
  }
  const selectedPending = (operation: string) =>
    Boolean(selectedRun && mutationKey === `${operation}:${selectedRun.id}`)
  const mutationPending = mutationKey !== null

  return (
    <div className={styles.sectionStack}>
      <section className={styles.surface} aria-labelledby="evaluation-runs-title">
        <header className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>Execution ledger</span>
            <h2 id="evaluation-runs-title">Evaluation runs</h2>
            <p>
              Search the immutable run ledger, then inspect one execution and its durable timeline.
            </p>
          </div>
          <div className={styles.refreshCluster}>
            <span>
              {lastUpdatedAt
                ? `Updated ${formatDateTime(lastUpdatedAt.toISOString())}`
                : 'Not refreshed yet'}
            </span>
            <button
              type="button"
              className={styles.iconButton}
              disabled={refreshing}
              aria-busy={refreshing}
              onClick={onRefresh}
              aria-label="Refresh evaluation runs"
            >
              <ProductIcon name="refresh" /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

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
            {filteredRuns.length} of {runs.length} runs
          </span>
        </div>

        <div className={styles.runWorkspace}>
          <div className={styles.runLedger}>
            {visibleRuns.length === 0 ? (
              <div className={styles.emptyState}>
                <div>
                  <strong>
                    {runs.length ? 'No runs match these filters.' : 'No evaluation runs yet.'}
                  </strong>
                  <p>
                    {runs.length
                      ? 'Reset filters to return to the full ledger.'
                      : 'Create an experiment to establish the first evidence baseline.'}
                  </p>
                </div>
                {runs.length ? (
                  <button type="button" onClick={resetFilters}>
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
                        {run.mode} · {run.change_profile} · {formatDateTime(run.created_at)}
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
                  disabled={page === pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </button>
              </nav>
            ) : null}
          </div>

          <aside className={styles.runInspector} aria-labelledby="run-inspector-title">
            {selectedRun ? (
              <>
                <header className={styles.inspectorHeader}>
                  <div>
                    <span className={styles.eyebrow}>Run inspector</span>
                    <h3 id="run-inspector-title">{selectedRun.name}</h3>
                    <code>{selectedRun.id}</code>
                  </div>
                  <RunStatusBadge status={selectedRun.status} />
                </header>
                <TrackChips trackIDs={selectedRun.track_ids} />
                <dl className={styles.definitionGrid}>
                  <div>
                    <dt>Target</dt>
                    <dd>{selectedRun.target_id}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>{selectedRun.evidence_level}</dd>
                  </div>
                  <div>
                    <dt>Workload</dt>
                    <dd>
                      {selectedRun.sample_limit} cases · c{selectedRun.concurrency}
                    </dd>
                  </div>
                  <div>
                    <dt>Seed</dt>
                    <dd>{selectedRun.seed}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {formatDurationBetween(selectedRun.started_at, selectedRun.completed_at)}
                    </dd>
                  </div>
                  <div>
                    <dt>Baseline</dt>
                    <dd>
                      <code>{selectedRun.baseline_run_id || 'None'}</code>
                    </dd>
                  </div>
                  <div className={styles.definitionWide}>
                    <dt>Suites</dt>
                    <dd>{selectedRun.suite_ids.join(', ') || 'None'}</dd>
                  </div>
                </dl>
                {selectedRun.error ? (
                  <div className={styles.errorBanner} role="alert">
                    {selectedRun.error}
                  </div>
                ) : null}
                <div
                  className={styles.inspectorActions}
                  aria-label={`Actions for ${selectedRun.name}`}
                >
                  {selectedRun.status === 'pending' && canRun ? (
                    <button
                      type="button"
                      disabled={mutationPending}
                      aria-label={`Start ${selectedRun.name}`}
                      onClick={() => onStart(selectedRun)}
                    >
                      <ProductIcon name="play" /> {selectedPending('start') ? 'Starting…' : 'Start'}
                    </button>
                  ) : null}
                  {selectedRun.status === 'running' && canRun ? (
                    <button
                      type="button"
                      className={styles.warningButton}
                      disabled={mutationPending}
                      aria-label={`Cancel ${selectedRun.name}`}
                      onClick={() => onCancel(selectedRun)}
                    >
                      <ProductIcon name="close" /> Cancel
                    </button>
                  ) : null}
                  {selectedRun.status === 'completed' ? (
                    <button
                      type="button"
                      aria-label={`Open report for ${selectedRun.name}`}
                      onClick={() => onOpenReport(selectedRun)}
                    >
                      <ProductIcon name="chart" /> Open report
                    </button>
                  ) : null}
                  {selectedRun.status !== 'running' && canDelete ? (
                    <button
                      type="button"
                      className={styles.dangerButton}
                      disabled={mutationPending}
                      aria-label={`Delete ${selectedRun.name}`}
                      onClick={() => onDelete(selectedRun)}
                    >
                      <ProductIcon name="trash" /> Delete
                    </button>
                  ) : null}
                </div>
                {selectedRun.status !== 'completed' &&
                ['failed', 'cancelled'].includes(selectedRun.status) ? (
                  <p className={styles.scopeNotice}>
                    A completed report was not published. Inspect the failure reason and durable
                    lifecycle events instead.
                  </p>
                ) : null}
                <EvaluationRunTimeline
                  run={selectedRun}
                  events={events}
                  connected={eventsConnected}
                  error={eventsError}
                  onReconnect={onReconnectEvents}
                />
              </>
            ) : (
              <div className={styles.inspectorEmpty}>
                <strong>Select a run</strong>
                <p>Its immutable scope, valid actions, and execution timeline appear here.</p>
              </div>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}
