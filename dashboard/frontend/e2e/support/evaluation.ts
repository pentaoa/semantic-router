import type { Page, Route } from '@playwright/test'

import type {
  CreateEvaluationRunPayload,
  EvaluationCapacityLoadProtocol,
  EvaluationCapacitySLO,
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationCatalogMethod,
  EvaluationChangeProfileId,
  EvaluationMixture,
  EvaluationMode,
  EvaluationRun,
  EvaluationRunLedgerWarning,
  EvaluationTrackId,
  EvidenceLevel,
} from '../../src/types/evaluationPlane'
import type {
  CreateEvaluationCampaignPayload,
  EvaluationCampaign,
} from '../../src/types/evaluationCampaign'
import type {
  EvaluationComparison,
  EvaluationFailureSummary,
  EvaluationGate,
  EvaluationMetric,
  EvaluationReport,
} from '../../src/types/evaluationReport'
import type { CreateEvaluationControlledPairPayload } from '../../src/types/evaluationControlledPair'
import {
  EVALUATION_ATTESTATION_REVISION,
  EVALUATION_TRACK_IDS,
  TRACK_PRESENTATION,
} from '../../src/types/evaluationPlane'
import {
  gateApplicabilityForProfile,
  SUPPORTED_GATE_CONTRACT_VERSION,
} from '../../src/components/evaluation-plane/evaluationGateContract'
import {
  decodeEvaluationCapacityLoadProtocol,
  defaultEvaluationCapacityLoadProtocol,
  equalEvaluationCapacityLoadProtocol,
} from '../../src/utils/evaluationCapacitySLOContract'
import { evaluationCampaignExpectedAnchors } from '../../src/utils/evaluationCampaignBindingContract'
import { evaluationFidelityEvidence, evaluationPairedLiveEvidence } from './evaluationCampaign'

export function evaluationRunID(serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 0 || serial > 999_999_999_999) {
    throw new Error('Evaluation test run serial is outside the canonical UUID fixture range.')
  }
  return `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`
}

export const EVALUATION_RUN_IDS = {
  candidate: evaluationRunID(1),
  baseline: evaluationRunID(2),
  unpaired: evaluationRunID(3),
  live: evaluationRunID(4),
  failed: evaluationRunID(5),
  cancelled: evaluationRunID(6),
  olderBaseline: evaluationRunID(7),
  olderCandidate: evaluationRunID(8),
  secondBaseline: evaluationRunID(9),
  secondCandidate: evaluationRunID(10),
  campaign: evaluationRunID(11),
  candidateLive: evaluationRunID(12),
  baselineLive: evaluationRunID(13),
  candidateConfirmation: evaluationRunID(14),
  campaignG2: evaluationRunID(15),
  campaignG4: evaluationRunID(16),
  campaignG5Reference: evaluationRunID(17),
  campaignG5Live: evaluationRunID(18),
  campaignG7: evaluationRunID(19),
} as const

export const EVALUATION_MOM_ID =
  'mom-37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f'
export const EVALUATION_BASELINE_MOM_TARGET_ID = `baseline--${EVALUATION_MOM_ID}`
export const EVALUATION_MOM_TARGET_ID = `candidate--${EVALUATION_MOM_ID}`

export const EVALUATION_MOM: EvaluationMixture = {
  id: EVALUATION_MOM_ID,
  entrypoint_model: 'test-mom',
  aliases: ['test-mom'],
  recipe_name: 'default',
  recipe_description: 'Recipe-scoped Mixture-of-Models evaluation target.',
  recipe_digest: `sha256:${'1'.repeat(64)}`,
  pool_digest: `sha256:${'2'.repeat(64)}`,
  selector_policy_digest: `sha256:${'4'.repeat(64)}`,
  selector_digest: `sha256:${'5'.repeat(64)}`,
  adaptation_digest: `sha256:${'6'.repeat(64)}`,
  binding_digest: `sha256:${'3'.repeat(64)}`,
  model_arms: [
    {
      id: 'arm-fast',
      model: 'model-fast',
      provider_model_id_digest: `sha256:${'4'.repeat(64)}`,
      input_cost_per_million_tokens_usd: 0.1,
      output_cost_per_million_tokens_usd: 0.2,
      capabilities: ['chat'],
      modalities: ['text'],
      config_digest: `sha256:${'6'.repeat(64)}`,
    },
    {
      id: 'arm-strong',
      model: 'model-strong',
      provider_model_id_digest: `sha256:${'5'.repeat(64)}`,
      input_cost_per_million_tokens_usd: 0.4,
      output_cost_per_million_tokens_usd: 0.8,
      capabilities: ['chat', 'vision'],
      modalities: ['text', 'image'],
      config_digest: `sha256:${'7'.repeat(64)}`,
    },
  ],
  support_models: [],
  fallback_arm_id: 'arm-fast',
  decisions: [{ name: 'route', algorithm: 'static', arm_ids: ['arm-fast', 'arm-strong'] }],
}

const trackContracts: Record<
  EvaluationTrackId,
  { modes: EvaluationMode[]; metrics: string[]; evidenceLevels: EvidenceLevel[] }
> = {
  routing: {
    modes: ['replay', 'live'],
    metrics: [
      'routing.coverage',
      'routing.accuracy',
      'routing.abstention_rate',
      'routing.fallback_rate',
      'routing.latency_p95_ms',
    ],
    evidenceLevels: ['E0', 'E3'],
  },
  model_pool: {
    modes: ['replay', 'live'],
    metrics: [
      'model_pool.best_single_quality',
      'model_pool.oracle_quality',
      'model_pool.oracle_gain',
      'model_pool.unique_win_rate',
      'model_pool.selection_entropy_bits',
      'model_pool.selection_arm_coverage',
    ],
    evidenceLevels: ['E0', 'E4'],
  },
  joint: {
    modes: ['replay', 'live'],
    metrics: [
      'joint.realized_quality',
      'joint.oracle_regret',
      'joint.normalized_regret',
      'joint.reliability',
    ],
    evidenceLevels: ['E0', 'E5'],
  },
  agentic: {
    modes: ['replay'],
    metrics: ['agentic.success_rate', 'agentic.invalid_tool_rate'],
    evidenceLevels: ['E0'],
  },
  multimodal: {
    modes: ['replay', 'live'],
    metrics: ['multimodal.support_rate', 'multimodal.quality'],
    evidenceLevels: ['E0', 'E4', 'E5'],
  },
  preference: {
    modes: ['replay'],
    metrics: ['preference.agreement', 'preference.propensity_coverage'],
    evidenceLevels: ['E0'],
  },
  safety: {
    modes: ['replay'],
    metrics: ['safety.violation_rate', 'safety.violation_upper_95', 'safety.block_accuracy'],
    evidenceLevels: ['E0'],
  },
  capacity: {
    modes: ['replay', 'live'],
    metrics: [
      'capacity.throughput_rps',
      'capacity.latency_p95_ms',
      'capacity.success_rate',
      'capacity.cost_per_successful_request',
    ],
    evidenceLevels: ['E0', 'E5'],
  },
}

function diagnosticMethods(
  suiteID: string,
  trackIDs: readonly EvaluationTrackId[],
): EvaluationCatalogMethod[] {
  return trackIDs.map((trackID) => ({
    id: `${suiteID}.${trackID}.diagnostic.v1`,
    track_id: trackID,
    qualified_gate_ids: [],
    evidence_source: 'diagnostic_fixture',
    status: 'configured',
  }))
}

const CAMPAIGN_SLOT_NAMES = {
  G2: 'Hard policy',
  G3: 'Controlled paired-live value',
  G4: 'Declared-shift robustness',
  G5: 'Live fidelity',
  G6: 'Live fault-recovery continuity',
  G7: 'Cost / latency / capacity',
  G8: 'Shadow / canary',
  G9: 'Online preference',
} as const

const CAMPAIGN_DISPOSITIONS: Record<
  EvaluationChangeProfileId,
  readonly EvaluationCatalogCampaignSlot['disposition'][]
> = {
  schema_adapter: [
    'advisory',
    'advisory',
    'required',
    'advisory',
    'not_applicable',
    'advisory',
    'not_applicable',
    'not_applicable',
  ],
  recipe: [
    'required',
    'required',
    'required',
    'required',
    'not_applicable',
    'required',
    'advisory',
    'not_applicable',
  ],
  selector: [
    'required',
    'required',
    'required',
    'required',
    'advisory',
    'required',
    'required',
    'not_applicable',
  ],
  model_pool: [
    'required',
    'required',
    'required',
    'required',
    'advisory',
    'required',
    'required',
    'not_applicable',
  ],
  runtime_capacity: [
    'required',
    'advisory',
    'advisory',
    'required',
    'advisory',
    'required',
    'required',
    'not_applicable',
  ],
  agent_multimodal: [
    'required',
    'not_applicable',
    'required',
    'required',
    'required',
    'required',
    'required',
    'advisory',
  ],
  online_adaptation: [
    'required',
    'required',
    'required',
    'required',
    'required',
    'required',
    'required',
    'required',
  ],
}

