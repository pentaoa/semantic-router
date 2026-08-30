import { describe, expect, it } from 'vitest'

import type { EvaluationRun } from '../types/evaluationPlane'
import {
  buildCreateEvaluationControlledPairPayload,
  decodeEvaluationControlledPairExecution,
} from './evaluationControlledPairContract'
import { isCanonicalEvaluationRunID } from './evaluationRunContract'

const BASELINE_SOURCE = '11111111-1111-4111-8111-111111111111'
const CANDIDATE_SOURCE = '22222222-2222-4222-8222-222222222222'

function liveRun(id: string, baselineRunID?: string): EvaluationRun {
  return {
    schema_version: 'evaluation.v1',
    id,
    client_request_id: id,
    name: baselineRunID ? 'Controlled candidate' : 'Controlled baseline',
    description: 'Server-owned abba-interleaved.v1 execution',
    status: 'running',
    mode: 'live',
    evidence_level: 'E2',
    track_evidence_levels: { routing: 'E2' },
    target_id: 'mom-live',
    mixture: {
      id: 'mom-live',
      entrypoint_model: 'quality-router',
      aliases: ['quality-router'],
      recipe_name: 'quality',
      recipe_description: 'Quality routing',
      recipe_digest: `sha256:${'1'.repeat(64)}`,
      pool_digest: `sha256:${'2'.repeat(64)}`,
      selector_policy_digest: `sha256:${'3'.repeat(64)}`,
      selector_digest: `sha256:${'4'.repeat(64)}`,
      adaptation_digest: `sha256:${'5'.repeat(64)}`,
      binding_digest: `sha256:${'6'.repeat(64)}`,
      model_arms: [
        {
          id: 'arm-a',
          model: 'model-a',
          provider_model_id_digest: `sha256:${'7'.repeat(64)}`,
          input_cost_per_million_tokens_usd: 1,
          output_cost_per_million_tokens_usd: 2,
        },
      ],
      support_models: [],
      decisions: [{ name: 'route', algorithm: 'semantic', arm_ids: ['arm-a'] }],
    },
    change_profile: 'recipe',
    suite_ids: ['live-mom-core'],
    track_ids: ['routing'],
    sample_limit: 64,
    concurrency: 2,
    seed: 42,
    ...(baselineRunID ? { baseline_run_id: baselineRunID } : {}),
    progress: { percent: 10, completed: 6, total: 64, message: 'AB block 1' },
    created_at: '2026-08-31T00:00:00Z',
    started_at: '2026-08-31T00:00:01Z',
  }
}

describe('controlled pair contract', () => {
  it('builds exactly five distinct canonical UUID fields and no client target claims', () => {
    const request = buildCreateEvaluationControlledPairPayload(BASELINE_SOURCE, CANDIDATE_SOURCE)
    expect(Object.keys(request).sort()).toEqual([
      'baseline_run_id',
      'baseline_source_run_id',
      'candidate_run_id',
      'candidate_source_run_id',
      'client_request_id',
    ])
    expect(Object.values(request).every(isCanonicalEvaluationRunID)).toBe(true)
    expect(new Set(Object.values(request)).size).toBe(5)
    expect(JSON.stringify(request)).not.toMatch(/endpoint|credential|version|label/)
  })

  it('strictly decodes the requested AB/BA execution and rejects extra claims', () => {
    const request = buildCreateEvaluationControlledPairPayload(BASELINE_SOURCE, CANDIDATE_SOURCE)
    const response = {
      schema_version: 'evaluation.v1',
      contract_version: 'evaluation-controlled-pair.v1',
      id: request.client_request_id,
      protocol: 'abba-interleaved.v1',
      baseline_source_run_id: request.baseline_source_run_id,
      candidate_source_run_id: request.candidate_source_run_id,
      baseline_run: liveRun(request.baseline_run_id),
      candidate_run: liveRun(request.candidate_run_id, request.baseline_run_id),
    }
    expect(decodeEvaluationControlledPairExecution(response, request).candidate_run.id).toBe(
      request.candidate_run_id,
    )
    expect(() =>
      decodeEvaluationControlledPairExecution(
        { ...response, endpoint: 'https://client.invalid' },
        request,
      ),
    ).toThrow('Controlled pair response is incomplete.')
    expect(() =>
      decodeEvaluationControlledPairExecution(
        { ...response, protocol: 'post-hoc-independent.v1' },
        request,
      ),
    ).toThrow('Controlled pair response is incomplete.')
    expect(() =>
      decodeEvaluationControlledPairExecution(
        {
          ...response,
          candidate_run: liveRun(request.candidate_run_id, CANDIDATE_SOURCE),
        },
        request,
      ),
    ).toThrow('Controlled pair response does not match the requested AB/BA execution.')
  })
})
