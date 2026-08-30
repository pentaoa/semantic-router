export const EVALUATION_TRACK_IDS = [
  'routing',
  'model_pool',
  'joint',
  'agentic',
  'multimodal',
  'preference',
  'safety',
  'capacity',
] as const

export const EVALUATION_CHANGE_PROFILE_IDS = [
  'schema_adapter',
  'recipe',
  'selector',
  'model_pool',
  'runtime_capacity',
  'agent_multimodal',
  'online_adaptation',
] as const

export const EVALUATION_SCHEMA_VERSION = 'evaluation.v1' as const
export const EVALUATION_ATTESTATION_REVISION = 'evaluation-server-attestation.v2' as const
export const EVALUATION_GATE_CONTRACT_VERSION = 'evaluation-release-gates.v2' as const
export const EVALUATION_CAMPAIGN_CONTRACT_VERSION = 'evaluation-campaign.v2' as const
export const EVALUATION_CAMPAIGN_PAIRED_LIVE_CONTRACT_VERSION =
  'evaluation-campaign-paired-live.v3' as const
export const EVALUATION_CAMPAIGN_FIDELITY_CONTRACT_VERSION =
  'evaluation-campaign-fidelity.v2' as const

export type EvaluationSchemaVersion = typeof EVALUATION_SCHEMA_VERSION
export type EvaluationAttestationRevision = typeof EVALUATION_ATTESTATION_REVISION
export type EvaluationGateContractVersion = typeof EVALUATION_GATE_CONTRACT_VERSION
export type EvaluationCampaignContractVersion = typeof EVALUATION_CAMPAIGN_CONTRACT_VERSION
export type EvaluationCampaignPairedLiveContractVersion =
  typeof EVALUATION_CAMPAIGN_PAIRED_LIVE_CONTRACT_VERSION
export type EvaluationCampaignFidelityContractVersion =
  typeof EVALUATION_CAMPAIGN_FIDELITY_CONTRACT_VERSION
export type EvaluationTrackId = (typeof EVALUATION_TRACK_IDS)[number]
export type EvaluationChangeProfileId = (typeof EVALUATION_CHANGE_PROFILE_IDS)[number]
export type EvaluationMode = 'replay' | 'live'
export type EvidenceLevel = 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5'
export type EvaluationRunStatus =
  | 'pending'
  | 'running'
  | 'sealing'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type EvaluationTrackStatus = EvaluationRunStatus | 'unavailable' | 'skipped'
export type GateDisposition = 'required' | 'advisory' | 'not_applicable' | 'waived'
export type GateVerdict = 'pass' | 'fail' | 'unavailable' | 'waived' | 'not_applicable'
export type EvaluationMethodEvidenceSource =
  | 'diagnostic_fixture'
  | 'live_runtime'
  | 'normalized_import'
  | 'server_brokered_live'
  | 'live_production'
export type EvaluationMethodStatus = 'configured' | 'data_required'

export interface EvaluationCatalogMethod {
  id: string
  track_id: EvaluationTrackId
  qualified_gate_ids: string[]
  evidence_source: EvaluationMethodEvidenceSource
  status: EvaluationMethodStatus
  reason?: string
}

export interface EvaluationCatalogTrack {
  id: EvaluationTrackId
  name: string
  description: string
  modes: EvaluationMode[]
  metrics: string[]
  evidence_levels: EvidenceLevel[]
}

export interface EvaluationCatalogSuite {
  id: string
  executors: Partial<Record<EvaluationMode, string>>
  name: string
  description: string
  track_ids: EvaluationTrackId[]
  modes: EvaluationMode[]
  evidence_level: EvidenceLevel
  case_count?: number
  campaign_eligible: boolean
  campaign_minimum_cases: number
  revision: string
  tags: string[]
  methods: EvaluationCatalogMethod[]
}

