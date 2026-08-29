import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationReport } from '../../types/evaluationPlane'
import { EVALUATION_SERVER_ATTESTATION_REVISION } from './evaluationPresentation'
import EvaluationReportView from './EvaluationReportView'

const legacyReport: EvaluationReport = {
  schema_version: 'evaluation.v1',
  run: {
    schema_version: 'evaluation.v1',
    id: 'run-legacy',
    name: 'Legacy evaluation',
    description: 'Historical worker report',
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
    completed_at: '2026-08-30T00:01:00Z',
  },
  summary: {
    verdict: 'unavailable',
    quality_score: null,
    latency_p95_ms: null,
    runtime_cost: 0.01,
    capacity_tco: null,
    coverage: { evaluated: 4, total: 4, fraction: 1 },
    passed_gates: 0,
    failed_gates: 0,
    unavailable_gates: 0,
  },
  tracks: [
    {
      track_id: 'safety',
      status: 'completed',
      evidence_level: 'E0',
      summary: 'Diagnostic safety observations',
      coverage: { evaluated: 4, total: 4, fraction: 1 },
      metrics: [],
      gates: [],
    },
  ],
  metrics: [
    {
      id: 'safety.violation_rate',
      name: 'Safety violation rate',
      track_id: 'safety',
      value: 0,
      unit: 'violations/case',
      sample_count: 4,
    },
  ],
  gates: [],
  costs: {
    runtime: { amount: 0.01, currency: 'USD' },
    evaluation_overhead: { amount: 0, currency: 'USD' },
    capacity_tco: { amount: null, currency: 'USD' },
  },
  recommendations: [],
  provenance: {
    schema_version: 'evaluation.v1',
    generated_at: '2026-08-30T00:01:00Z',
    target_id: 'target-a',
    seed: 7,
  },
  artifacts: [],
}

describe('EvaluationReportView attestation language', () => {
  it('renders a legacy report without server-verified claims while preserving metrics', () => {
    const claimedPass = {
      ...legacyReport,
      summary: { ...legacyReport.summary, verdict: 'pass' as const, passed_gates: 1 },
      gates: [
        {
          id: 'G0',
          name: 'Reproducibility',
          description: 'Worker-reported pass without a current server attestation.',
          disposition: 'required' as const,
          verdict: 'pass' as const,
          change_profile: 'recipe' as const,
          contract_version: 'evaluation-release-gates.v1',
          evidence_refs: [],
        },
      ],
    }
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportView, { report: claimedPass }),
    )

    expect(markup).toContain('Legacy worker-derived E0 / integrity-only')
    expect(markup).toContain('Current attestation required')
    expect(markup).toContain('0/1 reported required gate verdicts are trusted')
    expect(markup).toContain('Evidence needed')
    expect(markup).toContain('Safety violation rate')
    expect(markup).toContain('Legacy track scope · integrity-only')
    expect(markup).toContain('Legacy cost ledgers · integrity-only')
    expect(markup).not.toContain('Server-reduced')
    expect(markup).not.toContain('Verified artifacts')
    expect(markup).not.toContain('Verified track scope')
    expect(markup).not.toContain('Verified cost ledgers')
    expect(markup).not.toContain('Required gates satisfied')
    expect(markup).not.toContain('>Passed<')
  })

  it('enables bounded server-reduced and verified labels only for exact v2 attestation', () => {
    const report = {
      ...legacyReport,
      attestation_revision: EVALUATION_SERVER_ATTESTATION_REVISION,
    }
    const markup = renderToStaticMarkup(createElement(EvaluationReportView, { report }))

    expect(markup).toContain('Server-reduced E0')
    expect(markup).toContain('Verified artifacts')
    expect(markup).toContain('Verified track scope')
    expect(markup).toContain('Verified cost ledgers')
    expect(markup).toContain(EVALUATION_SERVER_ATTESTATION_REVISION)
    expect(markup).not.toContain('Legacy worker-derived E0 / integrity-only')
  })
})
