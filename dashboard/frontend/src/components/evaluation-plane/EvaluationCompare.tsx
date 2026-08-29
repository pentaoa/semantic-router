import type { EvaluationComparison, EvaluationRun } from '../../types/evaluationPlane'
import EvaluationGateList from './EvaluationGateList'
import EvaluationMetricTable from './EvaluationMetricTable'
import {
  evaluationGatesForPresentation,
  effectiveGateVerdict,
  hasServerEvaluationAttestation,
} from './evaluationPresentation'
import { GateVerdictBadge } from './EvaluationPrimitives'
import { cohortMismatches, eligibleComparisonCandidates } from './evaluationRunSupport'
import styles from './EvaluationReport.module.css'

interface EvaluationCompareProps {
  runs: EvaluationRun[]
  baselineID: string
  candidateID: string
  comparison: EvaluationComparison | null
  runLedgerComplete: boolean
  loading: boolean
  error: string | null
  onPairChange: (candidateID: string, baselineID: string) => void
  onCompare: () => void
  onCreateRun?: () => void
}

export default function EvaluationCompare({
  runs,
  baselineID,
  candidateID,
  comparison,
  runLedgerComplete,
  loading,
  error,
  onPairChange,
  onCompare,
  onCreateRun,
}: EvaluationCompareProps) {
  const completed = new Map(
    runs.filter((run) => run.status === 'completed').map((run) => [run.id, run]),
  )
  const candidates = runLedgerComplete ? eligibleComparisonCandidates(runs) : []
  const candidate = runLedgerComplete ? completed.get(candidateID) : undefined
  const baseline = runLedgerComplete ? completed.get(baselineID) : undefined
  const mismatches = baseline && candidate ? cohortMismatches(baseline, candidate) : []
  const lineageMismatch = Boolean(candidate && candidate.baseline_run_id !== baselineID)
  const invalidPair =
    !runLedgerComplete || !baseline || !candidate || lineageMismatch || mismatches.length > 0
  const comparisonAttested = comparison ? hasServerEvaluationAttestation(comparison) : false
  const comparisonGates = evaluationGatesForPresentation(
    comparison || {},
    comparison?.gates || [],
    'Current joint attestation',
  )
  const comparisonVerdict = comparison
    ? comparisonAttested
      ? effectiveGateVerdict(comparison.verdict, comparison.gates)
      : 'unavailable'
    : null

  const chooseCandidate = (id: string) => {
    const next = completed.get(id)
    onPairChange(id, next?.baseline_run_id || '')
  }

  return (
    <div className={styles.report} aria-busy={loading}>
      <section className={styles.compareHero}>
        <div>
          <span className={styles.eyebrow}>Paired evidence</span>
          <h2>Compare a candidate with its pinned baseline</h2>
          <p>
            Candidate lineage fixes the baseline and cohort. Arbitrary completed runs are excluded
            because they can manufacture invalid deltas.
          </p>
        </div>
        <div className={styles.compareControls}>
          <label>
            Candidate
            <select
              value={candidateID}
              disabled={!runLedgerComplete || loading || candidates.length === 0}
              onChange={(event) => chooseCandidate(event.target.value)}
            >
              <option value="">Select a candidate with baseline lineage</option>
              {candidates.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.change_profile}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pinned baseline
            <input
              value={baseline?.name || ''}
              placeholder="Derived from candidate"
              readOnly
              aria-describedby="evaluation-baseline-help"
            />
            <small id="evaluation-baseline-help">Read-only scientific lineage</small>
          </label>
          <button type="button" disabled={invalidPair || loading} onClick={onCompare}>
            {loading ? 'Comparing paired evidence…' : 'Compare paired evidence'}
          </button>
        </div>
      </section>

      {!runLedgerComplete ? (
        <div className={styles.error} role="alert">
          The durable run ledger is incomplete. Baseline selection and comparison conclusions are
          blocked until every quarantined run bundle is repaired.
        </div>
      ) : null}
      {runLedgerComplete && candidates.length === 0 ? (
        <div className={styles.emptyState}>
          <div>
            <strong>No comparable candidate exists.</strong>
            <p>Create a new run from a completed baseline; the form pins the exact cohort.</p>
          </div>
          {onCreateRun ? (
            <button type="button" onClick={onCreateRun}>
              Create candidate run
            </button>
          ) : null}
        </div>
      ) : null}
      {runLedgerComplete && baseline && candidate ? (
        <dl className={styles.comparabilityStrip} aria-label="Comparison cohort">
          <div>
            <dt>Profile</dt>
            <dd>{candidate.change_profile}</dd>
          </div>
          <div>
            <dt>Mode / target</dt>
            <dd>
              {candidate.mode} · {candidate.target_id}
            </dd>
          </div>
          <div>
            <dt>Workload</dt>
            <dd>
              {candidate.sample_limit} cases · c{candidate.concurrency}
            </dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd>{candidate.seed}</dd>
          </div>
        </dl>
      ) : null}
      {runLedgerComplete && lineageMismatch ? (
        <div className={styles.error} role="alert">
          The selected candidate is not pinned to this baseline.
        </div>
      ) : null}
      {runLedgerComplete && mismatches.length ? (
        <div className={styles.error} role="alert">
          Cohort mismatch: {mismatches.join(', ')}.
        </div>
      ) : null}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {!comparison && !error && candidates.length > 0 ? (
        <div className={styles.empty}>
          Choose a candidate, then calculate its paired comparison.
        </div>
      ) : null}
      {runLedgerComplete && comparison ? (
        <>
          {!comparisonAttested ? (
            <div className={styles.claimNotice} role="status">
              <strong>Current joint attestation required</strong>
              <span>
                The paired deltas remain readable as integrity-only diagnostics. No reported gate,
                recommendation, or comparison verdict can support a promotion decision.
              </span>
            </div>
          ) : null}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Comparison verdict</span>
                <h3>
                  {comparisonAttested ? comparison.summary : 'Current joint attestation required'}
                </h3>
                <p>
                  {comparisonAttested
                    ? 'Improvement colors follow each metric direction; schema mismatches stay unmatched.'
                    : `Reported diagnostic summary: ${comparison.summary}`}
                </p>
              </div>
              {comparisonVerdict ? (
                <GateVerdictBadge verdict={comparisonVerdict} disposition="required" />
              ) : null}
            </div>
            <EvaluationMetricTable
              metrics={comparison.metrics}
              caption="Paired comparison metrics"
              controls={comparison.metrics.length > 6}
              evidenceLevel={candidate?.evidence_level}
              serverAttested={comparisonAttested}
            />
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Regression boundary</span>
                <h3>Comparison gates</h3>
              </div>
            </div>
            <EvaluationGateList gates={comparisonGates} />
          </section>
          <details className={styles.disclosure}>
            <summary>
              Comparison findings <span>{comparison.recommendations.length}</span>
            </summary>
            <div className={styles.disclosureBody}>
              {comparison.recommendations.length ? (
                <ol className={styles.recommendations}>
                  {comparison.recommendations.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ol>
              ) : (
                <p className={styles.empty}>No comparison findings were generated.</p>
              )}
            </div>
          </details>
        </>
      ) : null}
    </div>
  )
}
