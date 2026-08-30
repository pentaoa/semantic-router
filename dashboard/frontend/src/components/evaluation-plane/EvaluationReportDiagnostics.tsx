import type {
  EvaluationCapacityProfile,
  EvaluationFailureSummary,
} from '../../types/evaluationReport'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import type { EvaluationDiagnosticArtifactIssue } from '../../utils/evaluationDiagnosticArtifacts'
import { formatMetric } from './evaluationPresentation'
import heroStyles from './EvaluationReportHero.module.css'
import reportStyles from './EvaluationReportLayout.module.css'
import styles from './EvaluationReportDiagnostics.module.css'
import tableStyles from './EvaluationReportTable.module.css'

interface EvaluationReportDiagnosticsProps {
  failureSummary: EvaluationFailureSummary | null
  capacityProfile: EvaluationCapacityProfile | null
  failureSummaryIssue: EvaluationDiagnosticArtifactIssue | null
  capacityProfileIssue: EvaluationDiagnosticArtifactIssue | null
  loading: boolean
}

const CAPACITY_FAILURE_LABELS = {
  required_concurrency: 'Required concurrency was not qualified',
  warmup_errors: 'Warmup produced request errors',
  latency_p95: 'p95 latency exceeded its bound',
  error_rate_upper_bound: '95% error-rate upper bound exceeded its budget',
  throughput: 'Throughput missed its minimum',
  throughput_scaling: 'Throughput scaling reached saturation',
  throughput_stability: 'Throughput varied beyond the frozen CV bound',
  latency_stability: 'p95 latency varied beyond the frozen CV bound',
} as const

