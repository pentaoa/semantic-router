import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationComparison, EvaluationRun } from '../../types/evaluationPlane'
import { EVALUATION_SERVER_ATTESTATION_REVISION } from './evaluationPresentation'
import EvaluationCompare from './EvaluationCompare'

const baseline: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: 'baseline',
  name: 'Baseline',
  description: '',
  status: 'completed',
  mode: 'replay',
  evidence_level: 'E0',
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
  name: 'Candidate',
  baseline_run_id: baseline.id,
}

const comparison: EvaluationComparison = {
  schema_version: 'evaluation.v1',
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
  gates: [],
  recommendations: [],
}

function renderComparison(value: EvaluationComparison): string {
  return renderToStaticMarkup(
    createElement(EvaluationCompare, {
      runs: [candidate, baseline],
      baselineID: baseline.id,
      candidateID: candidate.id,
      comparison: value,
      runLedgerComplete: true,
      loading: false,
      error: null,
      onPairChange: () => undefined,
      onCompare: () => undefined,
    }),
  )
}

describe('EvaluationCompare attestation labels', () => {
  it('enables server-reduced comparison labels only for exact joint attestation', () => {
    const markup = renderComparison({
      ...comparison,
      attestation_revision: EVALUATION_SERVER_ATTESTATION_REVISION,
    })

    expect(markup).toContain('Server-reduced E0')
    expect(markup).not.toContain('Legacy worker-derived E0 / integrity-only')
  })

  it('keeps legacy comparison metrics integrity-only', () => {
    const markup = renderComparison(comparison)

    expect(markup).toContain('Legacy worker-derived E0 / integrity-only')
    expect(markup).not.toContain('Server-reduced')
  })
})