export interface EvaluationModelArm {
  id: string
  model: string
  provider_model_id_digest: string
  input_cost_per_million_tokens_usd: number
  output_cost_per_million_tokens_usd: number
  capabilities?: string[]
  modalities?: Array<'text' | 'image' | 'document' | 'audio' | 'video'>
  context_window_tokens?: number
  parameter_size?: string
  runtime_revision?: string
  config_digest?: string
}

export interface EvaluationMixtureDecision {
  name: string
  algorithm: string
  arm_ids: string[]
}

export interface EvaluationSupportModel {
  model: string
  provider_model_id_digest: string
  config_digest: string
  runtime_revision?: string
  backend_topology_digest: string
}

/**
 * Browser-safe, immutable view of the exact Mixture-of-Models binding being
 * evaluated. Connectivity and provider identities never cross this boundary.
 */
export interface EvaluationMixture {
  id: string
  entrypoint_model: string
  aliases: string[]
  recipe_name: string
  recipe_description: string
  recipe_digest: string
  pool_digest: string
  selector_policy_digest: string
  selector_digest: string
  adaptation_digest: string
  binding_digest: string
  model_arms: EvaluationModelArm[]
  support_models: EvaluationSupportModel[]
  fallback_arm_id?: string
  decisions: EvaluationMixtureDecision[]
}

export interface EvaluationCatalogTarget {
  id: string
  name: string
  description: string
  kind: string
  track_ids: EvaluationTrackId[]
  modes: EvaluationMode[]
  accepted_executors: Partial<Record<EvaluationMode, string[]>>
  evidence_level?: EvidenceLevel
  healthy?: boolean
  labels?: Record<string, string>
  mixture?: EvaluationMixture
}

export interface EvaluationCatalogChangeProfile {
  id: EvaluationChangeProfileId
  name: string
  description: string
  campaign_slots: EvaluationCatalogCampaignSlot[]
}

export type EvaluationCampaignSlotID = 'g2' | 'g3' | 'g4' | 'g5' | 'g6' | 'g7' | 'g8' | 'g9'
export type EvaluationCampaignGateID = 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9'
export type EvaluationCampaignBindingKind = 'run' | 'controlled_pair' | 'fidelity_pair'

export interface EvaluationCatalogCampaignSlot {
  gate_id: EvaluationCampaignGateID
  name: string
  description: string
  disposition: GateDisposition
  binding_kind: EvaluationCampaignBindingKind
  track_id?: EvaluationTrackId
  mode?: EvaluationMode
  minimum_evidence_level: EvidenceLevel
  accepted_executor_ids: string[]
}

export interface EvaluationCatalog {
  schema_version: EvaluationSchemaVersion
  gate_contract_version: EvaluationGateContractVersion
  generated_at: string
  change_profiles: EvaluationCatalogChangeProfile[]
  tracks: EvaluationCatalogTrack[]
  suites: EvaluationCatalogSuite[]
  targets: EvaluationCatalogTarget[]
}

export interface EvaluationCapacitySLO {
  schema_version: EvaluationSchemaVersion
  required_concurrency: number
  max_latency_p95_ms: number
  max_error_rate: number
  min_throughput_rps: number
  min_throughput_scaling_efficiency: number
}

export interface EvaluationCapacityLoadProtocol {
  schema_version: EvaluationSchemaVersion
  kind: 'closed-loop'
  concurrency_levels: number[]
  warmup_request_multiplier: number
  measurement_requests_per_repetition: number
  repetitions_per_level: number
  confidence_level: 0.95
  max_throughput_cv: number
  max_latency_p95_cv: number
}

export interface CreateEvaluationRunPayload {
  client_request_id: string
  name: string
  description: string
  suite_ids: string[]
  track_ids: EvaluationTrackId[]
  mode: EvaluationMode
  target_id: string
  change_profile: EvaluationChangeProfileId
  sample_limit: number
  concurrency: number
  capacity_slo?: EvaluationCapacitySLO
  capacity_load_protocol?: EvaluationCapacityLoadProtocol
  seed: number
  baseline_run_id?: string
}

