import ProductLoadingState from '../ProductLoadingState'
import type { EvaluationRun } from '../../types/evaluationPlane'
import type { EvaluationReport } from '../../types/evaluationReport'
import EvaluationReportView from './EvaluationReportView'
import styles from './EvaluationPlane.module.css'
import reportStyles from './EvaluationReports.module.css'

interface EvaluationReportsProps {
  runs: EvaluationRun[]
  selectedRunID: string
  report: EvaluationReport | null
  loading: boolean
  runLedgerAvailable: boolean
  totalRuns: number
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  error: string | null
  onSelect: (runID: string) => void
  onRetry: () => void
  onLoadMoreRuns: () => void
}

export default function EvaluationReports({
  runs,
  selectedRunID,
  report,
  loading,
  runLedgerAvailable,
  totalRuns,
  hasMoreRuns,
  loadingMoreRuns,
  error,
  onSelect,
  onRetry,
  onLoadMoreRuns,
}: EvaluationReportsProps) {
  const reportableRuns = runs.filter((run) => run.status === 'completed')
  const selectedReportRun =
    report && !reportableRuns.some((run) => run.id === report.run.id) ? report.run : null
  return (
    <div className={styles.sectionStack} aria-busy={loading}>
      <section className={styles.surface}>
        <div className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>Evidence browser</span>
            <h2>Reports</h2>
            <p>
              Inspect measured outcomes, gate blockers, cost ledgers, diagnostics, and immutable
              provenance.
            </p>
          </div>
          <label className={reportStyles.reportSelector}>
            <span>Run</span>
            <select
              value={selectedRunID}
              disabled={!runLedgerAvailable}
              onChange={(event) => onSelect(event.target.value)}
            >
              <option value="">
                {runLedgerAvailable ? 'Select a completed run' : 'Run ledger unavailable'}
              </option>
              {selectedReportRun ? (
                <option value={selectedReportRun.id}>
                  {selectedReportRun.name} · {selectedReportRun.evidence_level}
                </option>
              ) : null}
              {reportableRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.evidence_level}
                </option>
              ))}
            </select>
          </label>
        </div>
        {runLedgerAvailable && hasMoreRuns ? (
          <div className={styles.scopeNotice} role="status">
            <span>
              Report selection covers {runs.length} of {totalRuns} loaded runs.
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={loadingMoreRuns}
              onClick={onLoadMoreRuns}
            >
              {loadingMoreRuns ? 'Loading older runs…' : 'Load older reports'}
            </button>
          </div>
        ) : null}
      </section>
      {loading ? (
        <div className={styles.panel}>
          <ProductLoadingState label="Loading evaluation report" compact />
        </div>
      ) : null}
      {error ? (
        <div className={styles.errorState} role="alert">
          <h2>Report unavailable</h2>
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && report ? <EvaluationReportView report={report} /> : null}
      {!loading && !error && !report ? (
        <div className={styles.emptyState}>
          <p>
            {!runLedgerAvailable
              ? 'Retry the run ledger to discover completed reports.'
              : reportableRuns.length
                ? 'Select a completed run to load its evidence report.'
                : hasMoreRuns
                  ? 'No completed report is present in the loaded runs. Load older runs to continue searching.'
                  : 'No completed run has published a report yet. Failed and cancelled runs remain in the run inspector.'}
          </p>
        </div>
      ) : null}
    </div>
  )
}
