import { useMemo, useState } from 'react'

import type { EvaluationControlledPairExecution } from '../../types/evaluationControlledPair'
import type {
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationCatalogChangeProfile,
  EvaluationRun,
} from '../../types/evaluationPlane'
import { useEvaluationControlledPair } from '../../hooks/useEvaluationControlledPair'
import {
  controlledPairBaselineSourceOptions,
  controlledPairCandidateSourceOptions,
} from './evaluationCampaignSupport'
import { EvaluationActionButton } from './EvaluationPrimitives'
import styles from './EvaluationCampaignControlledPair.module.css'

interface EvaluationCampaignControlledPairProps {
  runs: EvaluationRun[]
  catalog: EvaluationCatalog
  profile: EvaluationCatalogChangeProfile
  slot: EvaluationCatalogCampaignSlot
  canCreate: boolean
  disabled: boolean
  onReady: (execution: EvaluationControlledPairExecution) => void | Promise<void>
}

function runProgress(run: EvaluationRun): string {
  return `${Math.round(run.progress.percent)}% · ${run.status}`
}

export default function EvaluationCampaignControlledPair({
  runs,
  catalog,
  profile,
  slot,
  canCreate,
  disabled,
  onReady,
}: EvaluationCampaignControlledPairProps) {
  const [baselineSourceID, setBaselineSourceID] = useState('')
  const [candidateSourceID, setCandidateSourceID] = useState('')
  const pair = useEvaluationControlledPair(onReady)
  const baselineOptions = useMemo(
    () => controlledPairBaselineSourceOptions(runs, catalog, profile, slot),
    [catalog, profile, runs, slot],
  )
  const candidateOptions = useMemo(
    () => controlledPairCandidateSourceOptions(runs, catalog, profile, slot, baselineSourceID),
    [baselineSourceID, catalog, profile, runs, slot],
  )
  const busy =
    pair.status === 'creating' || pair.status === 'running' || pair.status === 'assigning'
  const sourceReady = Boolean(baselineSourceID && candidateSourceID)
  const selectionRationale =
    baselineOptions.length === 0
      ? 'No completed, sealed live Mixture source is available for this G3 slot. Run a compatible live source evaluation first.'
      : !baselineSourceID
        ? 'Choose the completed live control source for the fresh paired execution.'
        : candidateOptions.length === 0
          ? 'No completed live treatment source matches this control cohort.'
          : 'Choose the matching treatment source, then launch one fresh controlled execution.'

  return (
    <section
      className={styles.pairStep}
      aria-labelledby="campaign-controlled-pair-title"
      aria-busy={busy}
    >
      <div className={styles.pairIntro}>
        <h4 id="campaign-controlled-pair-title">Controlled live pair</h4>
        <p>
          Choose two sealed source snapshots. The server launches fresh AB/BA-interleaved runs and
          freezes credentials, workload, order, and cohort.
        </p>
      </div>
      <div className={styles.pairWorkspace}>
        <div className={styles.sourceGrid}>
          <label>
            Baseline source
            <select
              aria-label="Controlled pair baseline source"
              value={baselineSourceID}
              disabled={disabled || busy || pair.status === 'ready'}
              onChange={(event) => {
                setBaselineSourceID(event.target.value)
                setCandidateSourceID('')
                pair.reset()
              }}
            >
              <option value="">Select completed live source</option>
              {baselineOptions.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.mixture?.entrypoint_model || run.target_id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Candidate source
            <select
              aria-label="Controlled pair candidate source"
              value={candidateSourceID}
              disabled={disabled || busy || pair.status === 'ready' || !baselineSourceID}
              onChange={(event) => {
                setCandidateSourceID(event.target.value)
                pair.reset()
              }}
            >
              <option value="">Select exact-cohort treatment source</option>
              {candidateOptions.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.mixture?.entrypoint_model || run.target_id}
                </option>
              ))}
            </select>
          </label>
        </div>

        {pair.execution ? (
          <dl className={styles.progress} aria-label="Controlled pair progress">
            <div>
              <dt>Baseline AB/BA</dt>
              <dd>{runProgress(pair.execution.baseline_run)}</dd>
              <small>
                {pair.execution.baseline_run.progress.message || 'Server worker active'}
              </small>
            </div>
            <div>
              <dt>Candidate AB/BA</dt>
              <dd>{runProgress(pair.execution.candidate_run)}</dd>
              <small>
                {pair.execution.candidate_run.progress.message || 'Server worker active'}
              </small>
            </div>
          </dl>
        ) : null}

        {pair.error ? (
          <div className={styles.error} role="alert">
            <span>{pair.error}</span>
            <EvaluationActionButton
              type="button"
              compact
              disabled={!canCreate || busy}
              onClick={pair.retry}
            >
              Retry controlled pair
            </EvaluationActionButton>
          </div>
        ) : null}
        {pair.status === 'ready' ? (
          <div className={styles.ready} role="status">
            Fresh baseline and candidate runs completed and were bound to G3.
          </div>
        ) : null}

        {pair.status !== 'ready' && !pair.error ? (
          <div className={styles.pairAction}>
            <span>
              {pair.status === 'assigning'
                ? 'Both runs completed. Refreshing the durable ledger before binding G3.'
                : busy
                  ? 'Both workers must finish before their run identities enter the evidence matrix.'
                  : selectionRationale}
            </span>
            <EvaluationActionButton
              type="button"
              compact
              variant="primary"
              disabled={!canCreate || disabled || busy || !sourceReady}
              onClick={() => void pair.create(baselineSourceID, candidateSourceID)}
            >
              {pair.status === 'creating'
                ? 'Starting controlled pair…'
                : pair.status === 'assigning'
                  ? 'Assigning completed pair…'
                  : pair.status === 'running'
                    ? 'Controlled pair running…'
                    : 'Launch controlled pair'}
            </EvaluationActionButton>
          </div>
        ) : null}
      </div>
    </section>
  )
}
