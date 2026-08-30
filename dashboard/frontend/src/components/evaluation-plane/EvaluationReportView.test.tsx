import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationReport } from '../../types/evaluationReport'
import { EVALUATION_ATTESTATION_REVISION } from '../../types/evaluationPlane'
import EvaluationReportView from './EvaluationReportView'

const report: EvaluationReport = {
  schema_version: 'evaluation.v1',
  attestation_revision: EVALUATION_ATTESTATION_REVISION,
  run: {
    schema_version: 'evaluation.v1',
    id: 'run-current',
    client_request_id: 'run-current',
    name: 'Current evaluation',
    description: 'Server-attested diagnostic report',
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

describe('EvaluationReportView evidence language', () => {
  it('explains one frozen Mixture across recipe, pool-arm, and joint outcomes', () => {
    const mixtureReport: EvaluationReport = {
      ...report,
      run: {
        ...report.run,
        mode: 'live',
        target_id: 'mom-balanced',
        track_ids: ['routing', 'model_pool', 'joint'],
        mixture: {
          id: 'mom-balanced',
          entrypoint_model: 'vllm-sr/auto',
          aliases: ['vllm-sr/auto'],
          recipe_name: 'balanced',
          recipe_description: 'Balanced routing.',
          recipe_digest: `sha256:${'1'.repeat(64)}`,
          pool_digest: `sha256:${'2'.repeat(64)}`,
          selector_policy_digest: `sha256:${'4'.repeat(64)}`,
          selector_digest: `sha256:${'5'.repeat(64)}`,
          adaptation_digest: `sha256:${'6'.repeat(64)}`,
          binding_digest: `sha256:${'3'.repeat(64)}`,
          model_arms: [
            {
              id: 'fast',
              model: 'models/fast',
              provider_model_id_digest: `sha256:${'4'.repeat(64)}`,
              input_cost_per_million_tokens_usd: 0.1,
              output_cost_per_million_tokens_usd: 0.2,
            },
            {
              id: 'strong',
              model: 'models/strong',
              provider_model_id_digest: `sha256:${'5'.repeat(64)}`,
              input_cost_per_million_tokens_usd: 0.4,
              output_cost_per_million_tokens_usd: 0.8,
            },
          ],
          support_models: [],
          fallback_arm_id: 'fast',
          decisions: [{ name: 'reasoning', algorithm: 'confidence', arm_ids: ['fast', 'strong'] }],
        },
      },
      metrics: [
        {
          id: 'routing.accuracy',
          name: 'Routing accuracy',
          track_id: 'routing',
          value: 0.75,
          unit: 'fraction',
        },
        {
          id: 'model_pool.oracle_quality',
          name: 'Pool oracle quality',
          track_id: 'model_pool',
          value: 1,
          unit: 'fraction',
        },
        {
          id: 'model_pool.arm.fast.quality',
          name: 'Fast quality',
          track_id: 'model_pool',
          value: 0.5,
          unit: 'fraction',
        },
        {
          id: 'model_pool.arm.strong.quality',
          name: 'Strong quality',
          track_id: 'model_pool',
          value: 1,
          unit: 'fraction',
        },
        {
          id: 'joint.realized_quality',
          name: 'Realized quality',
          track_id: 'joint',
          value: 0.75,
          unit: 'fraction',
        },
        {
          id: 'joint.oracle_regret',
          name: 'Oracle regret',
          track_id: 'joint',
          value: 0.25,
          unit: 'fraction',
        },
        {
          id: 'joint.normalized_regret',
          name: 'Normalized oracle regret',
          track_id: 'joint',
          value: 0.25,
          unit: 'fraction',
        },
      ],
    }
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportView, { report: mixtureReport }),
    )

    expect(markup).toContain('Evaluated system boundary')
    expect(markup).toContain('01 · Routing recipe')
    expect(markup).toContain('02 · Model pool')
    expect(markup).toContain('03 · Routed system')
    expect(markup).toContain('Per-arm outcome matrix')
    expect(markup).toContain('models/fast')
    expect(markup).toContain('models/strong')
    expect(markup).toContain('Fallback')
    expect(markup).toContain('Normalized regret')
    expect(markup).toContain('Read left to right')
  })

  it('renders current attested E0 evidence without manufacturing promotion readiness', () => {
    const diagnostic = {
      ...report,
      summary: {
        ...report.summary,
        verdict: 'unavailable' as const,
        unavailable_gates: 1,
        coverage: { evaluated: 4, total: 6, fraction: 2 / 3, unavailable: 2 },
      },
      gates: [
        {
          id: 'G0',
          name: 'Reproducibility',
          description: 'Reproducibility evidence is incomplete.',
          disposition: 'required' as const,
          verdict: 'unavailable' as const,
          change_profile: 'recipe' as const,
          contract_version: 'evaluation-release-gates.v2' as const,
          evidence_refs: [],
          coverage: { evaluated: 4, total: 6, fraction: 2 / 3, unavailable: 2 },
        },
      ],
    }
    const markup = renderToStaticMarkup(createElement(EvaluationReportView, { report: diagnostic }))

    expect(markup).toContain('Promotion summary withheld — server-attested diagnostic E0')
    expect(markup).toContain('Diagnostic evidence only')
    expect(markup).toContain('0/1 required gates passed')
    expect(markup).toContain('Evidence needed')
    expect(markup.match(/2 not measured/g)).toHaveLength(3)
    expect(markup).toContain('Safety violation rate')
    expect(markup).toContain('Server-reduced E0')
    expect(markup).toContain('Verified artifacts')
    expect(markup).toContain('Verified track scope')
    expect(markup).toContain('Verified cost ledgers')
    expect(markup).toContain(EVALUATION_ATTESTATION_REVISION)
  })
})
