import type { EvaluationRun } from '../../types/evaluationPlane'
import type { EvaluationComparison } from '../../types/evaluationReport'
import EvaluationGateList from './EvaluationGateList'
import EvaluationMetricTable from './EvaluationMetricTable'
import EvaluationComparisonStatistics from './EvaluationComparisonStatistics'
import { effectiveGateVerdict } from './evaluationPresentation'
import { EvaluationActionButton, GateVerdictBadge } from './EvaluationPrimitives'
import { cohortMismatches, eligibleComparisonCandidates } from './evaluationRunSupport'
import styles from './EvaluationCompare.module.css'
import disclosureStyles from './EvaluationReportDisclosures.module.css'
import heroStyles from './EvaluationReportHero.module.css'
import reportStyles from './EvaluationReportLayout.module.css'

interface EvaluationCompareProps {
  runs: EvaluationRun[]
  baselineID: string
  candidateID: string
  comparison: EvaluationComparison | null
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  totalRuns: number
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  resourcesLoading: boolean
  resourcesError: string | null
  loading: boolean
  error: string | null
  onPairChange: (candidateID: string, baselineID: string) => void
  onCompare: () => void
  onLoadMoreRuns: () => void
  onRetryResources: () => void
  onCreateRun?: () => void
}

export default function EvaluationCompare({
  runs,
  baselineID,
  candidateID,
  comparison,
  runLedgerAvailable,
  runLedgerComplete,
  totalRuns,
  hasMoreRuns,
  loadingMoreRuns,
  resourcesLoading,
  resourcesError,
  loading,
  error,
  onPairChange,
  onCompare,
  onLoadMoreRuns,
  onRetryResources,
  onCreateRun,
}: EvaluationCompareProps) {
  const completed = new Map(
    runs.filter((run) => run.status === 'completed').map((run) => [run.id, run]),
  )
  const candidates =
    runLedgerAvailable && runLedgerComplete ? eligibleComparisonCandidates(runs) : []
  const candidate = runLedgerAvailable && runLedgerComplete ? completed.get(candidateID) : undefined
  const baseline = runLedgerAvailable && runLedgerComplete ? completed.get(baselineID) : undefined
  const mismatches = baseline && candidate ? cohortMismatches(baseline, candidate) : []
  const lineageMismatch = Boolean(candidate && candidate.baseline_run_id !== baselineID)
  const invalidPair =
    !runLedgerAvailable ||
    !runLedgerComplete ||
    !baseline ||
    !candidate ||
    resourcesLoading ||
    lineageMismatch ||
    mismatches.length > 0
  const comparisonVerdict = comparison
    ? effectiveGateVerdict(comparison.verdict, comparison.gates)
    : null

  const chooseCandidate = (id: string) => {
    const next = completed.get(id)
    onPairChange(id, next?.baseline_run_id || '')
  }

  return (
    <div className={reportStyles.report} aria-busy={loading}>
      <section className={styles.compareHero}>
        <div>
          <span className={reportStyles.eyebrow}>Diagnostic layer · paired evidence</span>
          <h2>Compare a candidate with its pinned baseline</h2>
          <p>
            Candidate lineage fixes the baseline and cohort. Arbitrary completed runs are excluded
            because they can manufacture invalid deltas. This scientific diagnostic does not issue a
            promotion decision.
          </p>
        </div>
        <div className={styles.compareControls}>
          <label>
            Candidate
            <select
              aria-label="Comparison candidate"
              value={candidateID}
              disabled={
                !runLedgerAvailable ||
                !runLedgerComplete ||
                loading ||
                resourcesLoading ||
                candidates.length === 0
              }
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
          <EvaluationActionButton
            type="button"
            variant="primary"
            disabled={invalidPair || loading}
            onClick={onCompare}
          >
            {resourcesLoading
              ? 'Loading run identities…'
              : loading
                ? 'Comparing paired evidence…'
                : 'Compare paired evidence'}
          </EvaluationActionButton>
        </div>
      </section>

      {!runLedgerAvailable ? (
        <div className={heroStyles.error} role="alert">
          The run ledger is unavailable. Retry it before selecting or comparing evidence.
        </div>
      ) : null}
      {runLedgerAvailable && !runLedgerComplete ? (
        <div className={heroStyles.error} role="alert">
          The durable run ledger is incomplete. Baseline selection and comparison conclusions are
          blocked until every quarantined run bundle is repaired.
        </div>
      ) : null}
      {resourcesError ? (
        <div className={heroStyles.error} role="alert">
          <span>{resourcesError}</span>
          <EvaluationActionButton type="button" compact onClick={onRetryResources}>
            Retry run identities
          </EvaluationActionButton>
        </div>
      ) : null}
      {runLedgerAvailable && runLedgerComplete && hasMoreRuns ? (
        <div className={styles.selectionScope} role="status">
          <span>
            Candidate selection covers {runs.length} of {totalRuns} loaded runs.
          </span>
          <EvaluationActionButton
            type="button"
            compact
            disabled={loadingMoreRuns}
            onClick={onLoadMoreRuns}
          >
            {loadingMoreRuns ? 'Loading older runs…' : 'Load older candidates'}
          </EvaluationActionButton>
        </div>
      ) : null}
      {runLedgerAvailable &&
      runLedgerComplete &&
      !resourcesLoading &&
      !resourcesError &&
      candidates.length === 0 ? (
        <div className={reportStyles.emptyState}>
          <div>
            <strong>No comparable candidate exists.</strong>
            <p>Create a new run from a completed baseline; the form pins the exact cohort.</p>
          </div>
          {onCreateRun ? (
            <EvaluationActionButton type="button" variant="primary" onClick={onCreateRun}>
              Create candidate run
            </EvaluationActionButton>
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
        <div className={heroStyles.error} role="alert">
          The selected candidate is not pinned to this baseline.
        </div>
      ) : null}
      {runLedgerComplete && mismatches.length ? (
        <div className={heroStyles.error} role="alert">
          Cohort mismatch: {mismatches.join(', ')}.
        </div>
      ) : null}
      {error ? (
        <div className={heroStyles.error} role="alert">
          {error}
        </div>
      ) : null}

      {runLedgerAvailable &&
      runLedgerComplete &&
      !resourcesLoading &&
      !resourcesError &&
      !comparison &&
      !error &&
      candidates.length > 0 ? (
        <div className={reportStyles.empty}>
          Choose a candidate, then calculate its paired comparison.
        </div>
      ) : null}
      {runLedgerComplete && comparison ? (
        <>
          <section className={reportStyles.section}>
            <div className={reportStyles.sectionHeader}>
              <div>
                <span className={reportStyles.eyebrow}>Diagnostic finding · not promotion</span>
                <h3>{comparison.summary}</h3>
                <p>
                  Improvement colors follow each metric direction; schema mismatches stay unmatched.
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
            />
          </section>
          <section className={reportStyles.section}>
            <div className={reportStyles.sectionHeader}>
              <div>
                <span className={reportStyles.eyebrow}>Server-reduced inference</span>
                <h3>Paired scientific statistics</h3>
                <p>
                  Independent case units, paired confidence intervals, and frozen non-inferiority
                  margins determine whether the comparison is conclusive.
                </p>
              </div>
            </div>
            <EvaluationComparisonStatistics statistics={comparison.statistics} />
          </section>
          <section
            className={reportStyles.section}
            aria-labelledby="evaluation-comparison-gates-title"
          >
            <div className={reportStyles.sectionHeader}>
              <div>
                <span className={reportStyles.eyebrow}>Run-level evidence</span>
                <h3 id="evaluation-comparison-gates-title">Comparison gates</h3>
              </div>
            </div>
            <EvaluationGateList gates={comparison.gates} />
          </section>
          <details className={disclosureStyles.disclosure}>
            <summary>
              Comparison findings <span>{comparison.recommendations.length}</span>
            </summary>
            <div className={disclosureStyles.disclosureBody}>
              {comparison.recommendations.length ? (
                <ol className={disclosureStyles.recommendations}>
                  {comparison.recommendations.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ol>
              ) : (
                <p className={reportStyles.empty}>No comparison findings were generated.</p>
              )}
            </div>
          </details>
        </>
      ) : null}
    </div>
  )
}
