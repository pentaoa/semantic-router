import type { EvaluationCatalogTarget } from '../../types/evaluationPlane'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import noticeStyles from './EvaluationExperimentNotice.module.css'
import styles from './EvaluationExperimentMixture.module.css'

function shortDigest(value: string): string {
  return `${value.slice(0, 14)}…${value.slice(-8)}`
}

export default function EvaluationExperimentMixture({
  target,
  form,
}: {
  target: EvaluationCatalogTarget | undefined
  form: EvaluationExperimentFormModel
}) {
  if (form.mode !== 'live') return null
  const mixture = target?.mixture
  if (!mixture) {
    return (
      <div className={`${noticeStyles.contractWarning} ${styles.fieldWide}`} role="status">
        Select an available Mixture-of-Models target. Live tasks cannot infer or substitute an
        entrypoint at execution time.
      </div>
    )
  }

  const armsByID = new Map(mixture.model_arms.map((arm) => [arm.id, arm]))

  return (
    <>
      {target?.healthy === false ? (
        <div className={`${noticeStyles.contractWarning} ${styles.fieldWide}`} role="alert">
          This Mixture is visible but not executable. Complete its model backends and Evaluation
          runtime connectivity before starting a live task.
        </div>
      ) : null}
      <details
        className={`${styles.mixtureSnapshot} ${styles.fieldWide}`}
        aria-label="Frozen Mixture"
      >
        <summary className={styles.mixtureHeader}>
          <span className={styles.mixtureSummaryCopy}>
            <span className={styles.mixtureLabel}>Selected Mixture-of-Models</span>
            <strong>{mixture.entrypoint_model}</strong>
            <small>
              Recipe <code>{mixture.recipe_name}</code> and its reachable pool will be frozen into
              the run manifest.
            </small>
          </span>
          <span className={styles.mixtureFacts}>
            <span>
              {mixture.model_arms.length} pool {mixture.model_arms.length === 1 ? 'arm' : 'arms'}
            </span>
            <span>
              {mixture.decisions.length} {mixture.decisions.length === 1 ? 'decision' : 'decisions'}
            </span>
            <span>
              {mixture.aliases.length} public {mixture.aliases.length === 1 ? 'name' : 'names'}
            </span>
          </span>
        </summary>

        <div className={styles.mixtureColumns}>
          <div>
            <span className={styles.mixtureLabel}>Recipe decisions</span>
            <div className={styles.decisionList}>
              {mixture.decisions.map((decision) => (
                <article key={decision.name}>
                  <div>
                    <strong>{decision.name}</strong>
                    <code>{decision.algorithm}</code>
                    <small>
                      {decision.arm_ids
                        .map((armID) => armsByID.get(armID)?.model || armID)
                        .join(' · ')}
                    </small>
                  </div>
                  <span>{decision.arm_ids.length} eligible arms</span>
                </article>
              ))}
            </div>
          </div>
          <div>
            <span className={styles.mixtureLabel}>Model pool</span>
            <div className={styles.armList}>
              {mixture.model_arms.map((arm) => (
                <article key={arm.id}>
                  <strong>{arm.model}</strong>
                  <span>
                    Arm {arm.id} · {(arm.modalities || ['text']).join(' · ')}
                    {arm.parameter_size ? ` · ${arm.parameter_size}` : ''}
                  </span>
                  <small>
                    ${arm.input_cost_per_million_tokens_usd.toLocaleString()}/M in · $
                    {arm.output_cost_per_million_tokens_usd.toLocaleString()}/M out
                  </small>
                </article>
              ))}
            </div>
            {mixture.support_models.length ? (
              <p className={styles.supportModels}>
                Decision support only (not scored as pool arms):{' '}
                {mixture.support_models.map((model) => model.model).join(' · ')}
              </p>
            ) : null}
          </div>
        </div>

        <footer className={styles.mixtureLineage}>
          <span>
            Recipe <code title={mixture.recipe_digest}>{shortDigest(mixture.recipe_digest)}</code>
          </span>
          <span>
            Pool <code title={mixture.pool_digest}>{shortDigest(mixture.pool_digest)}</code>
          </span>
          <span>
            Selector{' '}
            <code title={mixture.selector_digest}>{shortDigest(mixture.selector_digest)}</code>
          </span>
          <span>
            Adaptation{' '}
            <code title={mixture.adaptation_digest}>{shortDigest(mixture.adaptation_digest)}</code>
          </span>
          <span>
            Binding{' '}
            <code title={mixture.binding_digest}>{shortDigest(mixture.binding_digest)}</code>
          </span>
        </footer>
      </details>
    </>
  )
}