function campaignSlots(profile: EvaluationChangeProfileId): EvaluationCatalogCampaignSlot[] {
  return (Object.keys(CAMPAIGN_SLOT_NAMES) as Array<keyof typeof CAMPAIGN_SLOT_NAMES>).map(
    (gateID, index) => {
      const disposition = CAMPAIGN_DISPOSITIONS[profile][index]
      const binding_kind =
        gateID === 'G3' ? 'controlled_pair' : gateID === 'G5' ? 'fidelity_pair' : 'run'
      const track_id = {
        G2: 'safety',
        G3: 'joint',
        G4: 'routing',
        G5: profile === 'agent_multimodal' ? 'multimodal' : 'joint',
        G6: 'agentic',
        G7: 'capacity',
        G8: 'preference',
        G9: 'preference',
      }[gateID] as EvaluationTrackId
      const minimum_evidence_level = {
        G2: 'E3',
        G3: 'E4',
        G4: 'E4',
        G5: profile === 'agent_multimodal' ? 'E4' : 'E5',
        G6: 'E5',
        G7: 'E5',
        G8: 'E5',
        G9: 'E5',
      }[gateID] as EvidenceLevel
      return {
        gate_id: gateID,
        name: CAMPAIGN_SLOT_NAMES[gateID],
        description: `${CAMPAIGN_SLOT_NAMES[gateID]} evidence selected under the server campaign contract.`,
        disposition,
        binding_kind,
        track_id,
        mode: 'live' as const,
        minimum_evidence_level,
        accepted_executor_ids:
          gateID === 'G5'
            ? profile === 'agent_multimodal'
              ? ['normalized-suite-live.v1']
              : ['normalized-suite-live.v1', 'live-runtime.v1']
            : gateID === 'G4'
              ? ['normalized-suite-live.v1']
              : ['live-runtime.v1'],
      }
    },
  )
}

export const evaluationCatalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: SUPPORTED_GATE_CONTRACT_VERSION,
  generated_at: '2026-08-29T00:00:00Z',
  change_profiles: [
    {
      id: 'schema_adapter',
      name: 'Schema / adapter',
      description: 'Strict schema and adapter parity changes.',
      campaign_slots: campaignSlots('schema_adapter'),
    },
    {
      id: 'recipe',
      name: 'Routing recipe',
      description: 'Recipe signal, decision, algorithm, and policy changes.',
      campaign_slots: campaignSlots('recipe'),
    },
    {
      id: 'selector',
      name: 'Selector / binding',
      description: 'Selector, projection, classifier, and binding changes.',
      campaign_slots: campaignSlots('selector'),
    },
    {
      id: 'model_pool',
      name: 'Model pool',
      description: 'Logical arm composition, capability, quality, and price changes.',
      campaign_slots: campaignSlots('model_pool'),
    },
    {
      id: 'runtime_capacity',
      name: 'Runtime / capacity',
      description: 'Serving runtime, placement, capacity, and transport changes.',
      campaign_slots: campaignSlots('runtime_capacity'),
    },
    {
      id: 'agent_multimodal',
      name: 'Agent / multimodal',
      description: 'Agent trajectory, tool, state, and multimodal changes.',
      campaign_slots: campaignSlots('agent_multimodal'),
    },
    {
      id: 'online_adaptation',
      name: 'Online adaptation',
      description: 'Online assignment, preference, feedback, and adaptive policy changes.',
      campaign_slots: campaignSlots('online_adaptation'),
    },
  ],
  tracks: EVALUATION_TRACK_IDS.map((id) => ({
    id,
    name: TRACK_PRESENTATION[id].label,
    description: TRACK_PRESENTATION[id].description,
    modes: trackContracts[id].modes,
    metrics: trackContracts[id].metrics,
    evidence_levels: trackContracts[id].evidenceLevels,
  })),
  suites: [
    {
      id: 'evaluation-smoke',
      executors: { replay: 'fixture-replay.v1' },
      name: 'Evaluation harness smoke',
      description: 'Deterministic plumbing evidence; it is not a live model-quality claim.',
      track_ids: [...EVALUATION_TRACK_IDS],
      modes: ['replay'],
      evidence_level: 'E0',
      case_count: 4,
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'builtin-v1',
      tags: ['smoke', 'deterministic'],
      methods: diagnosticMethods('evaluation-smoke', EVALUATION_TRACK_IDS),
    },
    {
      id: 'live-mom-core',
      executors: { replay: 'mom-cohort-replay.v1', live: 'live-runtime.v1' },
      name: 'Live Mixture-of-Models core',
      description:
        'One hidden-label cohort for Recipe routing, dense per-arm outcomes, and routed end-to-end utility.',
      track_ids: ['routing', 'model_pool', 'joint'],
      modes: ['replay', 'live'],
      evidence_level: 'E0',
      case_count: 64,
      campaign_eligible: true,
      campaign_minimum_cases: 59,
      revision: 'mom-campaign-cohort-v1',
      tags: ['campaign', 'mom', 'hidden-label', 'paired-live'],
      methods: [
        {
          id: 'routing.live-diagnostic.v1',
          track_id: 'routing',
          qualified_gate_ids: [],
          evidence_source: 'live_runtime',
          status: 'configured',
        },
        {
          id: 'model-pool.live-dense.v1',
          track_id: 'model_pool',
          qualified_gate_ids: [],
          evidence_source: 'live_runtime',
          status: 'configured',
        },
        {
          id: 'joint.live-routed-outcome.v1',
          track_id: 'joint',
          qualified_gate_ids: [],
          evidence_source: 'live_runtime',
          status: 'configured',
        },
      ],
    },
    {
      id: 'live-multimodal',
      executors: { live: 'live-runtime.v1' },
      name: 'Live multimodal',
      description: 'Diagnostic single-probe multimodal smoke; no grounding or privacy claim.',
      track_ids: ['multimodal'],
      modes: ['live'],
      evidence_level: 'E0',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'executor-v1',
      tags: [],
      methods: [
        {
          id: 'live-multimodal.multimodal.live.v1',
          track_id: 'multimodal',
          qualified_gate_ids: [],
          evidence_source: 'live_runtime',
          status: 'configured',
        },
      ],
    },
    {
      id: 'normalized-promotion-cohort',
      executors: {
        replay: 'normalized-suite-replay.v1',
        live: 'normalized-suite-live.v1',
      },
      name: 'Normalized promotion cohort',
      description: 'Server-declared declared-shift and reference-to-live collection capability.',
      track_ids: ['routing', 'joint'],
      modes: ['replay', 'live'],
      evidence_level: 'E0',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'normalized-promotion.v1',
      tags: ['normalized'],
      methods: [
        {
          id: 'normalized-promotion.routing.live.v1',
          track_id: 'routing',
          qualified_gate_ids: ['G4'],
          evidence_source: 'server_brokered_live',
          status: 'configured',
        },
        {
          id: 'normalized-promotion.joint.v1',
          track_id: 'joint',
          qualified_gate_ids: [],
          evidence_source: 'normalized_import',
          status: 'configured',
        },
      ],
    },
    {
      id: 'live-capacity',
      executors: { live: 'live-runtime.v1' },
      name: 'Live capacity',
      description: 'Repeated closed-loop capacity envelope against a frozen service objective.',
      track_ids: ['capacity'],
      modes: ['live'],
      evidence_level: 'E5',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'executor-v1',
      tags: [],
      methods: [
        {
          id: 'capacity.slo-envelope.v1',
          track_id: 'capacity',
          qualified_gate_ids: ['G7'],
          evidence_source: 'live_runtime',
          status: 'configured',
        },
      ],
    },
    {
      id: 'live-hard-policy',
      executors: { live: 'live-runtime.v1' },
      name: 'Live hard-policy enforcement',
      description: 'Requires server-owned policy configuration and enforcement observations.',
      track_ids: ['safety'],
      modes: ['live'],
      evidence_level: 'E5',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'executor-v1',
      tags: ['policy-ledger'],
      methods: [
        {
          id: 'safety.hard-policy-enforcement.v1',
          track_id: 'safety',
          qualified_gate_ids: ['G2'],
          evidence_source: 'live_runtime',
          status: 'data_required',
          reason:
            'Configure a server-owned hard-policy ledger endpoint with static rule proofs and dynamic enforcement observations.',
        },
      ],
    },
    {
      id: 'live-production-experiment',
      executors: { live: 'live-runtime.v1' },
      name: 'Live production experiment',
      description: 'Requires a sealed randomized production assignment and exposure ledger.',
      track_ids: ['preference'],
      modes: ['live'],
      evidence_level: 'E5',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'executor-v1',
      tags: ['production-ledger'],
      methods: [
        {
          id: 'preference.online-policy-evaluation.v1',
          track_id: 'preference',
          qualified_gate_ids: ['G8', 'G9'],
          evidence_source: 'live_production',
          status: 'data_required',
          reason:
            'Configure a sealed production experiment ledger with policy arms, assignments, exposures, outcomes, and propensities.',
        },
      ],
    },
  ],
  targets: [
    {
      id: 'fixture',
      name: 'Built-in replay fixture',
      description: 'Local deterministic harness validation with no production-quality claim.',
      kind: 'builtin-fixture',
      track_ids: [...EVALUATION_TRACK_IDS],
      modes: ['replay'],
      accepted_executors: { replay: ['fixture-replay.v1'] },
      evidence_level: 'E0',
      healthy: true,
    },
    {
      id: EVALUATION_BASELINE_MOM_TARGET_ID,
      name: 'test-mom · Baseline',
      description: 'Recipe-scoped Mixture-of-Models evaluation target.',
      kind: 'mixture-of-models',
      track_ids: [
        'routing',
        'model_pool',
        'joint',
        'agentic',
        'multimodal',
        'preference',
        'safety',
        'capacity',
      ],
      modes: ['replay', 'live'],
      accepted_executors: {
        replay: ['mom-cohort-replay.v1', 'normalized-suite-replay.v1'],
        live: ['live-runtime.v1', 'normalized-suite-live.v1'],
      },
      healthy: true,
      labels: { deployment: 'Baseline' },
      mixture: EVALUATION_MOM,
    },
    {
      id: EVALUATION_MOM_TARGET_ID,
      name: 'test-mom · Candidate',
      description: 'Recipe-scoped Mixture-of-Models evaluation target.',
      kind: 'mixture-of-models',
      track_ids: [
        'routing',
        'model_pool',
        'joint',
        'agentic',
        'multimodal',
        'preference',
        'safety',
        'capacity',
      ],
      modes: ['replay', 'live'],
      accepted_executors: {
        replay: ['mom-cohort-replay.v1', 'normalized-suite-replay.v1'],
        live: ['live-runtime.v1', 'normalized-suite-live.v1'],
      },
      healthy: true,
      labels: { deployment: 'Candidate' },
      mixture: EVALUATION_MOM,
    },
  ],
}

