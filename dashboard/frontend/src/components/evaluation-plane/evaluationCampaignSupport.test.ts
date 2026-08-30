import { describe, expect, it } from 'vitest'

import type {
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationRun,
} from '../../types/evaluationPlane'
import {
  buildEvaluationCampaignRequest,
  campaignRunOptions,
  controlledPairBaselineSourceOptions,
  controlledPairCandidateSourceOptions,
  fidelityLiveOptions,
  fidelityReferenceOptions,
  type EvaluationCampaignDraft,
  pairedCampaignCohortMismatches,
  validateEvaluationCampaignDraft,
} from './evaluationCampaignSupport'

const ids = {
  campaign: '20000000-0000-4000-8000-000000000001',
  fidelityReference: '20000000-0000-4000-8000-000000000002',
  liveBaseline: '20000000-0000-4000-8000-000000000003',
  liveCandidate: '20000000-0000-4000-8000-000000000004',
  fidelityLive: '20000000-0000-4000-8000-000000000005',
  fixture: '20000000-0000-4000-8000-000000000006',
  g2: '20000000-0000-4000-8000-000000000007',
  g4: '20000000-0000-4000-8000-000000000008',
  controlledBaseline: '20000000-0000-4000-8000-000000000009',
  controlledCandidate: '20000000-0000-4000-8000-000000000010',
}

const mixture = {
  id: 'mom',
  entrypoint_model: 'vllm-sr/auto',
  aliases: ['vllm-sr/auto'],
  recipe_name: 'recipe',
  recipe_description: '',
  recipe_digest: `sha256:${'1'.repeat(64)}`,
  pool_digest: `sha256:${'2'.repeat(64)}`,
  selector_policy_digest: `sha256:${'3'.repeat(64)}`,
  selector_digest: `sha256:${'4'.repeat(64)}`,
  adaptation_digest: `sha256:${'5'.repeat(64)}`,
  binding_digest: `sha256:${'6'.repeat(64)}`,
  model_arms: [],
  support_models: [],
  decisions: [],
}

const baselineTargetID = 'baseline--mom'
const candidateTargetID = 'candidate--mom'

const slots: EvaluationCatalogCampaignSlot[] = [
  {
    gate_id: 'G2',
    name: 'Hard policy',
    description: 'Policy evidence.',
    disposition: 'required',
    binding_kind: 'run',
    mode: 'live',
    track_id: 'safety',
    minimum_evidence_level: 'E0',
    accepted_executor_ids: ['live-runtime.v1'],
  },
  {
    gate_id: 'G3',
    name: 'Offline value',
    description: 'Fresh controlled pair.',
    disposition: 'required',
    binding_kind: 'controlled_pair',
    mode: 'live',
    track_id: 'joint',
    minimum_evidence_level: 'E4',
    accepted_executor_ids: ['live-runtime.v1'],
  },
  {
    gate_id: 'G4',
    name: 'Robustness',
    description: 'Optional robustness evidence.',
    disposition: 'advisory',
    binding_kind: 'run',
    mode: 'live',
    track_id: 'routing',
    minimum_evidence_level: 'E4',
    accepted_executor_ids: ['normalized-suite-live.v1'],
  },
  {
    gate_id: 'G5',
    name: 'Live fidelity',
    description: 'Reference and live fidelity.',
    disposition: 'required',
    binding_kind: 'fidelity_pair',
    mode: 'live',
    track_id: 'joint',
    minimum_evidence_level: 'E5',
    accepted_executor_ids: ['normalized-suite-live.v1', 'live-runtime.v1'],
  },
  ...(['G6', 'G7', 'G8', 'G9'] as const).map((gate_id) => ({
    gate_id,
    name: `${gate_id} evidence`,
    description: 'Optional evidence.',
    disposition: 'advisory' as const,
    binding_kind: 'run' as const,
    mode: 'live' as const,
    minimum_evidence_level: 'E0' as const,
    accepted_executor_ids: ['live-runtime.v1'],
  })),
]

const catalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: 'evaluation-release-gates.v2',
  generated_at: '2026-08-31T00:00:00Z',
  change_profiles: [
    {
      id: 'recipe',
      name: 'Routing recipe',
      description: 'Recipe change.',
      campaign_slots: slots,
    },
  ],
  tracks: [],
  suites: [
    {
      id: 'mom-core',
      executors: { replay: 'mom-cohort-replay.v1', live: 'live-runtime.v1' },
      name: 'MoM core',
      description: '',
      track_ids: ['routing', 'model_pool', 'joint'],
      modes: ['replay', 'live'],
      evidence_level: 'E0',
      case_count: 64,
      campaign_eligible: true,
      campaign_minimum_cases: 59,
      revision: 'mom-core.v1',
      tags: [],
      methods: [],
    },
    {
      id: 'fixture-suite',
      executors: { replay: 'fixture-replay.v1' },
      name: 'Fixture',
      description: '',
      track_ids: ['routing'],
      modes: ['replay'],
      evidence_level: 'E0',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'fixture.v1',
      tags: [],
      methods: [],
    },
    {
      id: 'hard-policy-suite',
      executors: { live: 'live-runtime.v1' },
      name: 'Hard policy',
      description: '',
      track_ids: ['safety'],
      modes: ['live'],
      evidence_level: 'E4',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'hard-policy.v1',
      tags: [],
      methods: [],
    },
    {
      id: 'normalized-suite',
      executors: { live: 'normalized-suite-live.v1' },
      name: 'Normalized live',
      description: '',
      track_ids: ['routing', 'joint'],
      modes: ['live'],
      evidence_level: 'E0',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'normalized.v1',
      tags: [],
      methods: [],
    },
  ],
  targets: [
    {
      id: baselineTargetID,
      name: 'MoM · Baseline',
      description: '',
      kind: 'mixture-of-models',
      track_ids: ['routing', 'model_pool', 'joint'],
      modes: ['replay', 'live'],
      accepted_executors: {
        replay: ['mom-cohort-replay.v1'],
        live: ['live-runtime.v1'],
      },
      healthy: true,
      labels: { deployment: 'Baseline' },
      mixture,
    },
    {
      id: candidateTargetID,
      name: 'MoM · Candidate',
      description: '',
      kind: 'mixture-of-models',
      track_ids: ['routing', 'model_pool', 'joint'],
      modes: ['replay', 'live'],
      accepted_executors: {
        replay: ['mom-cohort-replay.v1'],
        live: ['live-runtime.v1'],
      },
      healthy: true,
      labels: { deployment: 'Candidate' },
      mixture,
    },
    {
      id: 'fixture',
      name: 'Fixture',
      description: '',
      kind: 'builtin-fixture',
      track_ids: ['routing'],
      modes: ['replay'],
      accepted_executors: { replay: ['fixture-replay.v1'] },
      healthy: true,
    },
  ],
}

function run(
  id: string,
  mode: 'replay' | 'live',
  overrides: Partial<EvaluationRun> = {},
): EvaluationRun {
  const result: EvaluationRun = {
    schema_version: 'evaluation.v1',
    id,
    client_request_id: id,
    name: id,
    description: '',
    status: 'completed',
    mode,
    evidence_level: 'E0',
    track_evidence_levels: { routing: 'E0' },
    target_id: candidateTargetID,
    mixture,
    change_profile: 'recipe',
    suite_ids: ['mom-core'],
    track_ids: ['routing'],
    sample_limit: 64,
    concurrency: 4,
    seed: 42,
    progress: { percent: 100, completed: 64, total: 64 },
    created_at: '2026-08-31T00:00:00Z',
    started_at: '2026-08-31T00:00:01Z',
    completed_at: '2026-08-31T00:10:00Z',
    ...overrides,
  }
  result.track_evidence_levels =
    overrides.track_evidence_levels ||
    (Object.fromEntries(
      result.track_ids.map((trackID) => [trackID, result.evidence_level]),
    ) as EvaluationRun['track_evidence_levels'])
  return result
}

const liveBaseline = run(ids.liveBaseline, 'live', {
  target_id: baselineTargetID,
  track_ids: ['routing', 'model_pool', 'joint'],
  track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
})
const liveCandidate = run(ids.liveCandidate, 'live', {
  track_ids: ['routing', 'model_pool', 'joint'],
  track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
})
const controlledBaseline = run(ids.controlledBaseline, 'live', {
  target_id: baselineTargetID,
  track_ids: ['routing', 'model_pool', 'joint'],
  track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
})
const controlledCandidate = run(ids.controlledCandidate, 'live', {
  baseline_run_id: controlledBaseline.id,
  track_ids: ['routing', 'model_pool', 'joint'],
  track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
})
const g2 = run(ids.g2, 'live', {
  suite_ids: ['hard-policy-suite'],
  track_ids: ['safety'],
  evidence_level: 'E4',
})
const g4 = run(ids.g4, 'live', {
  suite_ids: ['normalized-suite'],
  track_ids: ['routing'],
  evidence_level: 'E4',
})
const fidelityReference = run(ids.fidelityReference, 'live', {
  suite_ids: ['normalized-suite'],
  track_ids: ['joint'],
  evidence_level: 'E4',
  completed_at: '2026-08-31T00:10:00Z',
})
const fidelityLive = run(ids.fidelityLive, 'live', {
  suite_ids: ['normalized-suite'],
  track_ids: ['joint'],
  evidence_level: 'E5',
  created_at: '2026-08-31T00:20:00Z',
  started_at: '2026-08-31T00:20:01Z',
  completed_at: '2026-08-31T00:30:00Z',
})
const fixture = run(ids.fixture, 'replay', {
  target_id: 'fixture',
  mixture: undefined,
  suite_ids: ['fixture-suite'],
  sample_limit: 4,
})
const runs = [
  fidelityLive,
  fidelityReference,
  g4,
  g2,
  controlledCandidate,
  controlledBaseline,
  liveCandidate,
  liveBaseline,
  fixture,
]

