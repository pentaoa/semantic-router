import type {
  EvaluationCatalog,
  EvaluationExperimentIntent,
  EvaluationRun,
} from '../../types/evaluationPlane'
import EvaluationExperimentBenchmarkScope from './EvaluationExperimentBenchmarkScope'
import EvaluationExperimentBudget from './EvaluationExperimentBudget'
import EvaluationExperimentCapacitySLO from './EvaluationExperimentCapacitySLO'
import EvaluationExperimentGateScope from './EvaluationExperimentGateScope'
import EvaluationExperimentIdentity from './EvaluationExperimentIdentity'
import { EvaluationActionButton } from './EvaluationPrimitives'
import useEvaluationExperimentForm from './useEvaluationExperimentForm'
import styles from './EvaluationForm.module.css'

interface EvaluationExperimentFormProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  totalRuns: number
  canCreate: boolean
  canAutoStart: boolean
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  pending: boolean
  initialEntrypoint?: string | null
  onLoadMoreRuns: () => void
  onSubmit: (intent: EvaluationExperimentIntent) => Promise<boolean>
}

export default function EvaluationExperimentForm({
  catalog,
  runs,
  totalRuns,
  canCreate,
  canAutoStart,
  runLedgerAvailable,
  runLedgerComplete,
  hasMoreRuns,
  loadingMoreRuns,
  pending,
  initialEntrypoint,
  onLoadMoreRuns,
  onSubmit,
}: EvaluationExperimentFormProps) {
  const requestedTarget = initialEntrypoint
    ? catalog.targets.find(
        (target) =>
          target.modes.includes('live') &&
          (target.mixture?.entrypoint_model === initialEntrypoint ||
            target.mixture?.aliases.includes(initialEntrypoint)),
      )
    : undefined
  const form = useEvaluationExperimentForm({
    catalog,
    runs,
    canAutoStart,
    runLedgerAvailable,
    runLedgerComplete,
    pending,
    initialTargetID: requestedTarget?.id,
    preserveMissingLiveTarget: Boolean(initialEntrypoint && !requestedTarget),
    onSubmit,
  })
  const selectedTarget = catalog.targets.find((target) => target.id === form.targetID)

  if (!canCreate) {
    return (
      <section className={styles.permissionState}>
        <span>Read-only evaluation access</span>
        <h2>Experiment creation is not available for this session.</h2>
        <p>You can still inspect completed evidence, reports, provenance, and comparisons.</p>
      </section>
    )
  }

  return (
    <form className={styles.form} onSubmit={form.submit} aria-busy={pending}>
      <div className={styles.intro}>
        <div>
          <span className={styles.eyebrow}>Immutable run snapshot</span>
          <h2>New evaluation experiment</h2>
          <p>
            Suites and execution targets come from the server catalog. The browser cannot supply its
            own execution address.
          </p>
        </div>
        <div className={styles.introBadges}>
          <span className={styles.evidence}>
            {form.catalogEvidenceClass
              ? `Catalog evidence class ${form.catalogEvidenceClass}`
              : 'Evidence class pending'}
          </span>
          <span className={styles.evidence}>{catalog.gate_contract_version}</span>
        </div>
      </div>

      {form.validationError ? (
        <div ref={form.errorRef} className={styles.error} role="alert" tabIndex={-1}>
          {form.validationError}
        </div>
      ) : null}

      {initialEntrypoint && !requestedTarget && !form.targetID ? (
        <div className={styles.deepLinkWarning} role="alert">
          <div>
            <strong>Requested Mixture is not in the current Evaluation catalog</strong>
            <span>
              <code>{initialEntrypoint}</code> was not replaced with a replay fixture or a different
              live target. Refresh its configuration, or explicitly choose another live Mixture.
            </span>
          </div>
        </div>
      ) : null}

      <fieldset
        disabled={pending}
        aria-busy={pending}
        aria-label="Evaluation experiment fields"
        className={styles.formFields}
      >
        <EvaluationExperimentIdentity
          catalog={catalog}
          runs={runs}
          totalRuns={totalRuns}
          runLedgerAvailable={runLedgerAvailable}
          runLedgerComplete={runLedgerComplete}
          hasMoreRuns={hasMoreRuns}
          loadingMoreRuns={loadingMoreRuns}
          pending={pending}
          onLoadMoreRuns={onLoadMoreRuns}
          form={form}
        />
        <EvaluationExperimentGateScope catalog={catalog} form={form} />
        <EvaluationExperimentBenchmarkScope catalog={catalog} form={form} />
        <EvaluationExperimentCapacitySLO form={form} />
        <EvaluationExperimentBudget canAutoStart={canAutoStart} form={form} />

        <div className={styles.actions}>
          <span>
            {form.suiteIDs.length} suites · {form.trackIDs.length} tracks · profile{' '}
            {form.changeProfile || 'not selected'} · target{' '}
            {selectedTarget?.mixture?.entrypoint_model || selectedTarget?.name || 'not selected'}
            {form.capacitySLOActive ? ' · capacity SLO + load protocol frozen' : ''}
          </span>
          <EvaluationActionButton type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : form.autoStart ? 'Create and start' : 'Create draft'}
          </EvaluationActionButton>
        </div>
      </fieldset>
    </form>
  )
}