const DEFAULT_CAPACITY_SLO: EvaluationCapacitySLO = {
  schema_version: 'evaluation.v1',
  required_concurrency: 4,
  max_latency_p95_ms: 750,
  max_error_rate: 0.02,
  min_throughput_rps: 10,
  min_throughput_scaling_efficiency: 0.7,
}

export function evaluationRun(
  id: string,
  name: string,
  status: EvaluationRun['status'],
  createdAt: string,
  changeProfile: EvaluationChangeProfileId = 'recipe',
  overrides: Partial<EvaluationRun> = {},
): EvaluationRun {
  const active = status === 'running' || status === 'sealing'
  const mode = overrides.mode || (active ? 'live' : 'replay')
  const live = mode === 'live'
  const trackIDs: EvaluationTrackId[] = live
    ? ['routing', 'multimodal', 'capacity']
    : [...EVALUATION_TRACK_IDS]
  const suiteIDs = live
    ? ['live-mom-core', 'live-multimodal', 'live-capacity']
    : ['evaluation-smoke']
  const terminal = ['completed', 'failed', 'cancelled'].includes(status)
  const progress = {
    percent: status === 'completed' ? 100 : active ? 45 : terminal ? 55 : 0,
    completed: status === 'completed' ? trackIDs.length : active || terminal ? 3 : 0,
    total: trackIDs.length,
    message:
      status === 'running'
        ? 'Executing capacity track'
        : status === 'sealing'
          ? 'Sealing evaluation evidence'
          : status === 'failed'
            ? 'Worker exited before report publication'
            : status === 'cancelled'
              ? 'Execution cancelled'
              : status === 'completed'
                ? 'Evidence complete'
                : 'Awaiting execution',
  }
  const run: EvaluationRun = {
    schema_version: 'evaluation.v1',
    id,
    client_request_id: id,
    name,
    description: `${name} description`,
    status,
    mode,
    evidence_level: 'E0',
    target_id: live ? EVALUATION_MOM_TARGET_ID : 'fixture',
    change_profile: changeProfile,
    suite_ids: suiteIDs,
    track_ids: trackIDs,
    sample_limit: 4,
    concurrency: 4,
    seed: 42,
    progress,
    created_at: createdAt,
    started_at: status === 'pending' ? undefined : createdAt,
    completed_at: terminal ? '2026-08-29T00:10:00Z' : undefined,
    error: status === 'failed' ? 'Evaluation worker exited before a report was sealed.' : undefined,
    mixture: live ? EVALUATION_MOM : undefined,
  }
  const merged = {
    ...run,
    ...overrides,
    client_request_id: overrides.id || id,
    progress: { ...progress, ...overrides.progress },
  }
  const trackEvidenceLevels =
    overrides.track_evidence_levels ||
    Object.fromEntries(merged.track_ids.map((trackID) => [trackID, merged.evidence_level]))
  const capacitySLORequired = merged.mode === 'live' && merged.track_ids.includes('capacity')
  const capacityLoadProtocol = capacitySLORequired
    ? overrides.capacity_load_protocol || defaultEvaluationCapacityLoadProtocol(merged.concurrency)
    : undefined
  return {
    ...merged,
    track_evidence_levels: trackEvidenceLevels,
    ...(capacitySLORequired
      ? {
          capacity_slo: overrides.capacity_slo || DEFAULT_CAPACITY_SLO,
          capacity_load_protocol: capacityLoadProtocol,
        }
      : { capacity_slo: undefined, capacity_load_protocol: undefined }),
  }
}

export const defaultEvaluationRuns = [
  evaluationRun(
    EVALUATION_RUN_IDS.candidate,
    'Candidate recipe',
    'completed',
    '2026-08-29T00:00:00Z',
    'recipe',
    {
      baseline_run_id: EVALUATION_RUN_IDS.baseline,
    },
  ),
  evaluationRun(
    EVALUATION_RUN_IDS.baseline,
    'Production baseline',
    'completed',
    '2026-08-28T00:00:00Z',
  ),
  evaluationRun(
    EVALUATION_RUN_IDS.unpaired,
    'Unpaired diagnostic',
    'completed',
    '2026-08-27T12:00:00Z',
  ),
  evaluationRun(
    EVALUATION_RUN_IDS.live,
    'Live AMD validation',
    'running',
    '2026-08-27T00:00:00Z',
    'runtime_capacity',
  ),
  evaluationRun(EVALUATION_RUN_IDS.failed, 'Failed diagnostic', 'failed', '2026-08-26T00:00:00Z'),
  evaluationRun(
    EVALUATION_RUN_IDS.cancelled,
    'Cancelled diagnostic',
    'cancelled',
    '2026-08-25T00:00:00Z',
  ),
]

const gateTrackIDs: Partial<Record<`G${number}`, EvaluationGate['track_id']>> = {
  G2: 'safety',
  G3: 'joint',
  G4: 'routing',
  G5: 'joint',
  G6: 'agentic',
  G7: 'capacity',
  G9: 'preference',
}

const gateEvidenceLevels: EvidenceLevel[] = [
  'E0',
  'E0',
  'E3',
  'E4',
  'E4',
  'E5',
  'E5',
  'E5',
  'E5',
  'E5',
]

const gateOwners = [
  'evaluation-platform',
  'evaluation-platform',
  'router-policy',
  'recipe-and-model-pool',
  'evaluation-workload',
  'router-and-serving-runtime',
  'agent-runtime',
  'serving-capacity',
  'release-operations',
  'online-learning',
]

const gateEvidenceRefs = [
  ['run-manifest.json', 'lineage.json', 'provenance.json', 'checksums.sha256'],
  ['run-manifest.json', 'records.jsonl'],
  ['records.jsonl', 'metric:safety.violation_rate'],
  ['metrics.json', 'metric:joint.normalized_regret'],
  ['records.jsonl', 'metric:routing.accuracy'],
  ['records.jsonl', 'provenance.json'],
  ['records.jsonl', 'metric:agentic.success_rate'],
  ['records.jsonl', 'metrics.json'],
  ['run-manifest.json', 'records.jsonl'],
  ['records.jsonl', 'metric:preference.propensity_coverage'],
]

