import type { EvaluationReport } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import EvaluationGateList from './EvaluationGateList'
import {
  evaluationGatesForPresentation,
  evaluationPromotionVerdict,
  formatMetric,
  hasServerEvaluationAttestation,
  selectHeadlineMetrics,
} from './evaluationPresentation'
import { GateVerdictBadge } from './EvaluationPrimitives'
import styles from './EvaluationReport.module.css'

export default function EvaluationReportDecision({ report }: { report: EvaluationReport }) {
  const serverAttested = hasServerEvaluationAttestation(report)
  const isLegacyReport = !serverAttested
  const isDiagnostic = report.run.evidence_level === 'E0'
  const displayGates = evaluationGatesForPresentation(report, report.gates)
  const requiredGates = displayGates.filter((gate) => gate.disposition === 'required')
  const requiredPassed = serverAttested
    ? requiredGates.filter((gate) => gate.verdict === 'pass').length
    : 0
  const requiredFailed = serverAttested
    ? requiredGates.filter((gate) => gate.verdict === 'fail').length
    : 0
  const requiredUnavailable = serverAttested
    ? requiredGates.filter((gate) => gate.verdict === 'unavailable').length
    : Math.max(1, requiredGates.length)
  const requiredBlockers = serverAttested
    ? requiredGates.filter((gate) => gate.verdict === 'fail' || gate.verdict === 'unavailable')
    : []
  const promotionVerdict = evaluationPromotionVerdict(report)
  const headlines = selectHeadlineMetrics(report)

  return (
    <>
      <section className={styles.section} aria-labelledby="report-decision-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>Decision boundary</span>
            <h3 id="report-decision-title">
              {isLegacyReport
                ? 'Current attestation required'
                : requiredBlockers.length
                  ? 'Promotion needs attention'
                  : 'Required gates satisfied'}
            </h3>
            <p>
              {isLegacyReport
                ? requiredGates.length
                  ? `0/${requiredGates.length} reported required gate verdicts are trusted · ${requiredUnavailable} need current attestation`
                  : 'No reported gate verdict is trusted · current attestation evidence needed'
                : `${requiredPassed}/${requiredGates.length} required gates passed · ${requiredFailed} blocked · ${requiredUnavailable} need evidence`}
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
                  {serverAttested ? `Server-reduced ${report.run.evidence_level} · ` : ''}
                  {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'}
                </span>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.empty}>
            {isLegacyReport
              ? 'Headline elevation is withheld for this legacy integrity-only report; inspect the complete metric explorer for all reported observations.'
              : isDiagnostic
                ? 'No independently reduced diagnostic headline applies to this run scope; inspect the metric explorer for the complete E0 observations.'
                : 'No measured headline aggregate applies to this run scope.'}
          </p>
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
    </>
  )
}