function draft(overrides: Partial<EvaluationCampaignDraft> = {}): EvaluationCampaignDraft {
  return {
    clientRequestID: ids.campaign,
    name: 'Recipe promotion',
    description: '',
    changeProfile: 'recipe',
    gateBindings: {
      g2_run_id: g2.id,
      g3_controlled_pair: {
        baseline_run_id: controlledBaseline.id,
        candidate_run_id: controlledCandidate.id,
      },
      g5_fidelity: {
        reference_run_id: fidelityReference.id,
        live_run_id: fidelityLive.id,
      },
    },
    ...overrides,
  }
}

describe('catalog-owned promotion campaign slots', () => {
  it('filters completed evidence by the server slot and excludes synthetic replay', () => {
    const profile = catalog.change_profiles[0]
    const g4 = profile.campaign_slots.find((slot) => slot.gate_id === 'G4')!
    expect(campaignRunOptions(runs, catalog, profile, g4).map((item) => item.id)).toEqual([ids.g4])
    expect(campaignRunOptions(runs, catalog, profile, g4)).not.toContainEqual(fixture)
  })

  it('does not apply G3 campaign-suite admission to independent gate evidence', () => {
    const profile = catalog.change_profiles[0]
    const g2Slot = profile.campaign_slots.find((slot) => slot.gate_id === 'G2')!
    expect(campaignRunOptions(runs, catalog, profile, g2Slot).map((item) => item.id)).toContain(
      g2.id,
    )
  })

  it('selects controlled-pair sources directly from compatible live Mixture runs', () => {
    const profile = catalog.change_profiles[0]
    const g3 = profile.campaign_slots.find((slot) => slot.gate_id === 'G3')!
    const baselines = controlledPairBaselineSourceOptions(runs, catalog, profile, g3)
    expect(baselines.map((item) => item.id)).toContain(liveBaseline.id)
    expect(
      controlledPairCandidateSourceOptions(runs, catalog, profile, g3, liveBaseline.id).map(
        (item) => item.id,
      ),
    ).toContain(liveCandidate.id)

    const authBlockedCatalog: EvaluationCatalog = {
      ...catalog,
      targets: catalog.targets.map((target) =>
        target.kind === 'mixture-of-models'
          ? { ...target, labels: { router_auth: 'dedicated-evaluation-credential-unavailable' } }
          : target,
      ),
    }
    expect(controlledPairBaselineSourceOptions(runs, authBlockedCatalog, profile, g3)).toEqual([])
  })

  it('preserves exact same-attempt cohort checks for controlled sources', () => {
    const mismatch = run('20000000-0000-4000-8000-000000000011', 'live', { seed: 7 })
    expect(pairedCampaignCohortMismatches(liveBaseline, mismatch)).toContain('seed')
  })

  it('requires an attested live reference followed by fresh exact-cohort live evidence', () => {
    const profile = catalog.change_profiles[0]
    const g5 = profile.campaign_slots.find((slot) => slot.gate_id === 'G5')!
    expect(fidelityReferenceOptions(runs, catalog, profile, g5).map((item) => item.id)).toContain(
      fidelityReference.id,
    )
    expect(
      fidelityLiveOptions(runs, catalog, profile, g5, fidelityReference.id).map((item) => item.id),
    ).toContain(fidelityLive.id)
    expect(fidelityReferenceOptions(runs, catalog, profile, g5)).not.toContainEqual(fixture)

    const weakJoint = run('20000000-0000-4000-8000-000000000012', 'live', {
      evidence_level: 'E5',
      suite_ids: ['normalized-suite'],
      track_ids: ['joint'],
      track_evidence_levels: { joint: 'E4' },
      started_at: '2026-08-31T00:20:01Z',
    })
    expect(
      fidelityLiveOptions([...runs, weakJoint], catalog, profile, g5, fidelityReference.id),
    ).not.toContainEqual(weakJoint)
  })

  it('blocks missing required slots while leaving advisory slots optional', () => {
    expect(validateEvaluationCampaignDraft(catalog, runs, draft(), true, true, true)).toBeNull()
    expect(
      validateEvaluationCampaignDraft(
        catalog,
        runs,
        draft({ gateBindings: { ...draft().gateBindings, g3_controlled_pair: undefined } }),
        true,
        true,
        true,
      ),
    ).toMatch(/required G3/i)
    expect(validateEvaluationCampaignDraft(catalog, runs, draft(), true, true, false)).toMatch(
      /complete run ledger/i,
    )
  })

  it('rejects reusing one run across independent campaign slots', () => {
    expect(
      validateEvaluationCampaignDraft(
        catalog,
        runs,
        draft({
          gateBindings: {
            ...draft().gateBindings,
            g4_run_id: g2.id,
          },
        }),
        true,
        true,
        true,
      ),
    ).toMatch(/cannot fill two slots/i)
  })

  it('builds only the v2 gate binding payload', () => {
    expect(buildEvaluationCampaignRequest(draft())).toEqual({
      client_request_id: ids.campaign,
      name: 'Recipe promotion',
      description: '',
      change_profile: 'recipe',
      gate_bindings: draft().gateBindings,
    })
    expect(buildEvaluationCampaignRequest(draft())).not.toHaveProperty('runs')
  })
})
