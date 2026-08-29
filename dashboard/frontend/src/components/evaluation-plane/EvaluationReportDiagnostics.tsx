import type {
  EvaluationCapacityProfile,
  EvaluationFailureSummary,
} from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import type { EvaluationDiagnosticArtifactIssue } from '../../utils/evaluationDiagnosticArtifacts'
import { formatMetric } from './evaluationPresentation'
import styles from './EvaluationReport.module.css'

interface EvaluationReportDiagnosticsProps {
  failureSummary: EvaluationFailureSummary | null
  capacityProfile: EvaluationCapacityProfile | null
  failureSummaryIssue: EvaluationDiagnosticArtifactIssue | null
  capacityProfileIssue: EvaluationDiagnosticArtifactIssue | null
  loading: boolean
}

function DiagnosticArtifactIssue({
  label,
  issue,
}: {
  label: string
  issue: EvaluationDiagnosticArtifactIssue
}) {
  return (
    <div className={styles.inlineNotice} role="alert" aria-label={`${label} diagnostic error`}>
      <strong>
        {issue.kind === 'invalid'
          ? 'Invalid diagnostic artifact'
          : 'Diagnostic artifact unavailable'}
      </strong>
      <span>{issue.message}</span>
    </div>
  )
}

export default function EvaluationReportDiagnostics({
  failureSummary,
  capacityProfile,
  failureSummaryIssue,
  capacityProfileIssue,
  loading,
}: EvaluationReportDiagnosticsProps) {
  if (loading) return <p className={styles.empty}>Loading verified diagnostics…</p>
  if (!failureSummary && !capacityProfile && !failureSummaryIssue && !capacityProfileIssue) {
    return <p className={styles.empty}>This run did not publish aggregate diagnostics.</p>
  }

  const succeeded = failureSummary
    ? failureSummary.total_records - failureSummary.failed - failureSummary.unavailable
    : 0
  return (
    <div className={styles.diagnosticsStack}>
      {failureSummary || failureSummaryIssue ? (
        <section className={styles.diagnosticArtifact} aria-labelledby="diagnostic-outcome-title">
          <div className={styles.subsectionHeader}>
            <div>
              <h4 id="diagnostic-outcome-title">Outcome accounting</h4>
              <p>Aggregate completion states retained without case-level content.</p>
            </div>
          </div>
          {failureSummaryIssue ? (
            <DiagnosticArtifactIssue label="Outcome accounting" issue={failureSummaryIssue} />
          ) : failureSummary ? (
            <>
              <div className={styles.diagnosticSummary}>
                <div>
                  <span>Total records</span>
                  <strong>{failureSummary.total_records}</strong>
                </div>
                <div>
                  <span>Succeeded</span>
                  <strong>{succeeded}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{failureSummary.failed}</strong>
                </div>
                <div>
                  <span>Not measured</span>
                  <strong>{failureSummary.unavailable}</strong>
                </div>
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.compactTable}>
                  <caption>Outcome accounting by evaluation track</caption>
                  <thead>
                    <tr>
                      <th scope="col">Track</th>
                      <th scope="col">Succeeded</th>
                      <th scope="col">Failed</th>
                      <th scope="col">Not measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failureSummary.by_track.map((row) => (
                      <tr key={row.track_id}>
                        <th scope="row">{TRACK_PRESENTATION[row.track_id].label}</th>
                        <td>{row.succeeded}</td>
                        <td>{row.failed}</td>
                        <td>{row.unavailable}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {capacityProfile || capacityProfileIssue ? (
        <section className={styles.diagnosticArtifact} aria-labelledby="diagnostic-capacity-title">
          <div className={styles.subsectionHeader}>
            <div>
              <h4 id="diagnostic-capacity-title">Capacity envelope</h4>
              <p>Bounded concurrency observations retained by the live executor.</p>
            </div>
            {capacityProfile ? (
              <span className={capacityProfile.slo ? styles.scopeReady : styles.scopeDiagnostic}>
                {capacityProfile.slo ? 'SLO declared' : 'No SLO · diagnostic only'}
              </span>
            ) : null}
          </div>
          {capacityProfileIssue ? (
            <DiagnosticArtifactIssue label="Capacity profile" issue={capacityProfileIssue} />
          ) : capacityProfile ? (
            <div className={styles.tableScroll}>
              <table className={styles.compactTable}>
                <caption>Capacity observations by concurrency</caption>
                <thead>
                  <tr>
                    <th scope="col">Concurrency</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Success</th>
                    <th scope="col">Throughput</th>
                    <th scope="col">P50</th>
                    <th scope="col">P95</th>
                    <th scope="col">P99</th>
                    <th scope="col">Runtime cost</th>
                  </tr>
                </thead>
                <tbody>
                  {capacityProfile.levels.map((level) => (
                    <tr key={level.concurrency}>
                      <th scope="row">{level.concurrency}</th>
                      <td>{level.requests}</td>
                      <td>
                        {level.successes}/{level.requests}
                      </td>
                      <td>{formatMetric({ value: level.throughput_rps, unit: 'requests/s' })}</td>
                      <td>{formatMetric({ value: level.latency_p50_ms, unit: 'ms' })}</td>
                      <td>{formatMetric({ value: level.latency_p95_ms, unit: 'ms' })}</td>
                      <td>{formatMetric({ value: level.latency_p99_ms, unit: 'ms' })}</td>
                      <td>{formatMetric({ value: level.runtime_cost_usd, unit: 'usd' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