function DiagnosticArtifactIssue({
  label,
  issue,
}: {
  label: string
  issue: EvaluationDiagnosticArtifactIssue
}) {
  return (
    <div className={heroStyles.inlineNotice} role="alert" aria-label={`${label} diagnostic error`}>
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
  const attestationCopy = 'Server-attested diagnostic artifacts.'

  if (loading) {
    return (
      <div className={styles.diagnosticsStack}>
        <p className={reportStyles.scopeCopy}>{attestationCopy}</p>
        <p className={reportStyles.empty}>Loading diagnostic artifacts…</p>
      </div>
    )
  }
  if (!failureSummary && !capacityProfile && !failureSummaryIssue && !capacityProfileIssue) {
    return (
      <div className={styles.diagnosticsStack}>
        <p className={reportStyles.scopeCopy}>{attestationCopy}</p>
        <p className={reportStyles.empty}>This run did not publish aggregate diagnostics.</p>
      </div>
    )
  }

  const succeeded = failureSummary
    ? failureSummary.total_records - failureSummary.failed - failureSummary.unavailable
    : 0
  return (
    <div className={styles.diagnosticsStack}>
      <p className={reportStyles.scopeCopy}>{attestationCopy}</p>
      {failureSummary || failureSummaryIssue ? (
        <section className={styles.diagnosticArtifact} aria-labelledby="diagnostic-outcome-title">
          <div className={reportStyles.subsectionHeader}>
            <div>
              <h4 id="diagnostic-outcome-title">Outcome accounting</h4>
              <p>
                Server-attested aggregate completion states retained without case-level content.
              </p>
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
              <div
                className={tableStyles.tableScroll}
                role="region"
                tabIndex={0}
                aria-label="Scrollable outcome accounting by track"
              >
                <table className={tableStyles.table}>
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
          <div className={reportStyles.subsectionHeader}>
            <div>
              <h4 id="diagnostic-capacity-title">Capacity envelope</h4>
              <p>
                The frozen service objective reduced against server-attested live load observations.
              </p>
            </div>
            {capacityProfile ? (
              <span
                className={
                  capacityProfile.assessment.verdict === 'pass'
                    ? styles.scopeReady
                    : styles.scopeDiagnostic
                }
              >
                SLO envelope {capacityProfile.assessment.verdict}
              </span>
            ) : null}
          </div>
          {capacityProfileIssue ? (
            <DiagnosticArtifactIssue label="Capacity profile" issue={capacityProfileIssue} />
          ) : capacityProfile ? (
            <>
              <div className={styles.diagnosticSummary}>
                <div>
                  <span>Required concurrency</span>
                  <strong>{capacityProfile.slo.required_concurrency}</strong>
                </div>
                <div>
                  <span>Qualified concurrency</span>
                  <strong>{capacityProfile.assessment.qualified_concurrency ?? '—'}</strong>
                </div>
                <div>
                  <span>SLO headroom</span>
                  <strong>
                    {capacityProfile.assessment.slo_headroom > 0 ? '+' : ''}
                    {capacityProfile.assessment.slo_headroom}
                  </strong>
                </div>
                <div>
                  <span>Saturation boundary</span>
                  <strong>
                    {capacityProfile.assessment.saturation_concurrency ?? 'Not observed'}
                  </strong>
                </div>
              </div>

              <div className={styles.capacitySLOContract} aria-label="Frozen capacity SLO">
                <div>
                  <span>p95 latency</span>
                  <strong>
                    ≤ {formatMetric({ value: capacityProfile.slo.max_latency_p95_ms, unit: 'ms' })}
                  </strong>
                </div>
                <div>
                  <span>Error rate</span>
                  <strong>≤ {(capacityProfile.slo.max_error_rate * 100).toFixed(2)}%</strong>
                </div>
                <div>
                  <span>Throughput at target</span>
                  <strong>
                    ≥{' '}
                    {formatMetric({
                      value: capacityProfile.slo.min_throughput_rps,
                      unit: 'requests/s',
                    })}
                  </strong>
                </div>
                <div>
                  <span>Scaling efficiency</span>
                  <strong>
                    ≥ {(capacityProfile.slo.min_throughput_scaling_efficiency * 100).toFixed(1)}%
                  </strong>
                </div>
              </div>

              <div
                className={styles.capacityProtocolContract}
                aria-label="Frozen capacity load protocol"
              >
                <div>
                  <span>Closed-loop ladder</span>
                  <strong>
                    {capacityProfile.protocol.concurrency_levels
                      .map((level) => `c${level}`)
                      .join(' → ')}
                  </strong>
                </div>
                <div>
                  <span>Warmup per level</span>
                  <strong>
                    {capacityProfile.protocol.warmup_request_multiplier} × concurrency requests
                  </strong>
                </div>
                <div>
                  <span>Measurement window</span>
                  <strong>
                    {capacityProfile.protocol.measurement_requests_per_repetition} requests ×{' '}
                    {capacityProfile.protocol.repetitions_per_level} repetitions
                  </strong>
                </div>
                <div>
                  <span>Confidence / stability</span>
                  <strong>
                    {(capacityProfile.protocol.confidence_level * 100).toFixed(0)}% · throughput CV
                    ≤ {(capacityProfile.protocol.max_throughput_cv * 100).toFixed(0)}% · p95 CV ≤{' '}
                    {(capacityProfile.protocol.max_latency_p95_cv * 100).toFixed(0)}%
                  </strong>
                </div>
              </div>

              {capacityProfile.assessment.failure_reasons.length ? (
                <div className={styles.capacityFailureReasons} role="status">
                  <strong>Why the envelope failed</strong>
                  <ul>
                    {capacityProfile.assessment.failure_reasons.map((reason) => (
                      <li key={reason}>{CAPACITY_FAILURE_LABELS[reason]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div
                className={tableStyles.tableScroll}
                role="region"
                tabIndex={0}
                aria-label="Scrollable capacity envelope observations"
              >
                <table className={tableStyles.table}>
                  <caption>Capacity observations and SLO decisions by concurrency</caption>
                  <thead>
                    <tr>
                      <th scope="col">Concurrency</th>
                      <th scope="col">Envelope</th>
                      <th scope="col">Warmup</th>
                      <th scope="col">Measurement</th>
                      <th scope="col">Errors / 95% UCB</th>
                      <th scope="col">Throughput / CV</th>
                      <th scope="col">Scaling</th>
                      <th scope="col">Latency p50 / p95 / p99 / p95 CV</th>
                      <th scope="col">Checks W / L / E / T / S / Tσ / Lσ</th>
                      <th scope="col">Repetitions</th>
                      <th scope="col">Tokens in / out</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Runtime cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capacityProfile.levels.map((level) => (
                      <tr key={level.concurrency}>
                        <th scope="row">{level.concurrency}</th>
                        <td>
                          <span
                            className={
                              level.qualified ? styles.capacityQualified : styles.capacityOutside
                            }
                          >
                            {level.qualified ? 'Qualified' : 'Outside'}
                          </span>
                        </td>
                        <td>
                          {level.warmup_requests} requests · {level.warmup_errors} errors ·{' '}
                          {formatMetric({ value: level.warmup_elapsed_seconds, unit: 's' })}
                        </td>
                        <td>
                          {level.successes}/{level.measurement_requests} successful
                        </td>
                        <td>
                          {level.errors} · {(level.error_rate * 100).toFixed(2)}% /{' '}
                          {(level.error_rate_upper_bound * 100).toFixed(2)}%
                        </td>
                        <td>
                          {formatMetric({ value: level.throughput_rps, unit: 'requests/s' })} /{' '}
                          {(level.throughput_cv * 100).toFixed(1)}%
                        </td>
                        <td>
                          {level.throughput_scaling_efficiency === null
                            ? 'Baseline'
                            : `${(level.throughput_scaling_efficiency * 100).toFixed(1)}%`}
                        </td>
                        <td>
                          {formatMetric({ value: level.latency_p50_ms, unit: 'ms' })} /{' '}
                          {formatMetric({ value: level.latency_p95_ms, unit: 'ms' })} /{' '}
                          {formatMetric({ value: level.latency_p99_ms, unit: 'ms' })} /{' '}
                          {(level.latency_p95_cv * 100).toFixed(1)}%
                        </td>
                        <td>
                          <span className={styles.capacityChecks}>
                            {(
                              [
                                ['Warmup', level.warmup_passed],
                                ['Latency', level.latency_slo_passed],
                                ['Errors', level.error_slo_passed],
                                ['Throughput', level.throughput_slo_passed],
                                ['Scaling', level.scaling_slo_passed],
                                ['Throughput stability', level.throughput_stability_passed],
                                ['Latency stability', level.latency_stability_passed],
                              ] as const
                            ).map(([label, passed]) => (
                              <span
                                key={String(label)}
                                data-passed={passed}
                                aria-label={`${label} ${passed ? 'passed' : 'failed'}`}
                              >
                                {passed ? '✓' : '×'}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>
                          <details className={styles.repetitionDisclosure}>
                            <summary>{level.repetitions.length} independent windows</summary>
                            <ol>
                              {level.repetitions.map((repetition) => (
                                <li key={repetition.repetition}>
                                  r{repetition.repetition}: {repetition.successes}/
                                  {repetition.requests} ok ·{' '}
                                  {formatMetric({
                                    value: repetition.throughput_rps,
                                    unit: 'requests/s',
                                  })}{' '}
                                  · p95{' '}
                                  {formatMetric({
                                    value: repetition.latency_p95_ms,
                                    unit: 'ms',
                                  })}
                                </li>
                              ))}
                            </ol>
                          </details>
                        </td>
                        <td>
                          {level.input_tokens} / {level.output_tokens}
                        </td>
                        <td>{formatMetric({ value: level.elapsed_seconds, unit: 's' })}</td>
                        <td>{formatMetric({ value: level.runtime_cost_usd, unit: 'usd' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
