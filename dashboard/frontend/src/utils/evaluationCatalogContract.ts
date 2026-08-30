import type { CreateEvaluationRunPayload, EvaluationCatalog } from '../types/evaluationPlane'
import { EVALUATION_GATE_CONTRACT_VERSION } from '../types/evaluationPlane'
import {
  assertCurrentEvaluationContract,
  EVALUATION_CHANGE_PROFILE_SET,
  EVALUATION_EVIDENCE_LEVEL_SET,
  EVALUATION_MODE_SET,
  EVALUATION_TRACK_ID_SET,
  type EvaluationRecord,
  hasOnlyEvaluationFields,
  isEvaluationRecord,
  isKnownValue,
  isKnownValueArray,
  isNonEmptyText,
  isNonNegativeInteger,
  isStringRecord,
  isTextArray,
} from './evaluationContractValidation'
import { requireCanonicalEvaluationRunID } from './evaluationRunContract'
import {
  decodeEvaluationCapacityLoadProtocol,
  decodeEvaluationCapacitySLO,
  requiresCapacitySLO,
} from './evaluationCapacitySLOContract'
import { isEvaluationMixture } from './evaluationMixtureContract'

function isTargetExecutorMap(value: unknown, modes: unknown): boolean {
  if (
    !isEvaluationRecord(value) ||
    !Array.isArray(modes) ||
    !isKnownValueArray(modes, EVALUATION_MODE_SET, false)
  ) {
    return false
  }
  const declaredModes = modes as string[]
  const keys = Object.keys(value)
  return (
    keys.length === declaredModes.length &&
    declaredModes.every((mode) => {
      const executors = value[mode]
      return (
        Array.isArray(executors) &&
        executors.length > 0 &&
        executors.every((executor) =>
          typeof executor === 'string'
            ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executor)
            : false,
        ) &&
        new Set(executors).size === executors.length
      )
    }) &&
    keys.every((mode) => declaredModes.includes(mode))
  )
}

function isSuiteExecutorMap(value: unknown, modes: unknown): boolean {
  if (!isEvaluationRecord(value) || !Array.isArray(modes)) return false
  const modeSet = new Set(modes)
  const keys = Object.keys(value)
  return (
    keys.length === modeSet.size &&
    keys.every(
      (key) =>
        modeSet.has(key) && isKnownValue(key, EVALUATION_MODE_SET) && isNonEmptyText(value[key]),
    )
  )
}

const METHOD_EVIDENCE_SOURCES = new Set([
  'diagnostic_fixture',
  'live_runtime',
  'normalized_import',
  'server_brokered_live',
  'live_production',
])
const METHOD_STATUSES = new Set(['configured', 'data_required'])
const CAMPAIGN_GATE_IDS = ['G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'] as const
const CAMPAIGN_GATE_DISPOSITIONS = new Set(['required', 'advisory', 'not_applicable', 'waived'])
const CAMPAIGN_BINDING_KIND = new Map<string, string>([
  ['G2', 'run'],
  ['G3', 'controlled_pair'],
  ['G4', 'run'],
  ['G5', 'fidelity_pair'],
  ['G6', 'run'],
  ['G7', 'run'],
  ['G8', 'run'],
  ['G9', 'run'],
])
const METHOD_GATE_TRACK = new Map<string, string>([
  ['G2', 'safety'],
  ['G4', 'routing'],
  ['G6', 'agentic'],
  ['G7', 'capacity'],
  ['G8', 'preference'],
  ['G9', 'preference'],
])

function isCatalogMethod(value: unknown): boolean {
  if (
    !isEvaluationRecord(value) ||
    !hasOnlyEvaluationFields(value, [
      'id',
      'track_id',
      'qualified_gate_ids',
      'evidence_source',
      'status',
      'reason',
    ]) ||
    !isNonEmptyText(value.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) ||
    !isKnownValue(value.track_id, EVALUATION_TRACK_ID_SET) ||
    !Array.isArray(value.qualified_gate_ids) ||
    value.qualified_gate_ids.some(
      (gateID) => typeof gateID !== 'string' || METHOD_GATE_TRACK.get(gateID) !== value.track_id,
    ) ||
    new Set(value.qualified_gate_ids).size !== value.qualified_gate_ids.length ||
    typeof value.evidence_source !== 'string' ||
    !METHOD_EVIDENCE_SOURCES.has(value.evidence_source) ||
    typeof value.status !== 'string' ||
    !METHOD_STATUSES.has(value.status)
  ) {
    return false
  }
  if (value.status === 'data_required') return isNonEmptyText(value.reason)
  if (value.reason !== undefined) return false
  if (value.evidence_source === 'server_brokered_live') {
    return (
      value.status === 'configured' &&
      value.track_id === 'routing' &&
      value.qualified_gate_ids.length === 1 &&
      value.qualified_gate_ids[0] === 'G4'
    )
  }
  return (
    value.evidence_source !== 'normalized_import' ||
    (value.status === 'configured' && value.qualified_gate_ids.length === 0)
  )
}

