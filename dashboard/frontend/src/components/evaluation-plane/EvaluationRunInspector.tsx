import type { EvaluationRun, EvaluationRunEvent } from '../../types/evaluationPlane'
import { formatDurationBetween } from '../../utils/dateTime'
import ProductLoadingState from '../ProductLoadingState'
import { EvaluationActionButton, RunStatusBadge, TrackChips } from './EvaluationPrimitives'
import EvaluationRunTimeline from './EvaluationRunTimeline'
import planeStyles from './EvaluationPlane.module.css'
import styles from './EvaluationRuns.module.css'

interface EvaluationRunInspectorProps {
  selectedRunID: string | null
  run: EvaluationRun | null
  loading: boolean
  error: string | null
  events: EvaluationRunEvent[]
  eventsConnected: boolean
  eventsError: string | null
  canRun: boolean
  canDelete: boolean
  mutationKey: string | null
  onRetry: () => void
  onReconnectEvents: () => void
  onStart: (run: EvaluationRun) => void
  onCancel: (run: EvaluationRun) => void
  onDelete: (run: EvaluationRun) => void
  onOpenReport: (run: EvaluationRun) => void
}

export default function EvaluationRunInspector({
  selectedRunID,
  run,
  loading,
  error,
  events,
  eventsConnected,
  eventsError,
  canRun,
  canDelete,
  mutationKey,
  onRetry,
  onReconnectEvents,
  onStart,
  onCancel,
  onDelete,
  onOpenReport,
}: EvaluationRunInspectorProps) {
  const mutationPending = mutationKey !== null
  const selectedPending = (operation: string) =>
    Boolean(run && mutationKey === `${operation}:${run.id}`)

  return (
    <aside className={styles.runInspector} aria-labelledby="run-inspector-title">
      {loading ? (
        <div className={styles.inspectorEmpty}>
          <ProductLoadingState label="Loading evaluation run" compact />
        </div>
      ) : error ? (
        <div className={styles.inspectorEmpty} role="alert">
          <strong>Run could not be loaded</strong>
          <p>{error}</p>
          <EvaluationActionButton type="button" onClick={onRetry}>
            Retry run
          </EvaluationActionButton>
        </div>
      ) : run ? (
        <>
          <header className={styles.inspectorHeader}>
            <div>
              <span className={planeStyles.eyebrow}>Run inspector</span>
              <h3 id="run-inspector-title">{run.name}</h3>
              <code>{run.id}</code>
            </div>
            <RunStatusBadge status={run.status} />
          </header>
          <TrackChips trackIDs={run.track_ids} />
          <dl className={styles.definitionGrid}>
            <div>
              <dt>{run.mixture ? 'Mixture entrypoint' : 'Evidence target'}</dt>
              <dd>{run.mixture?.entrypoint_model || run.target_id}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{run.evidence_level}</dd>
            </div>
            {run.mixture ? (
              <>
                <div>
                  <dt>Routing recipe</dt>
                  <dd>{run.mixture.recipe_name}</dd>
                </div>
                <div>
                  <dt>Model pool</dt>
                  <dd>
                    {run.mixture.model_arms.length} arms · {run.mixture.decisions.length} decisions
                  </dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>Workload</dt>
              <dd>
                {run.sample_limit} cases · c{run.concurrency}
              </dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd>{run.seed}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDurationBetween(run.started_at, run.completed_at)}</dd>
            </div>
            <div>
              <dt>Baseline</dt>
              <dd>
                <code>{run.baseline_run_id || 'None'}</code>
              </dd>
            </div>
            <div className={styles.definitionWide}>
              <dt>Suites</dt>
              <dd>{run.suite_ids.join(', ') || 'None'}</dd>
            </div>
          </dl>
          {run.error ? (
            <div className={planeStyles.errorBanner} role="alert">
              {run.error}
            </div>
          ) : null}
          <div className={styles.inspectorActions} aria-label={`Actions for ${run.name}`}>
            {run.status === 'pending' && canRun ? (
              <EvaluationActionButton
                type="button"
                variant="primary"
                disabled={mutationPending}
                aria-label={`Start ${run.name}`}
                onClick={() => onStart(run)}
              >
                {selectedPending('start') ? 'Starting…' : 'Start'}
              </EvaluationActionButton>
            ) : null}
            {run.status === 'running' && canRun ? (
              <EvaluationActionButton
                type="button"
                disabled={mutationPending}
                aria-label={`Cancel ${run.name}`}
                onClick={() => onCancel(run)}
              >
                Cancel
              </EvaluationActionButton>
            ) : null}
            {run.status === 'completed' ? (
              <EvaluationActionButton
                type="button"
                variant="primary"
                aria-label={`Open report for ${run.name}`}
                onClick={() => onOpenReport(run)}
              >
                Open report
              </EvaluationActionButton>
            ) : null}
            {run.status !== 'running' && run.status !== 'sealing' && canDelete ? (
              <EvaluationActionButton
                type="button"
                variant="danger"
                disabled={mutationPending}
                aria-label={`Delete ${run.name}`}
                onClick={() => onDelete(run)}
              >
                Delete
              </EvaluationActionButton>
            ) : null}
          </div>
          {run.status !== 'completed' && ['failed', 'cancelled'].includes(run.status) ? (
            <p className={planeStyles.scopeNotice}>
              A completed report was not published. Inspect the failure reason and durable lifecycle
              events instead.
            </p>
          ) : null}
          <EvaluationRunTimeline
            run={run}
            events={events}
            connected={eventsConnected}
            error={eventsError}
            onReconnect={onReconnectEvents}
          />
        </>
      ) : (
        <div className={styles.inspectorEmpty}>
          <strong>{selectedRunID ? 'Run is not loaded' : 'Select a run'}</strong>
          <p>
            {selectedRunID
              ? 'Retry the explicit run URL or load older pages to inspect it.'
              : 'Its immutable scope, valid actions, and execution timeline appear here.'}
          </p>
          {selectedRunID ? (
            <EvaluationActionButton type="button" onClick={onRetry}>
              Retry run
            </EvaluationActionButton>
          ) : null}
        </div>
      )}
    </aside>
  )
}