function evaluationGates(run: EvaluationRun): EvaluationGate[] {
  const coverage = {
    evaluated: 4,
    total: 4,
    fraction: 1,
    unavailable: 0,
    confidence_level: 0.95,
    confidence_interval: [0.51, 1] as [number, number],
  }
  return gateApplicabilityForProfile(run.change_profile).map((gate, index) => {
    const foundational = index === 0 || index === 1
    const isNotApplicable = gate.disposition === 'not_applicable'
    return {
      ...gate,
      track_id: gateTrackIDs[gate.id],
      verdict: isNotApplicable
        ? ('not_applicable' as const)
        : foundational
          ? ('pass' as const)
          : ('unavailable' as const),
      change_profile: run.change_profile,
      contract_version: SUPPORTED_GATE_CONTRACT_VERSION,
      evidence_refs: gateEvidenceRefs[index],
      evidence_level: gateEvidenceLevels[index],
      observed: isNotApplicable || !foundational ? null : 1,
      threshold:
        isNotApplicable || !foundational
          ? undefined
          : { operator: '>=', value: 1, unit: index === 0 ? 'fraction' : 'boolean' },
      sample_count: isNotApplicable ? undefined : 4,
      coverage: isNotApplicable ? undefined : coverage,
      owner: gateOwners[index],
      evaluated_at: '2026-08-29T00:10:00Z',
      rationale: foundational
        ? 'The server-validated bundle satisfies this foundational gate.'
        : isNotApplicable
          ? 'This gate is not required by the selected change profile.'
          : 'The E0 run produced diagnostics, but no server-owned qualified attestation exists; this gate cannot pass.',
    }
  })
}