function hasExactSuiteMethods(value: unknown, trackIDs: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(trackIDs)) return false
  if (value.some((method) => !isCatalogMethod(method))) return false
  const methods = value as EvaluationRecord[]
  const methodIDs = methods.map((method) => method.id)
  const methodTracks = new Set(methods.map((method) => method.track_id))
  return (
    new Set(methodIDs).size === methodIDs.length &&
    methodTracks.size === new Set(trackIDs).size &&
    [...methodTracks].every((trackID) => trackIDs.includes(trackID))
  )
}

function hasExactCampaignSlots(value: unknown, profileID: unknown): boolean {
  if (!Array.isArray(value) || value.length !== CAMPAIGN_GATE_IDS.length) return false
  const valid = value.every((slot, index) => {
    if (
      !isEvaluationRecord(slot) ||
      !hasOnlyEvaluationFields(slot, [
        'gate_id',
        'name',
        'description',
        'disposition',
        'binding_kind',
        'track_id',
        'mode',
        'minimum_evidence_level',
        'accepted_executor_ids',
      ]) ||
      slot.gate_id !== CAMPAIGN_GATE_IDS[index] ||
      !isNonEmptyText(slot.name) ||
      typeof slot.description !== 'string' ||
      typeof slot.disposition !== 'string' ||
      !CAMPAIGN_GATE_DISPOSITIONS.has(slot.disposition) ||
      slot.binding_kind !== CAMPAIGN_BINDING_KIND.get(slot.gate_id as string) ||
      (slot.track_id !== undefined && !isKnownValue(slot.track_id, EVALUATION_TRACK_ID_SET)) ||
      (slot.mode !== undefined && !isKnownValue(slot.mode, EVALUATION_MODE_SET)) ||
      !isKnownValue(slot.minimum_evidence_level, EVALUATION_EVIDENCE_LEVEL_SET) ||
      !Array.isArray(slot.accepted_executor_ids) ||
      slot.accepted_executor_ids.some(
        (executor) =>
          typeof executor !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executor),
      ) ||
      new Set(slot.accepted_executor_ids).size !== slot.accepted_executor_ids.length
    ) {
      return false
    }
    return true
  })
  if (!valid || profileID !== 'agent_multimodal') return valid
  const g3 = value[1]
  const g5 = value[3]
  return (
    isEvaluationRecord(g3) &&
    g3.disposition === 'not_applicable' &&
    isEvaluationRecord(g5) &&
    g5.track_id === 'multimodal' &&
    g5.minimum_evidence_level === 'E4' &&
    Array.isArray(g5.accepted_executor_ids) &&
    g5.accepted_executor_ids.length === 1 &&
    g5.accepted_executor_ids[0] === 'normalized-suite-live.v1'
  )
}

