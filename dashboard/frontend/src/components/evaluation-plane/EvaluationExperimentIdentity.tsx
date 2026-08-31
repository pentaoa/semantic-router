import type { EvaluationCatalog, EvaluationRun } from '../../types/evaluationPlane'
import { baselineCohortIssue, EVALUATION_RUN_LIMITS } from './evaluationExperiment'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import EvaluationExperimentSectionHeading from './EvaluationExperimentSectionHeading'
import EvaluationExperimentMixture from './EvaluationExperimentMixture'
import { EvaluationActionButton } from './EvaluationPrimitives'
import styles from './EvaluationExperimentFields.module.css'
import sectionStyles from './EvaluationExperimentSection.module.css'

interface EvaluationExperimentIdentityProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  totalRuns: number
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  pending: boolean
  onLoadMoreRuns: () => void
  form: EvaluationExperimentFormModel
}

export default function EvaluationExperimentIdentity({
  catalog,
  runs,
  totalRuns,
  runLedgerAvailable,
  runLedgerComplete,
  hasMoreRuns,
  loadingMoreRuns,
  pending,
  onLoadMoreRuns,
  form,
}: EvaluationExperimentIdentityProps) {
  const selectedTarget = catalog.targets.find((target) => target.id === form.targetID)
  return (
    <section className={sectionStyles.formSection}>
      <EvaluationExperimentSectionHeading
        index="01"
        title="Identity and execution"
        description="Name the hypothesis and choose replay or live evidence."
      />
      <div className={styles.fieldGrid}>
        <label className={styles.fieldWide}>
          Experiment name
          <input
            value={form.name}
            onChange={(event) => form.setName(event.target.value)}
            placeholder="Recipe v3 vs production baseline"
            maxLength={EVALUATION_RUN_LIMITS.name}
            required
          />
        </label>
        <label className={styles.fieldWide}>
          Description
          <textarea
            value={form.description}
            onChange={(event) => form.setDescription(event.target.value)}
            placeholder="Hypothesis, expected trade-offs, and promotion decision."
            rows={3}
            maxLength={EVALUATION_RUN_LIMITS.description}
          />
        </label>
        <fieldset className={styles.choiceGroup}>
          <legend>Mode</legend>
          {(['replay', 'live'] as const).map((option) => (
            <label key={option} className={styles.choiceCard}>
              <input
                type="radio"
                name="evaluation-mode"
                value={option}
                checked={form.mode === option}
                disabled={form.baselineLocked}
                onChange={() => form.setMode(option)}
              />
              <span>
                <strong>{option === 'replay' ? 'Replay' : 'Live'}</strong>
                <small>
                  {option === 'replay'
                    ? 'Deterministic, reproducible evidence.'
                    : 'Execute against an approved runtime target.'}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          {form.mode === 'live' ? 'Mixture to evaluate' : 'Evidence target'}
          <select
            value={form.targetID}
            disabled={form.baselineLocked}
            onChange={(event) => form.setTargetID(event.target.value)}
            required
          >
            <option value="">Select target</option>
            {catalog.targets
              .filter((target) => target.modes.includes(form.mode))
              .map((target) => (
                <option key={target.id} value={target.id} disabled={target.healthy === false}>
                  {target.mixture?.entrypoint_model || target.name}
                  {target.healthy === false ? ' · runtime unavailable' : ''}
                </option>
              ))}
          </select>
          <small>
            {selectedTarget?.description || 'Only server-approved targets are selectable.'}
          </small>
        </label>
        <div className={styles.fieldControl}>
          <label>
            Baseline run
            <select
              value={form.baselineRunID}
              disabled={pending || !runLedgerAvailable || !runLedgerComplete}
              onChange={(event) => form.selectBaseline(event.target.value)}
            >
              <option value="">No baseline</option>
              {form.completedRuns.map((run) => {
                const issue = baselineCohortIssue(catalog, run)
                return (
                  <option key={run.id} value={run.id} disabled={Boolean(issue)}>
                    {run.name} · {run.change_profile} · {run.mode}
                    {issue ? ' · not eligible' : ''}
                  </option>
                )
              })}
            </select>
          </label>
          <small role={form.baselineLocked ? 'status' : undefined}>
            {!runLedgerAvailable
              ? 'The run ledger is unavailable. Retry it before selecting a baseline.'
              : !runLedgerComplete
                ? 'Baseline selection is blocked until quarantined durable run evidence is repaired.'
                : form.baselineLocked
                  ? 'Exact cohort copied and locked: profile, mode, target, suites, tracks, sample limit, concurrency, capacity contracts, and seed.'
                  : 'Selecting a baseline copies and locks its exact comparable cohort.'}
          </small>
          {runLedgerAvailable && runLedgerComplete && hasMoreRuns && !form.baselineLocked ? (
            <EvaluationActionButton
              type="button"
              compact
              disabled={loadingMoreRuns}
              onClick={onLoadMoreRuns}
            >
              {loadingMoreRuns
                ? 'Loading older runs…'
                : `Load older baselines · ${runs.length}/${totalRuns}`}
            </EvaluationActionButton>
          ) : null}
        </div>
        <EvaluationExperimentMixture target={selectedTarget} form={form} />
      </div>
    </section>
  )
}
