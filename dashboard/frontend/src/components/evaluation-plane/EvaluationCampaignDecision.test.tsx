import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationCampaign } from '../../types/evaluationCampaign'
import EvaluationCampaignDecision from './EvaluationCampaignDecision'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('EvaluationCampaignDecision model-pool reliability', () => {
  it('renders the normative worst-arm boundary and every frozen-arm diagnostic', () => {
    const campaign = {
      schema_version: 'evaluation.v1',
      contract_version: 'evaluation-campaign.v2',
      id: 'campaign-a',
      name: 'Model pool promotion',
      description: 'Paired replay and live pool treatment.',
      change_profile: 'model_pool',
      status: 'decided',
      gate_bindings: {
        g3_controlled_pair: {
          baseline_run_id: 'baseline-live',
          candidate_run_id: 'candidate-live',
        },
      },
      manifest_digest: digest('a'),
      created_at: '2026-08-30T00:00:00Z',
      decision: {
        schema_version: 'evaluation.v1',
        contract_version: 'evaluation-campaign.v2',
        attestation_revision: 'evaluation-server-attestation.v2',
        campaign_id: 'campaign-a',
        campaign_digest: digest('a'),
        verdict: 'fail',
        summary: 'The added arm regressed worst-arm reliability.',
        decision_digest: digest('b'),
        created_at: '2026-08-30T00:00:00Z',
        gates: [],
        evidence: [],
        recommendations: [],
        paired_live_evidence: {
          schema_version: 'evaluation.v1',
          contract_version: 'evaluation-campaign-paired-live.v3',
          controlled_pair_session_id: '10000000-0000-4000-8000-000000000001',
          controlled_pair_protocol: 'abba-interleaved.v1',
          baseline_run_id: 'baseline-live',
          candidate_run_id: 'candidate-live',
          candidate_subject_digest: digest('d'),
          digest: digest('c'),
          baseline_target_id: 'baseline--mom-balanced',
          candidate_target_id: 'candidate--mom-balanced',
          mixture_id: 'mom-balanced',
          recipe_name: 'balanced',
          track_ids: ['model_pool'],
          workload_snapshot_digest: digest('d'),
          benchmark_revisions: { 'pool-suite': digest('e') },
          bootstrap_samples: 1000,
          confidence_level: 0.95,
          promotion_policy: {
            candidate_normalized_regret_maximum: 0.25,
            paired_normalized_regret_margin: 0.05,
            minimum_no_information_frontier_lift: 0.05,
            minimum_joint_reliability: 0.8,
            maximum_all_arm_failure_rate: 0.2,
            minimum_candidate_arm_reliability: 0.8,
          },
          promotion_statistics: [],
          seed: 42,
          baseline_manifest_digest: digest('f'),
          candidate_manifest_digest: digest('1'),
          baseline_execution_attestation_digest: digest('2'),
          candidate_execution_attestation_digest: digest('3'),
          baseline_policy_snapshot_digest: digest('4'),
          candidate_policy_snapshot_digest: digest('4'),
          baseline_binding_snapshot_digest: digest('5'),
          candidate_binding_snapshot_digest: digest('5'),
          baseline_pool_snapshot_digest: digest('6'),
          candidate_pool_snapshot_digest: digest('7'),
          baseline_environment_snapshot_digest: digest('8'),
          candidate_environment_snapshot_digest: digest('8'),
          baseline_backend_topology_digest: digest('9'),
          candidate_backend_topology_digest: digest('9'),
          baseline_code_revision: 'baseline-code',
          candidate_code_revision: 'candidate-code',
          statistics: [
            {
              id: 'campaign.g3.model_pool.worst_arm_reliability_non_inferiority',
              gate_id: 'G3',
              track_id: 'model_pool',
              analysis_unit: 'pool_worst_arm_reliability',
              direction: 'higher_is_better',
              margin: 0.02,
              baseline_value: 1,
              candidate_value: 0,
              delta: -1,
              confidence_level: 0.95,
              confidence_interval: [-1, -1],
              candidate_confidence_interval: [0, 0],
              sample_count: 20,
              missing_pairs: 0,
              verdict: 'fail',
            },
          ],
          model_pool_arm_reliability: [
            {
              arm_id: 'arm-incumbent',
              cohort: 'paired',
              direction: 'lower_is_better',
              margin: 0.02,
              baseline_failure_rate: 0,
              candidate_failure_rate: 0,
              delta: 0,
              confidence_level: 0.95,
              confidence_interval: [0, 0],
              candidate_confidence_interval: [0, 0],
              baseline_sample_count: 20,
              candidate_sample_count: 20,
              verdict: 'pass',
            },
            {
              arm_id: 'arm-new',
              cohort: 'candidate_only',
              direction: 'lower_is_better',
              margin: 0.2,
              candidate_failure_rate: 1,
              confidence_level: 0.95,
              confidence_interval: [],
              candidate_confidence_interval: [1, 1],
              baseline_sample_count: 0,
              candidate_sample_count: 20,
              verdict: 'fail',
            },
          ],
        },
      },
    } satisfies EvaluationCampaign

    const markup = renderToStaticMarkup(
      createElement(EvaluationCampaignDecision, {
        campaign,
        runs: [],
        onStartAnother: () => undefined,
      }),
    )

    expect(markup).toContain('Worst-arm reliability')
    expect(markup).toContain('Per-arm failure boundaries')
    expect(markup).toContain('arm-incumbent')
    expect(markup).toContain('Added arm')
    expect(markup).toContain('arm-new')
    expect(markup).toContain('Not pairable')
    expect(markup).toContain(
      'An added arm&#x27;s absolute candidate reliability boundary is also normative',
    )
  })
})
