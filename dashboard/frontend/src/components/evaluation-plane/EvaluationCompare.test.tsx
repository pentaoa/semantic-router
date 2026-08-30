import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationRun } from '../../types/evaluationPlane'
import type { EvaluationComparison } from '../../types/evaluationReport'
import { EVALUATION_ATTESTATION_REVISION } from '../../types/evaluationPlane'
import EvaluationCompare from './EvaluationCompare'

const baseline: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: 'baseline',
  client_request_id: 'baseline',
  name: 'Baseline',
  description: '',
  status: 'completed',
  mode: 'replay',
  evidence_level: 'E0',
  track_evidence_levels: { safety: 'E0' },
  target_id: 'target-a',
  change_profile: 'recipe',
  suite_ids: ['suite-a'],
  track_ids: ['safety'],
  sample_limit: 4,
  concurrency: 1,
  seed: 7,
  progress: { percent: 100, completed: 4, total: 4 },
  created_at: '2026-08-30T00:00:00Z',
}

const candidate: EvaluationRun = {
  ...baseline,
  id: 'candidate',
  client_request_id: 'candidate',
  name: 'Candidate',
  baseline_run_id: baseline.id,
}

const comparison: EvaluationComparison = {
  schema_version: 'evaluation.v1',
  attestation_revision: EVALUATION_ATTESTATION_REVISION,
  baseline_run_id: baseline.id,
  candidate_run_id: candidate.id,
  verdict: 'unavailable',
  summary: 'Diagnostic comparison',
  metrics: [
    {
      id: 'safety.violation_rate',
      name: 'Safety violation rate',
      track_id: 'safety',
      value: 0,
      unit: 'violations/case',
    },
  ],
  statistics: [
    {
      id: 'joint.normalized_regret',
      track_id: 'joint',
      analysis_unit: 'case_normalized_regret',
      direction: 'lower_is_better',
      non_inferiority_margin: 0.05,
      baseline_value: 0.2,
      candidate_value: 0.1,
      delta: -0.1,
      confidence_level: 0.95,
      delta_confidence_interval: [],
      candidate_confidence_interval: [],
      sample_count: 4,
      verdict: 'unavailable',
    },
  ],
  gates: [],
  recommendations: [],
  created_at: '2026-08-30T00:02:00Z',
}

function renderComparison(value: EvaluationComparison): string {
  return renderToStaticMarkup(
    createElement(EvaluationCompare, {
      runs: [candidate, baseline],
      baselineID: baseline.id,
      candidateID: candidate.id,
      comparison: value,
      runLedgerAvailable: true,
      runLedgerComplete: true,
      totalRuns: 2,
      hasMoreRuns: false,
      loadingMoreRuns: false,
      resourcesLoading: false,
      resourcesError: null,
      loading: false,
      error: null,
      onPairChange: () => undefined,
      onCompare: () => undefined,
      onLoadMoreRuns: () => undefined,
      onRetryResources: () => undefined,
    }),
  )
}

describe('EvaluationCompare evidence labels', () => {
  it('renders the current attested comparison contract', () => {
    const markup = renderComparison(comparison)

    expect(markup).toContain('Server-reduced E0')
    expect(markup).toContain('Diagnostic comparison')
    expect(markup).toContain('Paired scientific statistics')
    expect(markup).toContain('Case normalized regret')
    expect(markup).toContain('Needs at least 20 independent case units; observed 4.')
    expect(markup).toContain('Not estimable')
  })
})
