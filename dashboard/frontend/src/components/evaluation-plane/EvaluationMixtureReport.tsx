import type { EvaluationMetric, EvaluationReport } from '../../types/evaluationReport'
import { formatMetric } from './evaluationPresentation'
import styles from './EvaluationMixtureReport.module.css'
import layoutStyles from './EvaluationReportLayout.module.css'

function metricByID(metrics: EvaluationMetric[], id: string): EvaluationMetric | undefined {
  return metrics.find((metric) => metric.id === id)
}

function MetricReading({ metric }: { metric: EvaluationMetric | undefined }) {
  return metric?.value !== null && typeof metric?.value === 'number' ? (
    <strong>{formatMetric(metric)}</strong>
  ) : (
    <strong className={styles.mixtureMissing}>Not measured</strong>
  )
}

function OutcomeLayer({
  eyebrow,
  title,
  description,
  readings,
}: {
  eyebrow: string
  title: string
  description: string
  readings: Array<{ label: string; metric: EvaluationMetric | undefined }>
}) {
  return (
    <article className={styles.mixtureOutcomeLayer}>
      <span>{eyebrow}</span>
      <h4>{title}</h4>
      <p>{description}</p>
      <dl>
        {readings.map((reading) => (
          <div key={reading.label}>
            <dt>{reading.label}</dt>
            <dd>
              <MetricReading metric={reading.metric} />
            </dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

export default function EvaluationMixtureReport({ report }: { report: EvaluationReport }) {
  const mixture = report.run.mixture
  if (!mixture) return null

  const metrics = report.metrics
  const decisionsByArm = new Map<string, string[]>()
  const armsByID = new Map(mixture.model_arms.map((arm) => [arm.id, arm]))
  for (const decision of mixture.decisions) {
    for (const armID of decision.arm_ids) {
      decisionsByArm.set(armID, [...(decisionsByArm.get(armID) || []), decision.name])
    }
  }

  return (
    <section className={layoutStyles.section} aria-labelledby="mixture-report-title">
      <div className={layoutStyles.sectionHeader}>
        <div>
          <span className={layoutStyles.eyebrow}>Evaluated system boundary</span>
          <h3 id="mixture-report-title">{mixture.entrypoint_model}</h3>
          <p>
            One frozen cohort measured recipe decisions, every reachable model arm, and the routed
            system outcome. The snapshot below is the subject that actually ran—not the current
            configuration.
          </p>
        </div>
        <div className={styles.mixtureSubjectFacts}>
          <span>
            {mixture.model_arms.length} model {mixture.model_arms.length === 1 ? 'arm' : 'arms'}
          </span>
          <span>
            {mixture.decisions.length} {mixture.decisions.length === 1 ? 'decision' : 'decisions'}
          </span>
          <span>
            {mixture.aliases.length} entrypoint {mixture.aliases.length === 1 ? 'name' : 'names'}
          </span>
        </div>
      </div>

      <div className={styles.mixtureOutcomeGrid}>
        <OutcomeLayer
          eyebrow="01 · Routing recipe"
          title={mixture.recipe_name}
          description="Does the recipe select an eligible model for the right reason?"
          readings={[
            { label: 'Decision accuracy', metric: metricByID(metrics, 'routing.accuracy') },
            { label: 'Coverage', metric: metricByID(metrics, 'routing.coverage') },
            { label: 'Fallback rate', metric: metricByID(metrics, 'routing.fallback_rate') },
          ]}
        />
        <OutcomeLayer
          eyebrow="02 · Model pool"
          title="Capability frontier"
          description="How good and complementary are the frozen arms before routing?"
          readings={[
            { label: 'Pool oracle', metric: metricByID(metrics, 'model_pool.oracle_quality') },
            {
              label: 'Best single arm',
              metric: metricByID(metrics, 'model_pool.best_single_quality'),
            },
            { label: 'Pool gain', metric: metricByID(metrics, 'model_pool.oracle_gain') },
          ]}
        />
        <OutcomeLayer
          eyebrow="03 · Routed system"
          title="Realized utility"
          description="How much of the pool frontier does the recipe capture in practice?"
          readings={[
            { label: 'Realized quality', metric: metricByID(metrics, 'joint.realized_quality') },
            { label: 'Normalized regret', metric: metricByID(metrics, 'joint.normalized_regret') },
            { label: 'Oracle capture', metric: metricByID(metrics, 'joint.oracle_capture_ratio') },
          ]}
        />
      </div>

      <p className={styles.mixtureReadingGuide}>
        Read left to right: the recipe chooses, the dense arm matrix establishes the pool ceiling,
        and the routed call measures how much of that ceiling the system realizes. “Not measured”
        means the selected cohort did not produce that aggregate; the dashboard never substitutes a
        different target.
      </p>

      <div className={styles.mixtureDetailGrid}>
        <div>
          <div className={styles.mixtureSubheading}>
            <div>
              <span>Recipe topology</span>
              <strong>Decision → eligible arms</strong>
            </div>
            <code>{mixture.recipe_digest.slice(0, 18)}…</code>
          </div>
          <div className={styles.mixtureDecisionMap}>
            {mixture.decisions.map((decision) => (
              <article key={decision.name}>
                <div>
                  <strong>{decision.name}</strong>
                  <code>{decision.algorithm}</code>
                </div>
                <span>
                  {decision.arm_ids.map((armID) => armsByID.get(armID)?.model || armID).join(' · ')}
                </span>
              </article>
            ))}
          </div>
          {mixture.support_models.length ? (
            <p className={styles.mixtureSupportModels}>
              <strong>Decision support models (not pool arms)</strong>
              <span>{mixture.support_models.map((model) => model.model).join(' · ')}</span>
            </p>
          ) : null}
        </div>

        <div>
          <div className={styles.mixtureSubheading}>
            <div>
              <span>Frozen model pool</span>
              <strong>Per-arm outcome matrix</strong>
            </div>
            <code>{mixture.pool_digest.slice(0, 18)}…</code>
          </div>
          <div className={styles.mixtureArmMatrix}>
            {mixture.model_arms.map((arm) => {
              const quality = metricByID(metrics, `model_pool.arm.${arm.id}.quality`)
              const success = metricByID(metrics, `model_pool.arm.${arm.id}.success_rate`)
              const contribution = metricByID(
                metrics,
                `model_pool.arm.${arm.id}.marginal_contribution`,
              )
              return (
                <article key={arm.id}>
                  <header>
                    <div>
                      <strong>{arm.model}</strong>
                      <span>
                        Arm {arm.id} · {(arm.modalities || ['text']).join(' · ')}
                      </span>
                    </div>
                    {mixture.fallback_arm_id === arm.id ? <em>Fallback</em> : null}
                  </header>
                  <dl>
                    <div>
                      <dt>Quality</dt>
                      <dd>
                        <MetricReading metric={quality} />
                      </dd>
                    </div>
                    <div>
                      <dt>Success</dt>
                      <dd>
                        <MetricReading metric={success} />
                      </dd>
                    </div>
                    <div>
                      <dt>Marginal gain</dt>
                      <dd>
                        <MetricReading metric={contribution} />
                      </dd>
                    </div>
                  </dl>
                  <footer>
                    <span>{(decisionsByArm.get(arm.id) || []).join(' · ') || 'Pool-only arm'}</span>
                    <span>
                      ${arm.input_cost_per_million_tokens_usd.toLocaleString()}/M in · $
                      {arm.output_cost_per_million_tokens_usd.toLocaleString()}/M out
                    </span>
                  </footer>
                </article>
              )
            })}
          </div>
        </div>
      </div>

      <div className={styles.mixtureLineageStrip}>
        <span>
          Recipe <code title={mixture.recipe_digest}>{mixture.recipe_digest}</code>
        </span>
        <span>
          Pool <code title={mixture.pool_digest}>{mixture.pool_digest}</code>
        </span>
        <span>
          Selector <code title={mixture.selector_digest}>{mixture.selector_digest}</code>
        </span>
        <span>
          Adaptation <code title={mixture.adaptation_digest}>{mixture.adaptation_digest}</code>
        </span>
        <span>
          Binding <code title={mixture.binding_digest}>{mixture.binding_digest}</code>
        </span>
      </div>
    </section>
  )
}
