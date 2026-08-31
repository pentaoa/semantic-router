import type { EvaluationReport } from '../../types/evaluationReport'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import overviewStyles from './EvaluationOverview.module.css'
import { formatMetric } from './evaluationPresentation'
import type { EvaluationOverviewModel } from './evaluationOverview'
import { EvaluationActionButton, RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationPlane.module.css'

interface EvaluationLatestEvidenceProps {
  model: EvaluationOverviewModel
  latestReport: EvaluationReport | null
  reportLoading: boolean
  reportError: string | null
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  onRetryReport: () => void
  onLoadMoreRuns: () => void
  onOpenReport: (runID: string) => void
}

export default function EvaluationLatestEvidence({
  model,
  latestReport,
  reportLoading,
  reportError,
  runLedgerAvailable,
  runLedgerComplete,
  hasMoreRuns,
  loadingMoreRuns,
  onRetryReport,
  onLoadMoreRuns,
  onOpenReport,
}: EvaluationLatestEvidenceProps) {
  return (
    <section
      className={`${styles.surface} ${styles.workspaceSurface}`}
      aria-labelledby="latest-evidence-title"
    >
      <header className={styles.surfaceHeader}>
        <div>
          <span className={styles.eyebrow}>
            {runLedgerComplete ? 'Latest completed evidence' : 'Latest readable evidence'}
          </span>
          <h2 id="latest-evidence-title">
            {model.latestEvidenceName || 'No completed report yet'}
          </h2>
          <p>
            {!runLedgerAvailable
              ? 'The run ledger must load before the newest completed report can be selected.'
              : reportLoading && !latestReport
                ? 'Loading the current server attestation and independently reduced headline metrics.'
                : 'Only metrics reduced by the current server attestation are elevated here; the complete worker-derived metric set remains in the report explorer.'}
          </p>
        </div>
        {latestReport ? (
          <EvaluationActionButton
            type="button"
            variant="quiet"
            onClick={() => onOpenReport(latestReport.run.id)}
          >
            Open full report
          </EvaluationActionButton>
        ) : null}
      </header>
      {reportLoading ? <p className={styles.emptyCopy}>Loading report summary…</p> : null}
      {reportError ? (
        <div className={styles.inlineError} role="alert">
          <div>
            <strong>Latest report could not be refreshed.</strong>
            <span>{reportError}</span>
          </div>
          <EvaluationActionButton type="button" compact onClick={onRetryReport}>
            Retry
          </EvaluationActionButton>
        </div>
      ) : null}
      {!reportLoading && !reportError && latestReport ? (
        model.headlines.length ? (
          <dl className={overviewStyles.headlineStrip}>
            {model.headlines.map((metric) => (
              <div key={`${metric.track_id || 'system'}-${metric.id}`}>
                <dt>{metric.name}</dt>
                <dd>{formatMetric(metric)}</dd>
                <span>
                  Server-reduced {latestReport.run.evidence_level} ·{' '}
                  {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'}
                </span>
              </div>
            ))}
          </dl>
        ) : (
          <div className={styles.scopeNotice}>
            <strong>
              {model.isDiagnostic
                ? 'Promotion summary withheld — server-attested diagnostic E0'
                : 'No measured headline applies to this run'}
            </strong>
            <span>
              {model.isDiagnostic
                ? 'No independently reduced diagnostic headline matches this run scope. Inspect the metric explorer and gates for the complete E0 observations and exact evidence gap.'
                : 'Inspect the full report for the measured outcomes and exact evidence scope.'}
            </span>
          </div>
        )
      ) : null}
      {!reportLoading && !reportError && !latestReport ? (
        <div className={styles.emptyState}>
          <p>
            {!runLedgerAvailable
              ? 'Retry the run ledger to discover completed reports.'
              : hasMoreRuns
                ? 'No completed report is present in the loaded runs. Load older runs to continue searching.'
                : 'Complete a run to establish a report.'}
          </p>
          {runLedgerAvailable && hasMoreRuns ? (
            <EvaluationActionButton
              type="button"
              compact
              disabled={loadingMoreRuns}
              onClick={onLoadMoreRuns}
            >
              {loadingMoreRuns ? 'Loading older runs…' : 'Load older runs'}
            </EvaluationActionButton>
          ) : null}
          {model.latestRun ? <RunStatusBadge status={model.latestRun.status} /> : null}
        </div>
      ) : null}
    </section>
  )
}