export interface EvaluationExperimentIntent extends CreateEvaluationRunPayload {
  autoStart: boolean
}

export interface EvaluationRunProgress {
  percent: number
  completed: number
  total: number
  current_track_id?: EvaluationTrackId
  message?: string
}

export interface EvaluationRun {
  schema_version: EvaluationSchemaVersion
  id: string
  client_request_id: string
  name: string
  description: string
  status: EvaluationRunStatus
  mode: EvaluationMode
  evidence_level: EvidenceLevel
  track_evidence_levels: Partial<Record<EvaluationTrackId, EvidenceLevel>>
  target_id: string
  mixture?: EvaluationMixture
  change_profile: EvaluationChangeProfileId
  suite_ids: string[]
  track_ids: EvaluationTrackId[]
  sample_limit: number
  concurrency: number
  capacity_slo?: EvaluationCapacitySLO
  capacity_load_protocol?: EvaluationCapacityLoadProtocol
  seed: number
  baseline_run_id?: string
  progress: EvaluationRunProgress
  created_at: string
  started_at?: string
  completed_at?: string
  error?: string
}

export interface EvaluationRunLedgerWarning {
  code: string
  evidence_id: string
  evidence_file: string
  message: string
}

export interface EvaluationRunLedger {
  schema_version: EvaluationSchemaVersion
  runs: EvaluationRun[]
  next_cursor?: string
  total_runs: number
  ledger_complete: boolean
  warning_count: number
  warnings: EvaluationRunLedgerWarning[]
}

export type EvaluationRunEventType =
  | 'snapshot'
  | 'progress'
  | 'track'
  | 'gate'
  | 'artifact'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface EvaluationRunEventBase {
  id: string
  run_id: string
  timestamp: string
  message: string
  progress?: EvaluationRunProgress
}

export interface EvaluationTrackRunEvent extends EvaluationRunEventBase {
  type: 'track'
  track_id: EvaluationTrackId
  progress: EvaluationRunProgress
  payload: {
    record_count: number
  }
}

export interface EvaluationTerminalRunEvent extends EvaluationRunEventBase {
  type: 'completed' | 'failed' | 'cancelled'
  progress: EvaluationRunProgress
  track_id?: never
  payload?: never
}

export interface EvaluationPayloadlessRunEvent extends EvaluationRunEventBase {
  type: Exclude<EvaluationRunEventType, 'track' | EvaluationTerminalRunEvent['type']>
  track_id?: never
  payload?: never
}

export type EvaluationRunEvent =
  | EvaluationTrackRunEvent
  | EvaluationTerminalRunEvent
  | EvaluationPayloadlessRunEvent

export const TRACK_PRESENTATION: Record<EvaluationTrackId, { label: string; description: string }> =
  {
    routing: {
      label: 'Routing',
      description: 'Recipe decisions, oracle regret, abstention, calibration, and eligibility.',
    },
    model_pool: {
      label: 'Model pool',
      description: 'Arm quality, complementarity, coverage, dominance, and failure isolation.',
    },
    joint: {
      label: 'Routing + pool',
      description: 'End-to-end quality, latency, cost, reliability, and decomposition.',
    },
    agentic: {
      label: 'Agentic',
      description: 'Trajectory success, tool use, state continuity, recovery, and budget.',
    },
    multimodal: {
      label: 'Multimodal',
      description: 'Modality-aware routing, perception, grounding, and cross-modal quality.',
    },
    preference: {
      label: 'Preference',
      description: 'Offline preference, online trials, stability, and feedback adaptation.',
    },
    safety: {
      label: 'Safety',
      description: 'Policy adherence, attack resistance, privacy, and unsafe regressions.',
    },
    capacity: {
      label: 'Capacity',
      description: 'Throughput, saturation, queueing, SLOs, GPU efficiency, and TCO.',
    },
  }
