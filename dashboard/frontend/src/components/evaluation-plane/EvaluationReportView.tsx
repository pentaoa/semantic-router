import type { EvaluationReport, EvaluationRun } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import useEvaluationReportDiagnostics from '../../hooks/useEvaluationReportDiagnostics'
import { formatDateTime } from '../../utils/dateTime'
import {
  getEvaluationArtifactURL,
  isDownloadableEvaluationArtifact,
} from '../../utils/evaluationPlaneApi'
import EvaluationGateList from './EvaluationGateList'
import EvaluationMetricTable from './EvaluationMetricTable'
import EvaluationReportDecision from './EvaluationReportDecision'
import EvaluationReportDiagnostics from './EvaluationReportDiagnostics'
import {
  evaluationGatesForPresentation,
  evaluationPromotionVerdict,
  formatMetric,
  hasServerEvaluationAttestation,
  legacyEvaluationEvidenceLabel,
} from './evaluationPresentation'
import { CoverageBar, GateVerdictBadge, RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationReport.module.css'

function presentCount(value: number | undefined, suffix: string): string {
  return typeof value === 'number'
    ? `${new Intl.NumberFormat().format(value)} ${suffix}`
    : 'Not recorded'
}

export default function EvaluationReportView({
  report,
  displayRun,
}: {
  report: EvaluationReport
  displayRun?: EvaluationRun
}) {
  const summary = report.summary
  const gateContractVersion = report.gates[0]?.contract_version || 'not recorded'
  const serverAttested = hasServerEvaluationAttestation(report)
  const isLegacyReport = !serverAttested
  const displayGates = evaluationGatesForPresentation(report, report.gates)
  const promotionVerdict = evaluationPromotionVerdict(report)
  const diagnostics = useEvaluationReportDiagnostics(report)
  const isDiagnostic = report.run.evidence_level === 'E0'
  const legacyEvidenceLabel = legacyEvaluationEvidenceLabel(report.run.evidence_level)

  return (
    <article className={styles.report} aria-labelledby="evaluation-report-title">
      <section className={styles.reportHero}>
        <div className={styles.reportHeroCopy}>
          <span className={styles.eyebrow}>Evidence report · {report.schema_version}</span>
          <h2 id="evaluation-report-title">{displayRun?.name || report.run.name}</h2>
          <p>
            {displayRun?.description ||
              report.run.description ||
              'No experiment description was recorded.'}
          </p>
          <div className={styles.heroBadges}>
            <RunStatusBadge status={report.run.status} />
            <GateVerdictBadge verdict={promotionVerdict} disposition="required" />
            <span>{report.run.evidence_level} evidence</span>
            <span>{report.run.mode}</span>
            <span>{report.run.change_profile}</span>
            <span>{serverAttested ? 'Server attestation v2' : legacyEvidenceLabel}</span>
          </div>
        </div>
        <div>
          <CoverageBar coverage={summary.coverage} />
          <p className={styles.scopeCopy}>
            {serverAttested ? 'Server-attested coverage.' : `${legacyEvidenceLabel} coverage.`}
          </p>
        </div>
      </section>

      {isDiagnostic || isLegacyReport ? (
        <div className={styles.claimNotice} role="status">
          <strong>
            {isLegacyReport
              ? legacyEvidenceLabel
              : 'Promotion summary withheld — server-attested diagnostic E0'}
          </strong>
          <span>
            {isLegacyReport
              ? 'This historical report remains readable for debugging. No metric is elevated, and its coverage, track, cost, capacity, and artifact data must not be treated as server-attested evidence.'
              : 'Independently reduced diagnostics below remain valid for debugging. They do not reproduce each native benchmark reducer or carry the receipts required for a promotion claim.'}
          </span>
        </div>
      ) : null}

      <EvaluationReportDecision report={report} />

      <section className={styles.section} aria-labelledby="report-metrics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Measured outcomes</span>
            <h3 id="report-metrics-title">Metric explorer</h3>
            <p>
              {isLegacyReport
                ? 'Every legacy aggregate remains inspectable as integrity-only evidence, including direction, paired delta, interval, and sample size.'
                : serverAttested
                  ? `Server-reduced ${report.run.evidence_level} metrics are identified explicitly; every other worker-derived aggregate remains inspectable as diagnostic evidence.`
                  : 'Search by metric ID or track; direction, paired delta, interval, and sample size stay visible.'}
            </p>
          </div>
          <span>{report.metrics.length} aggregates</span>
        </div>
        <EvaluationMetricTable
          metrics={report.metrics}
          evidenceLevel={report.run.evidence_level}
          serverAttested={serverAttested}
        />
      </section>

      <section className={styles.section} aria-labelledby="report-diagnostics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>
              {serverAttested
                ? 'Verified artifacts'
                : isLegacyReport
                  ? 'Legacy artifacts · integrity-only'
                  : 'Reported artifacts · attestation not recorded'}
            </span>
            <h3 id="report-diagnostics-title">Execution diagnostics</h3>
            <p>
              {serverAttested
                ? 'Server-attested outcome accounting and bounded capacity observations load independently.'
                : 'Outcome accounting and bounded capacity observations remain readable diagnostics, not server-attested evidence.'}
            </p>
          </div>
        </div>
        <EvaluationReportDiagnostics
          {...diagnostics}
          serverAttested={serverAttested}
          integrityOnly={isLegacyReport}
          evidenceLevel={report.run.evidence_level}
        />
      </section>

      <section className={styles.section} aria-labelledby="report-tracks-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>
              {serverAttested
                ? 'Verified track scope'
                : isLegacyReport
                  ? 'Legacy track scope · integrity-only'
                  : 'Reported track scope · attestation not recorded'}
            </span>
            <h3 id="report-tracks-title">Track observations</h3>
            <p>
              {serverAttested
                ? 'Track status and coverage are bound to the server attestation.'
                : 'Track status and coverage are report-declared diagnostics without a server attestation.'}
            </p>
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
                  <td>
                    {track.coverage.evaluated}/{track.coverage.total} ·{' '}
                    {Math.round(track.coverage.fraction * 100)}%
                    {track.coverage.unavailable
                      ? ` · ${track.coverage.unavailable} not measured`
                      : ''}
                  </td>
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
          <EvaluationGateList gates={displayGates} />
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          {serverAttested
            ? 'Verified cost ledgers'
            : isLegacyReport
              ? 'Legacy cost ledgers · integrity-only'
              : 'Reported cost ledgers'}{' '}
          <span>3 ledgers</span>
        </summary>
        <div className={styles.disclosureBody}>
          <p className={styles.scopeCopy}>
            {serverAttested
              ? 'Cost aggregates are bound to the server attestation.'
              : 'Cost aggregates remain readable, but server attestation was not recorded.'}
          </p>
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
            These are worker-derived rule-based diagnostics, not server-reduced or benchmark-native
            causal conclusions.
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
              <dt>Server attestation</dt>
              <dd>
                <code>{report.attestation_revision || 'Not recorded'}</code>
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
