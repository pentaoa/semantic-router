import type { EvaluationRun } from '../../types/evaluationPlane'

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

export function cohortMismatches(baseline: EvaluationRun, candidate: EvaluationRun): string[] {
  const mismatches: string[] = []
  if (baseline.mode !== candidate.mode) mismatches.push('mode')
  if (baseline.target_id !== candidate.target_id) mismatches.push('target')
  if (baseline.change_profile !== candidate.change_profile) mismatches.push('change profile')
  if (baseline.sample_limit !== candidate.sample_limit) mismatches.push('sample limit')
  if (baseline.concurrency !== candidate.concurrency) mismatches.push('concurrency')
  if (baseline.seed !== candidate.seed) mismatches.push('seed')
  if (!sameMembers(baseline.suite_ids, candidate.suite_ids)) mismatches.push('suites')
  if (!sameMembers(baseline.track_ids, candidate.track_ids)) mismatches.push('tracks')
  return mismatches
}

export function eligibleComparisonCandidates(runs: EvaluationRun[]): EvaluationRun[] {
  const completed = new Map(
    runs.filter((run) => run.status === 'completed').map((run) => [run.id, run]),
  )
  return runs.filter((candidate) => {
    if (candidate.status !== 'completed' || !candidate.baseline_run_id) return false
    const baseline = completed.get(candidate.baseline_run_id)
    return Boolean(
      baseline &&
        baseline.id !== candidate.id &&
        cohortMismatches(baseline, candidate).length === 0,
    )
  })
}

export function defaultComparisonPair(runs: EvaluationRun[]): {
  baselineID: string
  candidateID: string
} | null {
  const candidate = eligibleComparisonCandidates(runs)[0]
  return candidate?.baseline_run_id
    ? { baselineID: candidate.baseline_run_id, candidateID: candidate.id }
    : null
}