function diagnosticMetric(trackID: EvaluationTrackId): EvaluationMetric {
  const metrics: Record<EvaluationTrackId, EvaluationMetric> = {
    routing: {
      id: 'routing.accuracy',
      name: 'Routing accuracy',
      track_id: 'routing',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    model_pool: {
      id: 'model_pool.oracle_gain',
      name: 'Pool oracle gain',
      track_id: 'model_pool',
      value: 0.08,
      unit: 'score',
      direction: 'higher_is_better',
    },
    joint: {
      id: 'joint.realized_quality',
      name: 'System quality',
      track_id: 'joint',
      value: 0.91,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    agentic: {
      id: 'agentic.success_rate',
      name: 'Agent success rate',
      track_id: 'agentic',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    multimodal: {
      id: 'multimodal.support_rate',
      name: 'Multimodal support rate',
      track_id: 'multimodal',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    preference: {
      id: 'preference.agreement',
      name: 'Preference agreement',
      track_id: 'preference',
      value: 0.8,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    safety: {
      id: 'safety.violation_rate',
      name: 'Safety violation rate',
      track_id: 'safety',
      value: 0,
      unit: 'violations/case',
      direction: 'lower_is_better',
    },
    capacity: {
      id: 'capacity.latency_p95_ms',
      name: 'P95 latency',
      track_id: 'capacity',
      value: 342,
      unit: 'ms',
      direction: 'lower_is_better',
    },
  }
  return {
    ...metrics[trackID],
    baseline_value: null,
    delta: null,
    confidence_interval:
      metrics[trackID].unit === 'fraction' ? ([0.51, 1] as [number, number]) : undefined,
    sample_count: 4,
  }
}

export function evaluationReport(run = defaultEvaluationRuns[0]): EvaluationReport {
  const totalRecords = run.track_ids.length * 4
  const coverage = {
    evaluated: totalRecords,
    total: totalRecords,
    fraction: 1,
    unavailable: 0,
  }
  const gates = evaluationGates(run)
  const metrics = run.track_ids.map(diagnosticMetric)
  const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  return {
    schema_version: 'evaluation.v1',
    attestation_revision: EVALUATION_ATTESTATION_REVISION,
    run,
    summary: {
      verdict: gates.some(
        (gate) => gate.disposition === 'required' && gate.verdict === 'unavailable',
      )
        ? 'unavailable'
        : 'pass',
      quality_score: null,
      latency_p95_ms: null,
      runtime_cost: null,
      capacity_tco: null,
      coverage,
      passed_gates: gates.filter((gate) => gate.verdict === 'pass').length,
      failed_gates: gates.filter((gate) => gate.verdict === 'fail').length,
      unavailable_gates: gates.filter((gate) => gate.verdict === 'unavailable').length,
    },
    tracks: run.track_ids.map((trackID) => ({
      track_id: trackID,
      status: 'completed' as const,
      evidence_level: run.evidence_level,
      summary: `${TRACK_PRESENTATION[trackID].label} diagnostic observation completed.`,
      coverage: { evaluated: 4, total: 4, fraction: 1, unavailable: 0 },
      metrics: [diagnosticMetric(trackID)],
      gates: gates.filter((gate) => gate.track_id === trackID),
    })),
    metrics,
    gates,
    costs: {
      runtime: {
        amount: 0.03195,
        currency: 'USD',
        input_tokens: 12000,
        output_tokens: 6000,
        gpu_seconds: 0.39,
      },
      evaluation_overhead: { amount: 0.00165, currency: 'USD' },
      capacity_tco: { amount: 0.039, currency: 'USD', gpu_seconds: 0.39, energy_kwh: 0.0018 },
    },
    recommendations: [
      'Treat these E0 observations as diagnostics, not a promotion claim.',
      'Collect benchmark-native receipts and qualified robustness evidence before promotion.',
    ],
    provenance: {
      schema_version: 'evaluation.v1',
      generated_at: '2026-08-29T00:10:00Z',
      code_revision: '0123456789abcdef0123456789abcdef01234567',
      benchmark_revisions: Object.fromEntries(
        run.suite_ids.map((id) => [id, id === 'evaluation-smoke' ? 'builtin-v1' : 'executor-v1']),
      ),
      workload_snapshot_digest: digest,
      policy_snapshot_digest: run.baseline_run_id
        ? 'sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        : digest,
      binding_snapshot_digest: run.baseline_run_id
        ? 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        : digest,
      pool_snapshot_digest: digest,
      environment_snapshot_digest: digest,
      target_id: run.target_id,
      seed: 42,
      redaction_policy: 'public-safe-v1',
    },
    artifacts: [
      {
        id: 'metrics-json',
        name: 'metrics.json',
        kind: 'json',
        uri: 'metrics.json',
        digest,
        media_type: 'application/json',
        size_bytes: 1024,
      },
      {
        id: 'gates-json',
        name: 'gates.json',
        kind: 'json',
        uri: 'gates.json',
        digest,
        media_type: 'application/json',
        size_bytes: 1024,
      },
      {
        id: 'provenance-json',
        name: 'provenance.json',
        kind: 'json',
        uri: 'provenance.json',
        digest,
        media_type: 'application/json',
        size_bytes: 512,
      },
      {
        id: 'failure-summary-json',
        name: 'failure-summary.json',
        kind: 'json',
        uri: 'failure-summary.json',
        digest,
        media_type: 'application/json',
        size_bytes: 512,
      },
      {
        id: 'checksums-sha256',
        name: 'checksums.sha256',
        kind: 'sha256',
        uri: 'checksums.sha256',
        digest,
        media_type: 'text/plain',
        size_bytes: 325,
      },
    ],
  }
}

export const evaluationComparison: EvaluationComparison = {
  schema_version: 'evaluation.v1',
  attestation_revision: EVALUATION_ATTESTATION_REVISION,
  baseline_run_id: EVALUATION_RUN_IDS.baseline,
  candidate_run_id: EVALUATION_RUN_IDS.candidate,
  verdict: 'unavailable',
  summary: 'Diagnostic deltas are favorable, but E0 evidence cannot support promotion.',
  metrics: [
    {
      id: 'joint.realized_quality',
      name: 'System quality',
      track_id: 'joint',
      value: 0.91,
      unit: 'fraction',
      direction: 'higher_is_better',
      baseline_value: 0.88,
      delta: 0.03,
      sample_count: 4,
    },
    {
      id: 'capacity.latency_p95_ms',
      name: 'P95 latency',
      track_id: 'capacity',
      value: 342,
      unit: 'ms',
      direction: 'lower_is_better',
      baseline_value: 370,
      delta: -28,
      sample_count: 4,
    },
  ],
  statistics: [
    {
      id: 'joint.normalized_regret',
      track_id: 'joint',
      analysis_unit: 'case_normalized_regret',
      direction: 'lower_is_better',
      non_inferiority_margin: 0.05,
      baseline_value: 0.12,
      candidate_value: 0.1,
      delta: -0.02,
      confidence_level: 0.95,
      delta_confidence_interval: [],
      candidate_confidence_interval: [],
      sample_count: 4,
      verdict: 'unavailable',
    },
  ],
  gates: evaluationReport().gates.map((gate) =>
    gate.id === 'G3'
      ? {
          ...gate,
          verdict: 'unavailable',
          evidence_refs: [
            'server-reduction:comparative-g3.v1',
            `run:baseline:${EVALUATION_RUN_IDS.baseline}`,
            `run:candidate:${EVALUATION_RUN_IDS.candidate}`,
            'comparison-statistic:joint.normalized_regret',
          ],
          evidence_level: 'E4',
          observed: undefined,
          threshold: undefined,
          sample_count: 4,
          owner: 'recipe-and-model-pool',
          rationale: 'The paired sample is below the minimum analysis-unit requirement.',
        }
      : gate,
  ),
  recommendations: ['Collect qualified robustness evidence before a guarded live trial.'],
  created_at: '2026-08-29T00:10:00Z',
}

function evaluationCampaign(request: CreateEvaluationCampaignPayload): EvaluationCampaign {
  const campaignDigest = `sha256:${'c'.repeat(64)}`
  const evidence = evaluationCampaignExpectedAnchors(request.gate_bindings).map((anchor, index) => {
    const digit = ((index + 1) % 15).toString(16)
    return {
      ...anchor,
      ...(anchor.slot_id === 'g3' && anchor.binding_role === 'baseline'
        ? {}
        : { candidate_subject_digest: `sha256:${'e'.repeat(64)}` }),
      manifest_semantic_digest: `sha256:${digit.repeat(64)}`,
      manifest_artifact_digest: `sha256:${((index + 2) % 15).toString(16).repeat(64)}`,
      report_digest: `sha256:${((index + 4) % 15).toString(16).repeat(64)}`,
      private_receipt_digest: `sha256:${((index + 7) % 15).toString(16).repeat(64)}`,
      execution_attestation_digest: `sha256:${((index + 10) % 15).toString(16).repeat(64)}`,
    }
  })
  const baselineLive = evidence.find(
    (anchor) => anchor.slot_id === 'g3' && anchor.binding_role === 'baseline',
  )
  const candidateLive = evidence.find(
    (anchor) => anchor.slot_id === 'g3' && anchor.binding_role === 'candidate',
  )
  const fidelityReference = evidence.find(
    (anchor) => anchor.slot_id === 'g5' && anchor.binding_role === 'reference',
  )
  const fidelityLive = evidence.find(
    (anchor) => anchor.slot_id === 'g5' && anchor.binding_role === 'live',
  )
  const profile = evaluationCatalog.change_profiles.find(
    (candidate) => candidate.id === request.change_profile,
  )!
  const gateDefinitions = [
    { id: 'G0', name: 'Reproducibility', disposition: 'required' as const },
    { id: 'G1', name: 'Static correctness', disposition: 'required' as const },
    ...profile.campaign_slots.map((slot) => ({
      id: slot.gate_id,
      name: slot.name,
      disposition: slot.disposition,
    })),
  ]
  const gates = gateDefinitions.map((gate) => {
    const disposition = gate.disposition
    if (disposition === 'not_applicable') {
      return {
        id: gate.id,
        name: gate.name,
        disposition,
        verdict: 'not_applicable' as const,
        evidence_level: 'E5' as const,
        source: 'campaign_contract',
        evidence_refs: [],
        rationale: 'The gate is not applicable to this change profile.',
      }
    }
    return {
      id: gate.id,
      name: gate.name,
      disposition,
      verdict: 'pass' as const,
      evidence_level: 'E5' as const,
      source: gate.id === 'G0' || gate.id === 'G1' ? 'server_anchors' : 'gate_binding',
      evidence_refs: [],
      rationale: `${gate.name} is supported by sealed campaign evidence.`,
    }
  })
  const requiredGates = gates.filter((gate) => gate.disposition === 'required')
  const verdict = requiredGates.some((gate) => gate.verdict === 'fail')
    ? ('fail' as const)
    : requiredGates.every((gate) => gate.verdict === 'pass')
      ? ('pass' as const)
      : ('unavailable' as const)
  return {
    schema_version: 'evaluation.v1',
    contract_version: 'evaluation-campaign.v2',
    id: request.client_request_id,
    name: request.name,
    description: request.description,
    change_profile: request.change_profile,
    status: 'decided',
    gate_bindings: request.gate_bindings,
    manifest_digest: campaignDigest,
    created_at: '2026-08-30T02:00:00Z',
    decision: {
      schema_version: 'evaluation.v1',
      contract_version: 'evaluation-campaign.v2',
      attestation_revision: EVALUATION_ATTESTATION_REVISION,
      campaign_id: request.client_request_id,
      campaign_digest: campaignDigest,
      decision_digest: `sha256:${'d'.repeat(64)}`,
      verdict,
      summary:
        verdict === 'pass'
          ? 'All required promotion campaign gates passed.'
          : 'One or more required promotion campaign gates remain unavailable.',
      gates,
      evidence,
      ...(baselineLive && candidateLive
        ? {
            paired_live_evidence: evaluationPairedLiveEvidence(baselineLive, candidateLive),
          }
        : {}),
      ...(fidelityReference && fidelityLive
        ? { fidelity_evidence: evaluationFidelityEvidence(fidelityReference, fidelityLive) }
        : {}),
      recommendations: ['Advance through the guarded rollout defined for this change profile.'],
      created_at: '2026-08-30T02:00:00Z',
    },
  }
}

interface MockEvaluationPlaneOptions {
  mutationDelayMs?: number
  campaignGetDelayMs?: number
  catalogDelayMs?: number
  ledgerDelayMs?: number
  runPageSize?: number
  reportDelayMs?: number
  reportMetricCount?: number
  ledgerWarnings?: EvaluationRunLedgerWarning[]
  ledgerWarningCount?: number
  failFirstLoadMore?: boolean
  failFirstCancel?: boolean
  failFirstControlledPair?: boolean
  eventStreamCloseOnce?: boolean
  completeRunOnEventStream?: string
  reportFailureIDs?: string[]
  reportFailureStatus?: number
  diagnosticArtifactBodies?: {
    failureSummary?: string
    capacityProfile?: string
  }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function equalCapacitySLO(
  left: EvaluationCapacitySLO | undefined,
  right: EvaluationCapacitySLO | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    left.schema_version === right.schema_version &&
    left.required_concurrency === right.required_concurrency &&
    left.max_latency_p95_ms === right.max_latency_p95_ms &&
    left.max_error_rate === right.max_error_rate &&
    left.min_throughput_rps === right.min_throughput_rps &&
    left.min_throughput_scaling_efficiency === right.min_throughput_scaling_efficiency
  )
}

function validCapacityLoadProtocol(
  value: EvaluationCapacityLoadProtocol | undefined,
  concurrency: number,
): boolean {
  if (!value) return false
  try {
    decodeEvaluationCapacityLoadProtocol(value, concurrency)
    return true
  } catch {
    return false
  }
}

function exactCohortMatches(left: EvaluationRun, right: EvaluationRun): boolean {
  return (
    left.mode === right.mode &&
    left.target_id === right.target_id &&
    left.change_profile === right.change_profile &&
    left.sample_limit === right.sample_limit &&
    left.concurrency === right.concurrency &&
    equalCapacitySLO(left.capacity_slo, right.capacity_slo) &&
    equalEvaluationCapacityLoadProtocol(
      left.capacity_load_protocol,
      right.capacity_load_protocol,
    ) &&
    left.seed === right.seed &&
    sameMembers(left.suite_ids, right.suite_ids) &&
    sameMembers(left.track_ids, right.track_ids)
  )
}

function controlledPairCohortMatches(left: EvaluationRun, right: EvaluationRun): boolean {
  return (
    left.target_id !== right.target_id &&
    left.mixture?.id === right.mixture?.id &&
    left.mixture?.recipe_name === right.mixture?.recipe_name &&
    left.mode === right.mode &&
    left.change_profile === right.change_profile &&
    left.sample_limit === right.sample_limit &&
    left.concurrency === right.concurrency &&
    equalCapacitySLO(left.capacity_slo, right.capacity_slo) &&
    equalEvaluationCapacityLoadProtocol(
      left.capacity_load_protocol,
      right.capacity_load_protocol,
    ) &&
    left.seed === right.seed &&
    sameMembers(left.suite_ids, right.suite_ids) &&
    sameMembers(left.track_ids, right.track_ids)
  )
}

function createRequestMatchesRun(request: CreateEvaluationRunPayload, run: EvaluationRun): boolean {
  return (
    request.name.trim() === run.name &&
    request.description.trim() === run.description &&
    request.mode === run.mode &&
    request.target_id === run.target_id &&
    request.change_profile === run.change_profile &&
    request.sample_limit === run.sample_limit &&
    request.concurrency === run.concurrency &&
    equalCapacitySLO(request.capacity_slo, run.capacity_slo) &&
    equalEvaluationCapacityLoadProtocol(
      request.capacity_load_protocol,
      run.capacity_load_protocol,
    ) &&
    request.seed === run.seed &&
    (request.baseline_run_id || '') === (run.baseline_run_id || '') &&
    sameMembers(request.suite_ids, run.suite_ids) &&
    sameMembers(request.track_ids, run.track_ids)
  )
}

function failureSummary(run: EvaluationRun): EvaluationFailureSummary {
  return {
    schema_version: 'evaluation.v1',
    total_records: run.track_ids.length * 4,
    failed: 0,
    unavailable: 0,
    by_track: [...run.track_ids].sort().map((track_id) => ({
      track_id,
      succeeded: 4,
      failed: 0,
      unavailable: 0,
    })),
  }
}

async function fulfillJSON(route: Route, status: number, payload: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

async function fulfillError(route: Route, status: number, message: string): Promise<void> {
  await fulfillJSON(route, status, { error: { message } })
}

export async function mockEvaluationPlane(
  page: Page,
  initialRuns = defaultEvaluationRuns,
  options: MockEvaluationPlaneOptions = {},
) {
  let runs = [...initialRuns]
  const createAttempts: CreateEvaluationRunPayload[] = []
  const createdRequests: CreateEvaluationRunPayload[] = []
  const reportRequests: string[] = []
  const comparisonRequests: Array<{ baselineRunID: string; candidateRunID: string }> = []
  const campaignRequests: CreateEvaluationCampaignPayload[] = []
  const controlledPairRequests: CreateEvaluationControlledPairPayload[] = []
  const campaignGetRequests: string[] = []
  const campaigns = new Map<string, EvaluationCampaign>()
  const runRequests: string[] = []
  let cancelCount = 0
  let deleteCount = 0
  let startCount = 0
  let eventStreamCount = 0
  let rejectCampaignGets = false
  const ledgerWarnings = options.ledgerWarnings || []
  const ledgerWarningCount = options.ledgerWarningCount ?? ledgerWarnings.length
  let firstLoadMorePending = options.failFirstLoadMore === true
  let firstCancelPending = options.failFirstCancel === true
  let firstControlledPairPending = options.failFirstControlledPair === true
  const controlledPairRunIDs = new Set<string>()
  let ledgerRequestCount = 0
  const mutationDelay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, options.mutationDelayMs || 0))

  await page.route('**/api/evaluation/v1/catalog', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, options.catalogDelayMs || 0))
    await fulfillJSON(route, 200, evaluationCatalog)
  })
  await page.route('**/api/evaluation/v1/controlled-pairs', async (route) => {
    if (route.request().method() !== 'POST') {
      await fulfillError(route, 405, 'method not allowed')
      return
    }
    const raw = route.request().postDataJSON() as Record<string, unknown>
    const request = raw as unknown as CreateEvaluationControlledPairPayload
    controlledPairRequests.push(request)
    const allowed = [
      'client_request_id',
      'baseline_source_run_id',
      'candidate_source_run_id',
      'baseline_run_id',
      'candidate_run_id',
    ]
    const ids = allowed.map((field) => raw[field])
    const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const baselineSource = runs.find((run) => run.id === request.baseline_source_run_id)
    const candidateSource = runs.find((run) => run.id === request.candidate_source_run_id)
    if (
      Object.keys(raw).length !== allowed.length ||
      Object.keys(raw).some((field) => !allowed.includes(field)) ||
      ids.some((id) => typeof id !== 'string' || !canonical.test(id)) ||
      new Set(ids).size !== ids.length ||
      !baselineSource ||
      !candidateSource ||
      baselineSource.status !== 'completed' ||
      candidateSource.status !== 'completed' ||
      baselineSource.mode !== 'live' ||
      candidateSource.mode !== 'live' ||
      !controlledPairCohortMatches(baselineSource, candidateSource)
    ) {
      await fulfillError(
        route,
        400,
        'invalid evaluation request: controlled pair contract rejected',
      )
      return
    }
    if (firstControlledPairPending) {
      firstControlledPairPending = false
      await fulfillError(
        route,
        409,
        'controlled pairing is unavailable because two worker slots are required',
      )
      return
    }
    const controlledProgress = {
      percent: 35,
      completed: Math.max(1, Math.floor(baselineSource.track_ids.length / 2)),
      total: baselineSource.track_ids.length,
      message: 'AB/BA block admitted by server coordinator',
    }
    const baselineRun: EvaluationRun = {
      ...baselineSource,
      id: request.baseline_run_id,
      client_request_id: request.baseline_run_id,
      name: 'Controlled baseline AB/BA',
      description: 'Server-owned abba-interleaved.v1 execution',
      status: 'running',
      baseline_run_id: undefined,
      progress: controlledProgress,
      created_at: '2026-08-31T01:00:00Z',
      started_at: '2026-08-31T01:00:01Z',
      completed_at: undefined,
    }
    const candidateRun: EvaluationRun = {
      ...candidateSource,
      id: request.candidate_run_id,
      client_request_id: request.candidate_run_id,
      name: 'Controlled candidate AB/BA',
      description: 'Server-owned abba-interleaved.v1 execution',
      status: 'running',
      baseline_run_id: baselineRun.id,
      progress: controlledProgress,
      created_at: '2026-08-31T01:00:00Z',
      started_at: '2026-08-31T01:00:01Z',
      completed_at: undefined,
    }
    controlledPairRunIDs.add(baselineRun.id)
    controlledPairRunIDs.add(candidateRun.id)
    runs = [candidateRun, baselineRun, ...runs]
    await fulfillJSON(route, 201, {
      schema_version: 'evaluation.v1',
      contract_version: 'evaluation-controlled-pair.v1',
      id: request.client_request_id,
      protocol: 'abba-interleaved.v1',
      baseline_source_run_id: request.baseline_source_run_id,
      candidate_source_run_id: request.candidate_source_run_id,
      baseline_run: baselineRun,
      candidate_run: candidateRun,
    })
  })
  await page.route(
    /\/api\/evaluation\/v1\/campaigns(?:\/[^/?]+(?:\/decision)?)?(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url())
      const parts = url.pathname.split('/').filter(Boolean)
      const campaignIndex = parts.indexOf('campaigns')
      const id = campaignIndex >= 0 ? decodeURIComponent(parts[campaignIndex + 1] || '') : ''
      if (route.request().method() === 'GET') {
        campaignGetRequests.push(id)
        const shouldFail = rejectCampaignGets
        await new Promise<void>((resolve) => setTimeout(resolve, options.campaignGetDelayMs || 0))
        if (shouldFail) {
          await fulfillError(route, 503, 'temporary campaign read failure')
          return
        }
        const campaign = campaigns.get(id)
        if (!campaign) {
          await fulfillError(route, 404, 'not found: evaluation campaign')
          return
        }
        await fulfillJSON(
          route,
          200,
          parts[campaignIndex + 2] === 'decision' ? campaign.decision : campaign,
        )
        return
      }
      if (route.request().method() !== 'POST' || id) {
        await fulfillError(route, 405, 'method not allowed')
        return
      }
      const raw = route.request().postDataJSON() as Record<string, unknown>
      const request = raw as unknown as CreateEvaluationCampaignPayload
      campaignRequests.push(request)
      const allowed = new Set([
        'client_request_id',
        'name',
        'description',
        'change_profile',
        'gate_bindings',
      ])
      const profile = evaluationCatalog.change_profiles.find(
        (candidate) => candidate.id === request.change_profile,
      )
      const bindings = request.gate_bindings
      const bindingIDs = {
        G2: bindings?.g2_run_id ? [bindings.g2_run_id] : [],
        G3: bindings?.g3_controlled_pair
          ? [
              bindings.g3_controlled_pair.baseline_run_id,
              bindings.g3_controlled_pair.candidate_run_id,
            ]
          : [],
        G4: bindings?.g4_run_id ? [bindings.g4_run_id] : [],
        G5: bindings?.g5_fidelity
          ? [bindings.g5_fidelity.reference_run_id, bindings.g5_fidelity.live_run_id]
          : [],
        G6: bindings?.g6_run_id ? [bindings.g6_run_id] : [],
        G7: bindings?.g7_run_id ? [bindings.g7_run_id] : [],
        G8: bindings?.g8_run_id ? [bindings.g8_run_id] : [],
        G9: bindings?.g9_run_id ? [bindings.g9_run_id] : [],
      }
      const selectedIDs = Object.values(bindingIDs).flat()
      const selectedRuns = selectedIDs.map((runID) => runs.find((run) => run.id === runID))
      const baselineLive = bindings?.g3_controlled_pair
        ? runs.find((run) => run.id === bindings.g3_controlled_pair?.baseline_run_id)
        : undefined
      const candidateLive = bindings?.g3_controlled_pair
        ? runs.find((run) => run.id === bindings.g3_controlled_pair?.candidate_run_id)
        : undefined
      const fidelityReference = bindings?.g5_fidelity
        ? runs.find((run) => run.id === bindings.g5_fidelity?.reference_run_id)
        : undefined
      const fidelityLive = bindings?.g5_fidelity
        ? runs.find((run) => run.id === bindings.g5_fidelity?.live_run_id)
        : undefined
      const invalid =
        Object.keys(raw).some((key) => !allowed.has(key)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.client_request_id || '',
        ) ||
        !request.name ||
        request.name.trim() !== request.name ||
        request.description.trim() !== request.description ||
        !profile ||
        !bindings ||
        profile?.campaign_slots.some(
          (slot) => slot.disposition === 'required' && bindingIDs[slot.gate_id].length === 0,
        ) ||
        selectedRuns.some(
          (run) =>
            !run || run.status !== 'completed' || run.change_profile !== request.change_profile,
        ) ||
        new Set(selectedIDs).size !== selectedIDs.length ||
        (bindings?.g3_controlled_pair !== undefined &&
          (!baselineLive ||
            !candidateLive ||
            baselineLive.id === candidateLive.id ||
            baselineLive.mode !== 'live' ||
            candidateLive.mode !== 'live' ||
            candidateLive.baseline_run_id !== baselineLive.id ||
            !controlledPairCohortMatches(baselineLive, candidateLive))) ||
        (bindings?.g5_fidelity !== undefined &&
          (!fidelityReference ||
            !fidelityLive ||
            fidelityReference.mode !== 'live' ||
            fidelityLive.mode !== 'live' ||
            !fidelityReference.completed_at ||
            !fidelityLive.started_at ||
            Date.parse(fidelityLive.started_at) <= Date.parse(fidelityReference.completed_at) ||
            fidelityReference.sample_limit !== fidelityLive.sample_limit ||
            fidelityReference.seed !== fidelityLive.seed ||
            !sameMembers(fidelityReference.suite_ids, fidelityLive.suite_ids) ||
            !sameMembers(fidelityReference.track_ids, fidelityLive.track_ids)))
      if (invalid) {
        await fulfillError(route, 400, 'invalid evaluation request: campaign contract rejected')
        return
      }
      if (ledgerWarningCount > 0) {
        await fulfillError(
          route,
          409,
          'conflict: evaluation run ledger is incomplete; repair quarantined evidence before deciding',
        )
        return
      }
      const existing = campaigns.get(request.client_request_id)
      if (existing) {
        await fulfillJSON(route, 201, existing)
        return
      }
      const campaign = evaluationCampaign(request)
      campaigns.set(campaign.id, campaign)
      await mutationDelay()
      await fulfillJSON(route, 201, campaign)
    },
  )
  await page.route('**/api/evaluation/v1/compare?*', async (route) => {
    if (ledgerWarningCount > 0) {
      await fulfillError(
        route,
        409,
        'conflict: evaluation run ledger is incomplete; repair quarantined evidence before comparing runs',
      )
      return
    }
    const url = new URL(route.request().url())
    const baselineRunID = url.searchParams.get('baseline_run_id') || ''
    const candidateRunID = url.searchParams.get('candidate_run_id') || ''
    comparisonRequests.push({ baselineRunID, candidateRunID })
    const baseline = runs.find((run) => run.id === baselineRunID)
    const candidate = runs.find((run) => run.id === candidateRunID)
    if (!baseline || !candidate) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (baseline.status !== 'completed' || candidate.status !== 'completed') {
      await fulfillError(route, 409, 'conflict: comparison requires completed reports')
      return
    }
    if (candidate.baseline_run_id !== baseline.id) {
      await fulfillError(
        route,
        400,
        'invalid evaluation request: candidate baseline_run_id must identify the compared baseline',
      )
      return
    }
    if (!exactCohortMatches(baseline, candidate)) {
      await fulfillError(
        route,
        400,
        'invalid evaluation request: baseline and candidate report cohorts do not match',
      )
      return
    }
    await fulfillJSON(route, 200, {
      ...evaluationComparison,
      baseline_run_id: baseline.id,
      candidate_run_id: candidate.id,
      gates: evaluationComparison.gates.map((gate) =>
        gate.id === 'G3'
          ? {
              ...gate,
              evidence_refs: [
                'server-reduction:comparative-g3.v1',
                `run:baseline:${baseline.id}`,
                `run:candidate:${candidate.id}`,
                'comparison-statistic:joint.normalized_regret',
              ],
            }
          : gate,
      ),
    })
  })
  await page.route('**/api/evaluation/v1/runs/*/events', async (route) => {
    eventStreamCount += 1
    if (options.eventStreamCloseOnce && eventStreamCount === 1) {
      await route.fulfill({ status: 204 })
      return
    }
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    const completesRun = options.completeRunOnEventStream === id
    const completedRun = completesRun
      ? {
          ...run,
          status: 'completed' as const,
          completed_at: '2026-08-29T00:06:00Z',
          progress: {
            percent: 100,
            completed: run.track_ids.length,
            total: run.track_ids.length,
            message: 'Evaluation completed',
          },
        }
      : null
    if (completedRun) {
      runs = runs.map((candidate) => (candidate.id === id ? completedRun : candidate))
    }
    const event = completesRun
      ? {
          id: '2',
          run_id: id,
          type: 'completed',
          timestamp: '2026-08-29T00:06:00Z',
          message: 'Evaluation completed',
          progress: completedRun?.progress,
        }
      : {
          id: '2',
          run_id: id,
          type: 'progress',
          timestamp: '2026-08-29T00:05:00Z',
          message: 'Executing routing track from SSE',
        }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: `id: 2\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    })
  })
  await page.route('**/api/evaluation/v1/runs/*/report', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const reportDelay = options.reportDelayMs ?? 0
    await new Promise<void>((resolve) => setTimeout(resolve, reportDelay))
    reportRequests.push(id)
    if (options.reportFailureIDs?.includes(id)) {
      await fulfillError(
        route,
        options.reportFailureStatus || 503,
        options.reportFailureStatus === 404
          ? 'not found: evaluation report'
          : 'report storage is temporarily unavailable',
      )
      return
    }
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (run.status !== 'completed') {
      await fulfillError(
        route,
        409,
        'conflict: evaluation report is available only for completed runs',
      )
      return
    }
    const report = evaluationReport(run)
    if (options.reportMetricCount && report.metrics.length) {
      report.metrics = Array.from({ length: options.reportMetricCount }, (_, index) => ({
        ...report.metrics[index % report.metrics.length],
        id: `diagnostic.metric_${String(index + 1).padStart(2, '0')}`,
        name: `Diagnostic metric ${index + 1}`,
      }))
    }
    if (typeof options.diagnosticArtifactBodies?.capacityProfile === 'string') {
      report.artifacts = [
        ...report.artifacts,
        {
          id: 'capacity-profile-json',
          name: 'capacity-profile.json',
          kind: 'json',
          uri: 'capacity-profile.json',
          digest: report.artifacts[0]?.digest,
          media_type: 'application/json',
          size_bytes: options.diagnosticArtifactBodies.capacityProfile.length,
        },
      ]
    }
    await fulfillJSON(route, 200, report)
  })
  await page.route('**/api/evaluation/v1/runs/*/artifacts/*', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const artifactID = decodeURIComponent(parts[parts.length - 1] || '')
    const id = decodeURIComponent(parts[parts.length - 3] || '')
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (run.status !== 'completed') {
      await fulfillError(route, 409, 'conflict: evaluation evidence is not sealed')
      return
    }
    if (artifactID === 'failure-summary-json') {
      if (typeof options.diagnosticArtifactBodies?.failureSummary === 'string') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: options.diagnosticArtifactBodies.failureSummary,
        })
        return
      }
      await fulfillJSON(route, 200, failureSummary(run))
      return
    }
    if (
      artifactID === 'capacity-profile-json' &&
      typeof options.diagnosticArtifactBodies?.capacityProfile === 'string'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: options.diagnosticArtifactBodies.capacityProfile,
      })
      return
    }
    if (['metrics-json', 'gates-json', 'provenance-json'].includes(artifactID)) {
      await fulfillJSON(route, 200, { schema_version: 'evaluation.v1' })
      return
    }
    if (artifactID === 'checksums-sha256') {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: '0123456789abcdef  metrics.json\n',
      })
      return
    }
    await fulfillError(route, 404, 'not found: evaluation artifact')
  })
  await page.route('**/api/evaluation/v1/runs/*/cancel', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (current.status !== 'running') {
      await fulfillError(route, 409, `conflict: run cannot be cancelled from ${current.status}`)
      return
    }
    if (firstCancelPending) {
      firstCancelPending = false
      await fulfillError(route, 503, 'temporary cancellation failure')
      return
    }
    await mutationDelay()
    const cancelled = {
      ...current,
      status: 'cancelled' as const,
      completed_at: '2026-08-29T00:11:00Z',
      progress: { ...current.progress, message: 'Run cancelled' },
    }
    runs = runs.map((run) => (run.id === id ? cancelled : run))
    cancelCount += 1
    await fulfillJSON(route, 200, cancelled)
  })
  await page.route('**/api/evaluation/v1/runs/*/start', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (current.status !== 'pending') {
      await fulfillError(route, 409, `conflict: run cannot be started from ${current.status}`)
      return
    }
    await mutationDelay()
    const started = {
      ...current,
      status: 'running' as const,
      started_at: '2026-08-29T01:01:00Z',
      progress: { ...current.progress, message: 'Evaluation worker starting' },
    }
    runs = runs.map((run) => (run.id === id ? started : run))
    startCount += 1
    await fulfillJSON(route, 200, started)
  })
  await page.route(/\/api\/evaluation\/v1\/runs\/[^/?]+(?:\?.*)?$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 1] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (route.request().method() === 'GET') {
      runRequests.push(id)
      const response = controlledPairRunIDs.has(id)
        ? {
            ...current,
            status: 'completed' as const,
            progress: {
              percent: 100,
              completed: current.track_ids.length,
              total: current.track_ids.length,
              message: 'Controlled AB/BA evidence complete',
            },
            completed_at: '2026-08-31T01:05:00Z',
          }
        : current
      if (controlledPairRunIDs.has(id)) {
        runs = runs.map((run) => (run.id === id ? response : run))
      }
      await fulfillJSON(route, 200, response)
      return
    }
    if (route.request().method() !== 'DELETE') {
      await fulfillError(route, 405, 'method not allowed')
      return
    }
    if (current.status === 'running' || current.status === 'sealing') {
      await fulfillError(route, 409, 'conflict: evaluation execution is still active')
      return
    }
    await mutationDelay()
    runs = runs.filter((run) => run.id !== id)
    deleteCount += 1
    await route.fulfill({ status: 204 })
  })
  await page.route(/\/api\/evaluation\/v1\/runs(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      const rawRequest = route.request().postDataJSON() as Record<string, unknown>
      const request = rawRequest as unknown as CreateEvaluationRunPayload
      const allowedCreateFields = new Set([
        'client_request_id',
        'name',
        'description',
        'suite_ids',
        'track_ids',
        'mode',
        'target_id',
        'change_profile',
        'sample_limit',
        'concurrency',
        'capacity_slo',
        'capacity_load_protocol',
        'seed',
        'baseline_run_id',
      ])
      createAttempts.push(request)
      const target = evaluationCatalog.targets.find(
        (candidate) => candidate.id === request.target_id,
      )
      const suites = request.suite_ids.map((id) =>
        evaluationCatalog.suites.find((candidate) => candidate.id === id),
      )
      const suiteTrackIDs = new Set(suites.flatMap((suite) => suite?.track_ids || []))
      const capacitySLORequired = request.mode === 'live' && request.track_ids.includes('capacity')
      const capacitySLO = request.capacity_slo
      const capacityLoadProtocol = request.capacity_load_protocol
      const capacitySLOValid =
        capacitySLO?.schema_version === 'evaluation.v1' &&
        Number.isInteger(capacitySLO.required_concurrency) &&
        capacitySLO.required_concurrency >= 1 &&
        capacitySLO.required_concurrency <= request.concurrency &&
        Number.isFinite(capacitySLO.max_latency_p95_ms) &&
        capacitySLO.max_latency_p95_ms > 0 &&
        Number.isFinite(capacitySLO.max_error_rate) &&
        capacitySLO.max_error_rate >= 0 &&
        capacitySLO.max_error_rate < 1 &&
        Number.isFinite(capacitySLO.min_throughput_rps) &&
        capacitySLO.min_throughput_rps > 0 &&
        Number.isFinite(capacitySLO.min_throughput_scaling_efficiency) &&
        capacitySLO.min_throughput_scaling_efficiency > 0 &&
        capacitySLO.min_throughput_scaling_efficiency <= 1
      const utf8Length = (value: string) => new TextEncoder().encode(value).length
      const invalid =
        !request.name.trim() ||
        utf8Length(request.name.trim()) > 200 ||
        utf8Length(request.description.trim()) > 4000 ||
        !Number.isInteger(request.sample_limit) ||
        request.sample_limit < 1 ||
        request.sample_limit > 100000 ||
        !Number.isInteger(request.concurrency) ||
        request.concurrency < 1 ||
        request.concurrency > 128 ||
        !Number.isInteger(request.seed) ||
        request.seed < 0 ||
        request.seed > 4294967295 ||
        (capacitySLORequired
          ? !capacitySLOValid ||
            !validCapacityLoadProtocol(capacityLoadProtocol, request.concurrency)
          : capacitySLO !== undefined || capacityLoadProtocol !== undefined) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.client_request_id,
        ) ||
        Object.keys(rawRequest).some((field) => !allowedCreateFields.has(field)) ||
        (request.baseline_run_id !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            request.baseline_run_id,
          )) ||
        !evaluationCatalog.change_profiles.some(
          (profile) => profile.id === request.change_profile,
        ) ||
        !target ||
        target.healthy === false ||
        !target.modes.includes(request.mode) ||
        request.suite_ids.length === 0 ||
        request.track_ids.length === 0 ||
        suites.some(
          (suite) =>
            !suite ||
            !suite.modes.includes(request.mode) ||
            suite.track_ids.some((trackID) => !target.track_ids.includes(trackID)),
        ) ||
        request.track_ids.some(
          (trackID) =>
            !suiteTrackIDs.has(trackID) ||
            !target.track_ids.includes(trackID) ||
            !evaluationCatalog.tracks
              .find((track) => track.id === trackID)
              ?.modes.includes(request.mode),
        )
      if (invalid) {
        await fulfillError(route, 400, 'invalid evaluation request: create contract rejected')
        return
      }
      if (request.baseline_run_id && ledgerWarningCount > 0) {
        await fulfillError(
          route,
          409,
          'conflict: evaluation run ledger is incomplete; repair quarantined evidence before selecting a baseline',
        )
        return
      }
      const baseline = request.baseline_run_id
        ? runs.find((run) => run.id === request.baseline_run_id)
        : null
      if (request.baseline_run_id && (!baseline || baseline.status !== 'completed')) {
        await fulfillError(route, 400, 'invalid evaluation request: baseline run must be completed')
        return
      }
      const requestRun = evaluationRun(
        'request-cohort',
        request.name,
        'pending',
        '2026-08-29T01:00:00Z',
        request.change_profile,
        request,
      )
      if (baseline && !exactCohortMatches(baseline, requestRun)) {
        await fulfillError(
          route,
          400,
          'invalid evaluation request: candidate cohort must match the baseline',
        )
        return
      }
      const idempotentRun = runs.find((run) => run.client_request_id === request.client_request_id)
      if (idempotentRun) {
        if (!createRequestMatchesRun(request, idempotentRun)) {
          await fulfillError(
            route,
            409,
            'conflict: client_request_id was already used for a different evaluation run',
          )
          return
        }
        await mutationDelay()
        await fulfillJSON(route, 201, idempotentRun)
        return
      }
      createdRequests.push(request)
      const created = evaluationRun(
        request.client_request_id,
        request.name.trim(),
        'pending',
        '2026-08-29T01:00:00Z',
        request.change_profile,
        {
          description: request.description.trim(),
          mode: request.mode,
          target_id: request.target_id,
          suite_ids: request.suite_ids,
          track_ids: request.track_ids,
          sample_limit: request.sample_limit,
          concurrency: request.concurrency,
          capacity_slo: request.capacity_slo,
          capacity_load_protocol: request.capacity_load_protocol,
          seed: request.seed,
          baseline_run_id: request.baseline_run_id,
          evidence_level: 'E0',
        },
      )
      runs = [created, ...runs]
      await mutationDelay()
      await fulfillJSON(route, 201, created)
      return
    }
    if (route.request().method() !== 'GET') {
      await fulfillError(route, 405, 'method not allowed')
      return
    }
    const url = new URL(route.request().url())
    const offset = Number.parseInt(url.searchParams.get('cursor') || '0', 10)
    ledgerRequestCount += 1
    if (offset > 0 && firstLoadMorePending) {
      firstLoadMorePending = false
      await fulfillError(route, 503, 'temporary ledger page failure')
      return
    }
    const pageSize = options.runPageSize || 50
    const pageRuns = runs.slice(offset, offset + pageSize)
    const nextOffset = offset + pageRuns.length
    await new Promise<void>((resolve) => setTimeout(resolve, options.ledgerDelayMs || 0))
    await fulfillJSON(route, 200, {
      schema_version: 'evaluation.v1',
      runs: pageRuns,
      ...(nextOffset < runs.length ? { next_cursor: String(nextOffset) } : {}),
      total_runs: runs.length,
      ledger_complete: ledgerWarningCount === 0,
      warning_count: ledgerWarningCount,
      warnings: ledgerWarnings,
    })
  })

  return {
    createAttempts,
    createdRequests,
    comparisonRequests,
    campaignRequests,
    controlledPairRequests,
    campaignGetRequests,
    runRequests,
    reportRequests,
    getCancelCount: () => cancelCount,
    getDeleteCount: () => deleteCount,
    getStartCount: () => startCount,
    getEventStreamCount: () => eventStreamCount,
    getLedgerRequestCount: () => ledgerRequestCount,
    getRuns: () => [...runs],
    addRun: (run: EvaluationRun) => {
      runs = [run, ...runs.filter((candidate) => candidate.id !== run.id)]
    },
    rejectCampaignGets: () => {
      rejectCampaignGets = true
    },
    allowCampaignGets: () => {
      rejectCampaignGets = false
    },
  }
}
