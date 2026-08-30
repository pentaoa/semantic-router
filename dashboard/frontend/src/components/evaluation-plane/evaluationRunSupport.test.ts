import { describe, expect, it } from 'vitest'

import type { EvaluationRun } from '../../types/evaluationPlane'
import {
  cohortMismatches,
  defaultComparisonPair,
  eligibleComparisonCandidates,
} from './evaluationRunSupport'

function run(overrides: Partial<EvaluationRun>): EvaluationRun {
  const id = overrides.id || 'baseline'
  return {
    schema_version: 'evaluation.v1',
    id,
    client_request_id: id,
    name: 'Baseline',
    description: '',
    status: 'completed',
    mode: 'replay',
    evidence_level: 'E0',
    track_evidence_levels: { routing: 'E0' },
    target_id: 'target',
    change_profile: 'recipe',
    suite_ids: ['suite'],
    track_ids: ['routing'],
    sample_limit: 100,
    concurrency: 4,
    seed: 42,
    progress: { percent: 100, completed: 100, total: 100 },
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('evaluation comparison lineage', () => {
  it('only exposes completed candidates pinned to an exact completed cohort', () => {
    const baseline = run({})
    const candidate = run({ id: 'candidate', name: 'Candidate', baseline_run_id: baseline.id })
    const mismatched = run({
      id: 'mismatch',
      baseline_run_id: baseline.id,
      concurrency: 8,
    })
    const unpinned = run({ id: 'unpinned' })
    expect(eligibleComparisonCandidates([candidate, mismatched, unpinned, baseline])).toEqual([
      candidate,
    ])
    expect(defaultComparisonPair([candidate, baseline])).toEqual({
      baselineID: 'baseline',
      candidateID: 'candidate',
    })
  })

  it('names every client-visible cohort mismatch', () => {
    const baseline = run({})
    const candidate = run({
      id: 'candidate',
      target_id: 'other',
      seed: 7,
      suite_ids: ['other-suite'],
    })
    expect(cohortMismatches(baseline, candidate)).toEqual(['target', 'seed', 'suites'])
  })
})
