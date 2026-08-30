import type { EvaluationChangeProfileId, EvaluationCatalog } from '../../types/evaluationPlane'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import EvaluationExperimentSectionHeading from './EvaluationExperimentSectionHeading'
import styles from './EvaluationExperimentGateScope.module.css'
import noticeStyles from './EvaluationExperimentNotice.module.css'
import sectionStyles from './EvaluationExperimentSection.module.css'

interface EvaluationExperimentGateScopeProps {
  catalog: EvaluationCatalog
  form: EvaluationExperimentFormModel
}

export default function EvaluationExperimentGateScope({
  catalog,
  form,
}: EvaluationExperimentGateScopeProps) {
  const requiredGates = form.gateApplicability.filter(
    (gate) => gate.disposition === 'required',
  ).length
  const advisoryGates = form.gateApplicability.filter(
    (gate) => gate.disposition === 'advisory',
  ).length
  return (
    <section className={sectionStyles.formSection}>
      <EvaluationExperimentSectionHeading
        index="02"
        title="Change profile and G0–G9 contract"
        description="The profile defines which release gates are required, advisory, or not applicable."
      />
      <div className={styles.profileHeader}>
        <label>
          Change profile
          <select
            value={form.changeProfile}
            disabled={form.baselineLocked}
            onChange={(event) =>
              form.setChangeProfile(event.target.value as EvaluationChangeProfileId)
            }
            required
          >
            <option value="">Select profile</option>
            {catalog.change_profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <small>
            {form.selectedChangeProfile?.description ||
              'Only server-declared change profiles are selectable.'}
          </small>
        </label>
        <div>
          <span>Gate contract</span>
          <code>{catalog.gate_contract_version}</code>
        </div>
      </div>
      {form.gateApplicability.length ? (
        <details className={styles.gateDisclosure}>
          <summary>
            <span>Review G0–G9 applicability</span>
            <small>
              {requiredGates} required · {advisoryGates} advisory ·{' '}
              {form.gateApplicability.length - requiredGates - advisoryGates} not applicable
            </small>
          </summary>
          <div className={styles.gateMatrix} aria-label="G0–G9 gate applicability">
            {form.gateApplicability.map((gate) => (
              <article key={gate.id} data-disposition={gate.disposition}>
                <div>
                  <code>{gate.id}</code>
                  <strong>{gate.name}</strong>
                </div>
                <span>{gate.disposition.replace('_', ' ')}</span>
                <small>{gate.description}</small>
              </article>
            ))}
          </div>
        </details>
      ) : (
        <div className={noticeStyles.contractWarning} role="status">
          This dashboard cannot explain applicability for gate contract{' '}
          <code>{catalog.gate_contract_version}</code>. The server report remains authoritative.
        </div>
      )}
    </section>
  )
}
