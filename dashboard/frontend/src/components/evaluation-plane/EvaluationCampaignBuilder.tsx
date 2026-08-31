import type {
  CreateEvaluationCampaignPayload,
  EvaluationCampaign,
} from '../../types/evaluationCampaign'
import type {
  EvaluationCampaignGateID,
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationRun,
} from '../../types/evaluationPlane'
import { buildEvaluationCampaignRequest, campaignSlotRunIDs } from './evaluationCampaignSupport'
import type { EvaluationCampaignBuilderModel } from './useEvaluationCampaignBuilder'
import EvaluationCampaignControlledPair from './EvaluationCampaignControlledPair'
import { EvaluationActionButton } from './EvaluationPrimitives'
import commonStyles from './EvaluationCampaign.module.css'
import styles from './EvaluationCampaignBuilder.module.css'

const RUN_BINDING_KEYS = {
  G2: 'g2_run_id',
  G4: 'g4_run_id',
  G6: 'g6_run_id',
  G7: 'g7_run_id',
  G8: 'g8_run_id',
  G9: 'g9_run_id',
} as const

function runLabel(run: EvaluationRun): string {
  return `${run.name} · ${run.mode} · ${run.evidence_level} · n=${run.sample_limit}`
}

function slotDisposition(slot: EvaluationCatalogCampaignSlot): string {
  if (slot.disposition === 'required') return 'Required'
  if (slot.disposition === 'advisory') return 'Advisory · optional'
  if (slot.disposition === 'waived') return 'Waived'
  return 'Not applicable'
}