export function decodeEvaluationCatalog(payload: unknown): EvaluationCatalog {
  assertCurrentEvaluationContract(payload, 'Evaluation catalog response')
  if (
    !hasOnlyEvaluationFields(payload, [
      'schema_version',
      'gate_contract_version',
      'generated_at',
      'change_profiles',
      'tracks',
      'suites',
      'targets',
    ]) ||
    payload.gate_contract_version !== EVALUATION_GATE_CONTRACT_VERSION ||
    !isNonEmptyText(payload.generated_at) ||
    !Array.isArray(payload.change_profiles) ||
    payload.change_profiles.some(
      (item) =>
        !isEvaluationRecord(item) ||
        !hasOnlyEvaluationFields(item, ['id', 'name', 'description', 'campaign_slots']) ||
        !isKnownValue(item.id, EVALUATION_CHANGE_PROFILE_SET) ||
        !isNonEmptyText(item.name) ||
        typeof item.description !== 'string' ||
        !hasExactCampaignSlots(item.campaign_slots, item.id),
    ) ||
    !Array.isArray(payload.tracks) ||
    payload.tracks.some(
      (item) =>
        !isEvaluationRecord(item) ||
        !hasOnlyEvaluationFields(item, [
          'id',
          'name',
          'description',
          'modes',
          'metrics',
          'evidence_levels',
        ]) ||
        !isKnownValue(item.id, EVALUATION_TRACK_ID_SET) ||
        !isNonEmptyText(item.name) ||
        typeof item.description !== 'string' ||
        !isKnownValueArray(item.modes, EVALUATION_MODE_SET, false) ||
        !isTextArray(item.metrics) ||
        !isKnownValueArray(item.evidence_levels, EVALUATION_EVIDENCE_LEVEL_SET, false),
    ) ||
    !Array.isArray(payload.suites) ||
    payload.suites.some(
      (item) =>
        !isEvaluationRecord(item) ||
        !hasOnlyEvaluationFields(item, [
          'id',
          'executors',
          'name',
          'description',
          'track_ids',
          'modes',
          'evidence_level',
          'case_count',
          'campaign_eligible',
          'campaign_minimum_cases',
          'revision',
          'tags',
          'methods',
        ]) ||
        !isNonEmptyText(item.id) ||
        !isSuiteExecutorMap(item.executors, item.modes) ||
        !isNonEmptyText(item.name) ||
        typeof item.description !== 'string' ||
        !isKnownValueArray(item.track_ids, EVALUATION_TRACK_ID_SET, false) ||
        !isKnownValueArray(item.modes, EVALUATION_MODE_SET, false) ||
        new Set(item.modes as string[]).size !== (item.modes as string[]).length ||
        !isKnownValue(item.evidence_level, EVALUATION_EVIDENCE_LEVEL_SET) ||
        (item.case_count !== undefined && !isNonNegativeInteger(item.case_count)) ||
        typeof item.campaign_eligible !== 'boolean' ||
        !isNonNegativeInteger(item.campaign_minimum_cases) ||
        (item.campaign_eligible === true &&
          (item.evidence_level !== 'E0' ||
            item.case_count !== 64 ||
            item.campaign_minimum_cases !== 59 ||
            JSON.stringify(item.track_ids) !== JSON.stringify(['routing', 'model_pool', 'joint']) ||
            JSON.stringify(item.modes) !== JSON.stringify(['replay', 'live']) ||
            !isEvaluationRecord(item.executors) ||
            item.executors.replay !== 'mom-cohort-replay.v1' ||
            item.executors.live !== 'live-runtime.v1')) ||
        (item.campaign_eligible === false && item.campaign_minimum_cases !== 0) ||
        !isNonEmptyText(item.revision) ||
        !isTextArray(item.tags) ||
        !hasExactSuiteMethods(item.methods, item.track_ids) ||
        ((item.methods as EvaluationRecord[]).some(
          (method) => method.evidence_source === 'normalized_import',
        ) &&
          item.evidence_level !== 'E0'),
    ) ||
    !Array.isArray(payload.targets) ||
    payload.targets.some(
      (item) =>
        !isEvaluationRecord(item) ||
        !hasOnlyEvaluationFields(item, [
          'id',
          'name',
          'description',
          'kind',
          'track_ids',
          'modes',
          'accepted_executors',
          'evidence_level',
          'healthy',
          'labels',
          'mixture',
        ]) ||
        !isNonEmptyText(item.id) ||
        !isNonEmptyText(item.name) ||
        typeof item.description !== 'string' ||
        !isNonEmptyText(item.kind) ||
        !isKnownValueArray(item.track_ids, EVALUATION_TRACK_ID_SET, false) ||
        !isKnownValueArray(item.modes, EVALUATION_MODE_SET, false) ||
        !isTargetExecutorMap(item.accepted_executors, item.modes) ||
        (item.evidence_level !== undefined &&
          !isKnownValue(item.evidence_level, EVALUATION_EVIDENCE_LEVEL_SET)) ||
        (item.healthy !== undefined && typeof item.healthy !== 'boolean') ||
        (item.labels !== undefined && !isStringRecord(item.labels)) ||
        (item.mixture !== undefined && !isEvaluationMixture(item.mixture)) ||
        (item.kind === 'mixture-of-models') !== (item.mixture !== undefined),
    )
  ) {
    throw new Error('Evaluation catalog response is incomplete.')
  }
  return payload as unknown as EvaluationCatalog
}

