import type { EvaluationReport } from '../../types/evaluationReport'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import EvaluationGateList from './EvaluationGateList'
import {
  evaluationPromotionVerdict,
  formatMetric,
  selectHeadlineMetrics,
} from './evaluationPresentation'
import { GateVerdictBadge } from './EvaluationPrimitives'
import styles from './EvaluationReportDecision.module.css'
import layoutStyles from './EvaluationReportLayout.module.css'

export default function EvaluationReportDecision({ report }: { report: EvaluationReport }) {
  const isDiagnostic = report.run.evidence_level === 'E0'
  const requiredGates = report.gates.filter((gate) => gate.disposition === 'required')
  const requiredPassed = requiredGates.filter((gate) => gate.verdict === 'pass').length
  const requiredFailed = requiredGates.filter((gate) => gate.verdict === 'fail').length
  const requiredUnavailable = requiredGates.filter((gate) => gate.verdict === 'unavailable').length
  const requiredBlockers = requiredGates.filter(
    (gate) => gate.verdict === 'fail' || gate.verdict === 'unavailable',
  )
  const promotionVerdict = evaluationPromotionVerdict(report)
  const headlines = selectHeadlineMetrics(report)

  return (
    <>
      <section className={layoutStyles.section} aria-labelledby="report-decision-title">
        <div className={layoutStyles.sectionHeader}>
          <div>
            <span className={layoutStyles.eyebrow}>Decision boundary</span>
            <h3 id="report-decision-title">
              {isDiagnostic
                ? 'Diagnostic evidence only'
                : requiredBlockers.length
                  ? 'Promotion needs attention'
                  : 'Required gates satisfied'}
            </h3>
            <p>
              {`${requiredPassed}/${requiredGates.length} required gates passed · ${requiredFailed} blocked · ${requiredUnavailable} need evidence`}
              {isDiagnostic ? ' · E0 cannot authorize promotion' : ''}
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
                  Server-reduced {report.run.evidence_level} ·{' '}
                  {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'}
                </span>
              </div>
            ))}
          </dl>
        ) : (
          <p className={layoutStyles.empty}>
            {isDiagnostic
              ? 'No independently reduced diagnostic headline applies to this run scope; inspect the metric explorer for the complete E0 observations.'
              : 'No measured headline aggregate applies to this run scope.'}
          </p>
        )}
      </section>

      {requiredBlockers.length ? (
        <section className={layoutStyles.section} aria-labelledby="report-blockers-title">
          <div className={layoutStyles.sectionHeader}>
            <div>
              <span className={layoutStyles.eyebrow}>Next evidence required</span>
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