function SlotBinding({
  slot,
  runs,
  model,
  disabled,
}: {
  slot: EvaluationCatalogCampaignSlot
  runs: EvaluationRun[]
  model: EvaluationCampaignBuilderModel
  disabled: boolean
}) {
  const inactive = slot.disposition === 'not_applicable' || slot.disposition === 'waived'

  if (inactive)
    return <output aria-label={`${slot.gate_id} evidence`}>No evidence requested</output>
  if (slot.binding_kind === 'controlled_pair') {
    const pair = model.draft.gateBindings.g3_controlled_pair
    return (
      <output aria-label="G3 controlled pair evidence">
        {pair
          ? `${runs.find((run) => run.id === pair.baseline_run_id)?.name || pair.baseline_run_id} → ${runs.find((run) => run.id === pair.candidate_run_id)?.name || pair.candidate_run_id}`
          : 'Launch the controlled pair below'}
      </output>
    )
  }
  if (slot.binding_kind === 'fidelity_pair') {
    const binding = model.draft.gateBindings.g5_fidelity
    return (
      <div className={styles.pairInputs}>
        <label>
          <span className={commonStyles.srOnly}>G5 fidelity reference</span>
          <select
            aria-label="G5 fidelity reference"
            value={binding?.reference_run_id || ''}
            disabled={disabled || model.fidelityReferences.length === 0}
            onChange={(event) => model.changeFidelityReference(event.target.value)}
          >
            <option value="">
              {model.fidelityReferences.length
                ? 'Select live reference evidence'
                : 'No compatible live reference evidence'}
            </option>
            {model.fidelityReferences.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={commonStyles.srOnly}>G5 fidelity live evidence</span>
          <select
            aria-label="G5 fidelity live evidence"
            value={binding?.live_run_id || ''}
            disabled={disabled || !binding?.reference_run_id || model.fidelityLiveRuns.length === 0}
            onChange={(event) => model.changeFidelityLive(event.target.value)}
          >
            <option value="">
              {binding?.reference_run_id && model.fidelityLiveRuns.length === 0
                ? 'No fresh exact-cohort live evidence'
                : 'Select fresh exact-cohort live evidence'}
            </option>
            {model.fidelityLiveRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
      </div>
    )
  }
  const gateID = slot.gate_id as keyof typeof RUN_BINDING_KEYS
  const value = model.draft.gateBindings[RUN_BINDING_KEYS[gateID]] || ''
  const options = model.options.get(slot.gate_id) || []
  return (
    <select
      aria-label={`${slot.gate_id} ${slot.name} evidence`}
      value={value}
      disabled={disabled || options.length === 0}
      onChange={(event) =>
        model.changeRunBinding(slot.gate_id as EvaluationCampaignGateID, event.target.value)
      }
    >
      <option value="">
        {options.length ? 'Select completed evidence' : 'No compatible completed evidence'}
      </option>
      {options.map((run) => (
        <option key={run.id} value={run.id}>
          {runLabel(run)}
        </option>
      ))}
    </select>
  )
}

interface EvaluationCampaignBuilderProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  totalRuns: number
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  allRunsLoaded: boolean
  loadingAllRuns: boolean
  canCreate: boolean
  createPending: boolean
  createError: string | null
  model: EvaluationCampaignBuilderModel
  onLoadAllRuns: () => void
  onRefreshRuns: () => boolean | Promise<boolean>
  onCreate: (request: CreateEvaluationCampaignPayload) => Promise<EvaluationCampaign | null>
  onClearCreateError: () => void
}

export default function EvaluationCampaignBuilder({
  catalog,
  runs,
  totalRuns,
  runLedgerAvailable,
  runLedgerComplete,
  allRunsLoaded,
  loadingAllRuns,
  canCreate,
  createPending,
  createError,
  model,
  onLoadAllRuns,
  onRefreshRuns,
  onCreate,
  onClearCreateError,
}: EvaluationCampaignBuilderProps) {
  const g3 = model.slots.find((slot) => slot.gate_id === 'G3')
  const inputDisabled = createPending || !allRunsLoaded || !runLedgerComplete
  return (
    <form
      className={styles.builder}
      aria-busy={createPending}
      onSubmit={(event) => {
        event.preventDefault()
        if (model.validation || !canCreate || createPending) return
        void onCreate(buildEvaluationCampaignRequest(model.draft))
      }}
    >
      <div className={styles.builderHeader}>
        <div>
          <span className={commonStyles.eyebrow}>Evidence composition</span>
          <h3>Build a release decision</h3>
          <p>
            The server catalog defines each promotion slot. Only completed evidence satisfying its
            mode, track, executor, and evidence boundary appears.
          </p>
        </div>
        <span className={commonStyles.contractBadge}>{totalRuns} durable runs</span>
      </div>

      {!allRunsLoaded ? (
        <div className={styles.ledgerBoundary} role="status">
          <div>
            <strong>Complete ledger required</strong>
            <span>
              {runs.length} of {totalRuns} runs are loaded. Promotion selection stays locked to
              prevent a partial evidence decision.
            </span>
          </div>
          <EvaluationActionButton
            type="button"
            disabled={createPending || loadingAllRuns || !runLedgerAvailable}
            onClick={onLoadAllRuns}
          >
            {loadingAllRuns ? 'Loading full ledger…' : 'Load complete ledger'}
          </EvaluationActionButton>
        </div>
      ) : null}

      <div className={styles.profileGrid}>
        <label className={styles.field}>
          <span>Change profile</span>
          <select
            aria-label="Campaign change profile"
            value={model.draft.changeProfile}
            disabled={createPending}
            onChange={(event) =>
              model.changeProfile(event.target.value as typeof model.draft.changeProfile)
            }
          >
            {catalog.change_profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <small>{model.profile?.description || 'Current server campaign profile'}</small>
        </label>
        <dl className={styles.profileSummary}>
          <div>
            <dt>Required slots</dt>
            <dd>{model.requiredSlotCount}</dd>
          </div>
          <div>
            <dt>Advisory slots</dt>
            <dd>{model.advisorySlotCount} optional</dd>
          </div>
          <div>
            <dt>Evidence policy</dt>
            <dd>Server catalog</dd>
          </div>
          <div>
            <dt>G3 boundary</dt>
            <dd>
              {g3?.disposition === 'not_applicable' ? 'Not applicable' : 'Fresh controlled pair'}
            </dd>
          </div>
        </dl>
      </div>

      {g3 && g3.disposition !== 'not_applicable' && g3.disposition !== 'waived' && model.profile ? (
        <EvaluationCampaignControlledPair
          key={model.draft.changeProfile}
          runs={runs}
          catalog={catalog}
          profile={model.profile}
          slot={g3}
          canCreate={canCreate}
          disabled={inputDisabled}
          onReady={async (execution) => {
            if (!(await onRefreshRuns())) {
              throw new Error(
                'Controlled pair completed, but the durable run ledger could not be refreshed.',
              )
            }
            model.applyControlledPair(execution.baseline_run.id, execution.candidate_run.id)
          }}
        />
      ) : null}

      <div
        className={styles.roleMatrixFrame}
        role="region"
        aria-label="Campaign evidence slots"
        tabIndex={0}
      >
        <table className={styles.roleMatrix}>
          <thead>
            <tr>
              <th scope="col">Gate slot</th>
              <th scope="col">Requirement</th>
              <th scope="col">Compatible evidence</th>
            </tr>
          </thead>
          <tbody>
            {model.slots.map((slot) => {
              const ids = campaignSlotRunIDs(slot, model.draft.gateBindings)
              const selected = ids.length === (slot.binding_kind === 'run' ? 1 : 2)
              const required = slot.disposition === 'required'
              return (
                <tr key={slot.gate_id} data-gate={slot.gate_id} data-selected={selected}>
                  <th scope="row">
                    <strong>
                      {slot.gate_id} · {slot.name}
                    </strong>
                    <small>{slot.description}</small>
                  </th>
                  <td>
                    <span
                      className={
                        required ? commonStyles.requirementBadge : commonStyles.optionalBadge
                      }
                    >
                      {slotDisposition(slot)}
                    </span>
                    <small className={selected ? styles.roleReady : styles.roleEmpty}>
                      {selected
                        ? 'Evidence bound'
                        : slot.disposition === 'required'
                          ? 'Evidence required'
                          : slot.disposition === 'advisory'
                            ? 'May be omitted'
                            : 'No binding'}
                    </small>
                  </td>
                  <td>
                    <SlotBinding slot={slot} runs={runs} model={model} disabled={inputDisabled} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Campaign name</span>
          <input
            aria-label="Campaign name"
            value={model.draft.name}
            maxLength={200}
            disabled={createPending}
            placeholder="e.g. Recipe v4 guarded promotion"
            onChange={(event) =>
              model.revise((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <details className={styles.contextDisclosure}>
          <summary>
            <span>Decision context</span>
            <small>
              {model.draft.description ? 'Context added' : 'Optional release rationale'}
            </small>
          </summary>
          <label className={styles.field}>
            <span className={commonStyles.srOnly}>Decision context</span>
            <textarea
              aria-label="Decision context"
              value={model.draft.description}
              maxLength={4000}
              disabled={createPending}
              placeholder="What changed, intended blast radius, and the promotion question."
              onChange={(event) =>
                model.revise((current) => ({ ...current, description: event.target.value }))
              }
            />
          </label>
        </details>
      </div>

      {createError ? (
        <div className={`${commonStyles.inlineError} ${styles.builderNotice}`} role="alert">
          <span>{createError}</span>
          <EvaluationActionButton
            type="button"
            compact
            disabled={createPending}
            onClick={onClearCreateError}
          >
            Dismiss
          </EvaluationActionButton>
        </div>
      ) : null}
      {!canCreate ? (
        <div className={`${commonStyles.inlineNotice} ${styles.builderNotice}`} role="status">
          <div>
            <strong>Read-only decision workspace</strong>
            <span>Evaluation write permission is required to publish a campaign.</span>
          </div>
        </div>
      ) : null}

      <div className={styles.formActions}>
        <span>
          {model.validation || 'All catalog slot checks passed. The server will attest evidence.'}
        </span>
        <EvaluationActionButton
          type="submit"
          variant="primary"
          disabled={Boolean(model.validation) || !canCreate || createPending}
        >
          {createPending ? 'Attesting campaign…' : 'Create promotion decision'}
        </EvaluationActionButton>
      </div>
    </form>
  )
}
