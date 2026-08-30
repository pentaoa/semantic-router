import type { EvaluationReport } from '../../types/evaluationReport'
import useEvaluationReportDiagnostics from '../../hooks/useEvaluationReportDiagnostics'
import EvaluationMetricTable from './EvaluationMetricTable'
import EvaluationMixtureReport from './EvaluationMixtureReport'
import EvaluationReportDecision from './EvaluationReportDecision'
import EvaluationReportDiagnostics from './EvaluationReportDiagnostics'
import EvaluationReportDisclosures from './EvaluationReportDisclosures'
import EvaluationReportTracks from './EvaluationReportTracks'
import { evaluationPromotionVerdict } from './evaluationPresentation'
import { CoverageBar, GateVerdictBadge, RunStatusBadge } from './EvaluationPrimitives'
import heroStyles from './EvaluationReportHero.module.css'
import styles from './EvaluationReportLayout.module.css'

export default function EvaluationReportView({ report }: { report: EvaluationReport }) {
  const diagnostics = useEvaluationReportDiagnostics(report)
  const isDiagnostic = report.run.evidence_level === 'E0'

  return (
    <article className={styles.report} aria-labelledby="evaluation-report-title">
      <section className={heroStyles.reportHero}>
        <div className={heroStyles.reportHeroCopy}>
          <span className={styles.eyebrow}>Evidence report · {report.schema_version}</span>
          <h2 id="evaluation-report-title">{report.run.name}</h2>
          <p>{report.run.description || 'No experiment description was recorded.'}</p>
          <div className={heroStyles.heroBadges}>
            <RunStatusBadge status={report.run.status} />
            <GateVerdictBadge verdict={evaluationPromotionVerdict(report)} disposition="required" />
            <span>{report.run.evidence_level} evidence</span>
            <span>{report.run.mode}</span>
            <span>{report.run.change_profile}</span>
            <span>{report.attestation_revision}</span>
          </div>
        </div>
        <div>
          <CoverageBar coverage={report.summary.coverage} />
          <p className={styles.scopeCopy}>Server-attested coverage.</p>
        </div>
      </section>

      {isDiagnostic ? (
        <div className={heroStyles.claimNotice} role="status">
          <strong>Promotion summary withheld — server-attested diagnostic E0</strong>
          <span>
            Independently reduced diagnostics below remain valid for debugging. Deterministic
            parsing of an imported export proves its normalized bytes, not that upstream benchmark
            code generated them. Without a server-owned native-run receipt, imported evidence cannot
            qualify a release gate or promotion claim.
          </span>
        </div>
      ) : null}

      <EvaluationMixtureReport report={report} />
      <EvaluationReportDecision report={report} />

      <section className={styles.section} aria-labelledby="report-metrics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Measured outcomes</span>
            <h3 id="report-metrics-title">Metric explorer</h3>
            <p>
              Server-reduced {report.run.evidence_level} metrics are identified explicitly; every
              other worker-derived aggregate remains inspectable as diagnostic evidence.
            </p>
          </div>
          <span>{report.metrics.length} aggregates</span>
        </div>
        <EvaluationMetricTable metrics={report.metrics} evidenceLevel={report.run.evidence_level} />
      </section>

      <section className={styles.section} aria-labelledby="report-diagnostics-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Verified artifacts</span>
            <h3 id="report-diagnostics-title">Execution diagnostics</h3>
            <p>
              Server-attested outcome accounting and bounded capacity observations load
              independently.
            </p>
          </div>
        </div>
        <EvaluationReportDiagnostics {...diagnostics} />
      </section>

      <EvaluationReportTracks report={report} />
      <EvaluationReportDisclosures report={report} />
    </article>
  )
}