export function buildCreateRunPayload(
  request: CreateEvaluationRunPayload,
  catalog: EvaluationCatalog,
): CreateEvaluationRunPayload {
  if (
    !hasOnlyEvaluationFields(request as unknown as EvaluationRecord, [
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
  ) {
    throw new Error('Evaluation create intent contains non-contract fields.')
  }
  requireCanonicalEvaluationRunID(request.client_request_id)
  if (request.baseline_run_id) requireCanonicalEvaluationRunID(request.baseline_run_id)
  const name = request.name.trim()
  const description = request.description.trim()
  if (!name || new TextEncoder().encode(name).length > 200) {
    throw new Error('Evaluation run name must contain 1–200 UTF-8 bytes.')
  }
  if (new TextEncoder().encode(description).length > 4_000) {
    throw new Error('Evaluation run description must contain at most 4000 UTF-8 bytes.')
  }
  if (
    !Number.isInteger(request.sample_limit) ||
    request.sample_limit < 1 ||
    request.sample_limit > 100_000
  ) {
    throw new Error('Evaluation sample limit must be an integer between 1 and 100000.')
  }
  if (
    !Number.isInteger(request.concurrency) ||
    request.concurrency < 1 ||
    request.concurrency > 128
  ) {
    throw new Error('Evaluation concurrency must be an integer between 1 and 128.')
  }
  if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 4_294_967_295) {
    throw new Error('Evaluation seed must be an integer between 0 and 4294967295.')
  }
  const capacityRequired = requiresCapacitySLO(request.mode, request.track_ids)
  let capacitySLO
  let capacityLoadProtocol
  if (capacityRequired) {
    if (request.concurrency < 2) {
      throw new Error('Live capacity evaluation requires concurrency of at least 2.')
    }
    if (request.capacity_slo === undefined || request.capacity_load_protocol === undefined) {
      throw new Error('Live capacity evaluation requires an explicit SLO and load protocol.')
    }
    capacitySLO = decodeEvaluationCapacitySLO(request.capacity_slo)
    if (capacitySLO.required_concurrency > request.concurrency) {
      throw new Error('Capacity SLO concurrency cannot exceed the run concurrency.')
    }
    capacityLoadProtocol = decodeEvaluationCapacityLoadProtocol(
      request.capacity_load_protocol,
      request.concurrency,
    )
  } else if (request.capacity_slo !== undefined || request.capacity_load_protocol !== undefined) {
    throw new Error('Capacity contracts are valid only for a live capacity evaluation.')
  }
  const changeProfile = catalog.change_profiles.find((item) => item.id === request.change_profile)
  if (!changeProfile) throw new Error('Select a change profile from the server evaluation catalog.')
  const target = catalog.targets.find((item) => item.id === request.target_id)
  if (!target) throw new Error('Select a target from the server evaluation catalog.')
  if (!target.modes.includes(request.mode) || target.healthy === false) {
    throw new Error('The selected target cannot execute this evaluation mode.')
  }
  if (new Set(request.suite_ids).size !== request.suite_ids.length) {
    throw new Error('Selected benchmark suites must not contain duplicate identities.')
  }
  if (new Set(request.track_ids).size !== request.track_ids.length) {
    throw new Error('Selected evaluation tracks must not contain duplicate identities.')
  }
  const suitesByID = new Map(catalog.suites.map((suite) => [suite.id, suite]))
  const suites = request.suite_ids.map((id) => suitesByID.get(id))
  if (suites.some((suite) => !suite)) {
    throw new Error('One or more selected suites are no longer in the evaluation catalog.')
  }
  if (
    suites.some(
      (suite) =>
        !suite?.modes.includes(request.mode) ||
        !target.accepted_executors[request.mode]?.includes(suite.executors[request.mode] || '') ||
        suite.track_ids.some((trackID) => !target.track_ids.includes(trackID)),
    )
  ) {
    throw new Error('Every selected suite must be fully supported by the target and mode.')
  }
  const executorIDs = new Set(suites.map((suite) => suite?.executors[request.mode]))
  if (executorIDs.size !== 1 || executorIDs.has(undefined)) {
    throw new Error('Selected suites must use one target-approved execution strategy.')
  }
  const suiteTrackIDs = new Set(suites.flatMap((suite) => suite?.track_ids || []))
  if (
    request.track_ids.some(
      (trackID) => !target.track_ids.includes(trackID) || !suiteTrackIDs.has(trackID),
    )
  ) {
    throw new Error('Every selected track must be supported by the target and selected suites.')
  }
  const canonicalSuiteIDs = catalog.suites
    .map((suite) => suite.id)
    .filter((id) => request.suite_ids.includes(id))
  const canonicalTrackIDs = catalog.tracks
    .map((track) => track.id)
    .filter((id) => request.track_ids.includes(id))
  return {
    client_request_id: request.client_request_id,
    name,
    description,
    suite_ids: canonicalSuiteIDs,
    track_ids: canonicalTrackIDs,
    mode: request.mode,
    target_id: request.target_id,
    change_profile: changeProfile.id,
    sample_limit: request.sample_limit,
    concurrency: request.concurrency,
    ...(capacitySLO ? { capacity_slo: capacitySLO } : {}),
    ...(capacityLoadProtocol ? { capacity_load_protocol: capacityLoadProtocol } : {}),
    seed: request.seed,
    ...(request.baseline_run_id ? { baseline_run_id: request.baseline_run_id } : {}),
  }
}
