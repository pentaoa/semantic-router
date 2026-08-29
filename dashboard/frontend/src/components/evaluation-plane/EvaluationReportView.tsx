import type { EvaluationReport } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import useEvaluationReportDiagnostics from '../../hooks/useEvaluationReportDiagnostics'
import { formatDateTime } from '../../utils/dateTime'
import {
  getEvaluationArtifactURL,
  isDownloadableEvaluationArtifact,
} from '../../utils/evaluationPlaneApi'
import EvaluationGateList from './EvaluationGateList'
import EvaluationMetricTable from './EvaluationMetricTable'
import EvaluationReportDiagnostics from './EvaluationReportDiagnostics'
import { effectiveGateVerdict, formatMetric, selectHeadlineMetrics } from './evaluationPresentation'
import { CoverageBar, GateVerdictBadge, RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationReport.module.css'

function presentCount(value: number | undefined, suffix: string): string {
  return typeof value === 'number'
    ? `${new Intl.NumberFormat().format(value)} ${suffix}`
    : 'Not recorded'
}

export default function EvaluationReportView({ report }: { report: EvaluationReport }) {
  const summary = report.summary
  const gateContractVersion = report.gates[0]?.contract_version || 'not recorded'
  const requiredGates = report.gates.filter((gate) => gate.disposition === 'required')
  const requiredPassed = requiredGates.filter((gate) => gate.verdict === 'pass').length
  const requiredFailed = requiredGates.filter((gate) => gate.verdict === 'fail').length
  const requiredUnavailable = requiredGates.filter((gate) => gate.verdict === 'unavailable').length
  const requiredBlockers = requiredGates.filter(
    (gate) => gate.verdict === 'fail' || gate.verdict === 'unavailable',
  )
  const promotionVerdict = effectiveGateVerdict(summary.verdict, report.gates)
  const headlines = selectHeadlineMetrics(report)
  const diagnostics = useEvaluationReportDiagnostics(report)
  const isDiagnostic = report.run.evidence_level === 'E0'

  return (
    <article className={styles.report} aria-labelledby="evaluation-report-title">
      <section className={styles.reportHero}>
        <div className={styles.reportHeroCopy}>
          <span className={styles.eyebrow}>Evidence report · {report.schema_version}</span>
          <h2 id="evaluation-report-title">{report.run.name}</h2>
          <p>{report.run.description || 'No experiment description was recorded.'}</p>
          <div className={styles.heroBadges}>
            <RunStatusBadge status={report.run.status} />
            <GateVerdictBadge verdict={promotionVerdict} disposition="required" />
            <span>{report.run.evidence_level} evidence</span>
            <span>{report.run.mode}</span>
            <span>{report.run.change_profile}</span>
          </div>
        </div>
        <CoverageBar coverage={summary.coverage} />
      </section>

      {isDiagnostic ? (
        <div className={styles.claimNotice} role="status">
          <strong>Promotion summary withheld — diagnostic E0</strong>
          <span>
            Measured diagnostics below remain valid for debugging. They do not reproduce each native
            benchmark reducer or carry the receipts required for a promotion claim.
          </span>
        </div>
      ) : null}

      <section className={styles.section} aria-labelledby="report-decision-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Decision boundary</span>
            <h3 id="report-decision-title">
              {requiredBlockers.length ? 'Promotion needs attention' : 'Required gates satisfied'}
            </h3>
            <p>
              {requiredPassed}/{requiredGates.length} required gates passed · {requiredFailed}{' '}
              blocked · {requiredUnavailable} need evidence
            </p>
          </div>
          <GateVerdictBadge verdict={promotionVerdict} disposition="required" />
        </div>
        {headlines.length ? (
          <dl className={styles.headlineStrip}>
            {headlines.map((metric) => (
              <div key={`${metric.track_id || 'system'}-${metric.id}`}>
                <dt>{metric.name}</dt>
                <dd>{formatMetric(metric)}</dd>
                <span>
                  {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'}
                </span>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.empty}>No measured headline aggregate applies to this run scope.</p>
        )}
      </section>

      {requiredBlockers.length ? (
        <section className={styles.section} aria-labelledby="report-blockers-title">
          <div className={styles.sectionHeader}>
            <div>
              <span className={styles.eyebrow}>Next evidence required</span>
              <h3 id="report-blockers-title">Required blockers</h3>
              <p>Specific rationale is shown first; generic gate descriptions remain secondary.</p>
            </div>
            <span>{requiredBlockers.length} blockers</span>
          </div>
          <EvaluationGateList gates={requiredBlockers} />
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="report-metrics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Measured outcomes</span>
            <h3 id="report-metrics-title">Metric explorer</h3>
            <p>
              Search by metric ID or track; direction, paired delta, interval, and sample size stay
              visible.
            </p>
          </div>
          <span>{report.metrics.length} aggregates</span>
        </div>
        <EvaluationMetricTable metrics={report.metrics} />
      </section>

      <section className={styles.section} aria-labelledby="report-diagnostics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Verified artifacts</span>
            <h3 id="report-diagnostics-title">Execution diagnostics</h3>
            <p>Outcome accounting and bounded capacity observations load independently.</p>
          </div>
        </div>
        <EvaluationReportDiagnostics {...diagnostics} />
      </section>

      <section className={styles.section} aria-labelledby="report-tracks-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Scope decomposition</span>
            <h3 id="report-tracks-title">Track observations</h3>
          </div>
          <span>{report.tracks.length} selected tracks</span>
        </div>
        <div className={styles.tableScroll}>
          <table className={styles.compactTable}>
            <caption>Observation state and coverage by selected evaluation track</caption>
            <thead>
              <tr>
                <th scope="col">Track</th>
                <th scope="col">Observation</th>
                <th scope="col">Coverage</th>
                <th scope="col">Evidence</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {report.tracks.map((track) => (
                <tr key={track.track_id}>
                  <th scope="row">{TRACK_PRESENTATION[track.track_id].label}</th>
                  <td>
                    <RunStatusBadge status={track.status} />
                  </td>
                  <td>{Math.round(track.coverage.fraction * 100)}%</td>
                  <td>{track.evidence_level}</td>
                  <td>{track.error || track.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className={styles.disclosure}>
        <summary>
          All promotion gates <span>{report.gates.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <EvaluationGateList gates={report.gates} />
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Cost ledgers <span>3 ledgers</span>
        </summary>
        <div className={styles.disclosureBody}>
          <div className={styles.ledgerGrid}>
            {Object.entries(report.costs).map(([name, ledger]) => (
              <article key={name}>
                <span>{name.replace(/_/g, ' ')}</span>
                <strong>
                  {formatMetric({ value: ledger.amount, unit: ledger.currency.toLowerCase() })}
                </strong>
                <small>
                  {presentCount(ledger.input_tokens, 'input tokens')} ·{' '}
                  {presentCount(ledger.output_tokens, 'output tokens')}
                  {typeof ledger.gpu_seconds === 'number'
                    ? ` · ${ledger.gpu_seconds.toFixed(1)} GPU seconds`
                    : ''}
                  {typeof ledger.energy_kwh === 'number'
                    ? ` · ${ledger.energy_kwh.toFixed(2)} kWh`
                    : ''}
                </small>
              </article>
            ))}
          </div>
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Diagnostic findings <span>{report.recommendations.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <p className={styles.scopeCopy}>
            These are rule-derived diagnostic findings, not benchmark-native causal conclusions.
          </p>
          {report.recommendations.length ? (
            <ol className={styles.recommendations}>
              {report.recommendations.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>No diagnostic findings were generated.</p>
          )}
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Provenance and reproducibility <span>{gateContractVersion}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <dl className={styles.provenance}>
            <div>
              <dt>Generated</dt>
              <dd>{formatDateTime(report.provenance.generated_at)}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>
                <code>{report.provenance.target_id}</code>
              </dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd>{report.provenance.seed}</dd>
            </div>
            <div>
              <dt>Gate contract</dt>
              <dd>
                <code>{gateContractVersion}</code>
              </dd>
            </div>
            <div>
              <dt>Code revision</dt>
              <dd>
                <code>{report.provenance.code_revision || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Workload snapshot</dt>
              <dd>
                <code>{report.provenance.workload_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Policy snapshot</dt>
              <dd>
                <code>{report.provenance.policy_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Policy binding</dt>
              <dd>
                <code>{report.provenance.binding_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Pool snapshot</dt>
              <dd>
                <code>{report.provenance.pool_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>
                <code>{report.provenance.environment_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Redaction</dt>
              <dd>{report.provenance.redaction_policy || 'Not recorded'}</dd>
            </div>
            <div className={styles.provenanceWide}>
              <dt>Benchmark revisions</dt>
              <dd>
                {Object.entries(report.provenance.benchmark_revisions || {}).length
                  ? Object.entries(report.provenance.benchmark_revisions || {}).map(
                      ([name, revision]) => (
                        <span key={name}>
                          {name}: <code>{revision}</code>
                        </span>
                      ),
                    )
                  : 'Not recorded'}
              </dd>
            </div>
          </dl>
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Evidence artifacts <span>{report.artifacts.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          {report.artifacts.length ? (
            <div className={styles.artifactList}>
              {report.artifacts.map((artifact) => (
                <article key={artifact.id}>
                  <div>
                    <strong>{artifact.name}</strong>
                    <span>
                      {artifact.kind} · {artifact.media_type || 'media type not recorded'}
                    </span>
                  </div>
                  {isDownloadableEvaluationArtifact(artifact) ? (
                    <a
                      href={getEvaluationArtifactURL(report.run.id, artifact.id)}
                      aria-label={`Download ${artifact.name}`}
                    >
                      Download
                    </a>
                  ) : (
                    <code>{artifact.digest || artifact.id}</code>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className={styles.empty}>No report artifacts were recorded.</p>
          )}
        </div>
      </details>
    </article>
  )
}
