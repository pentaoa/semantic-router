import type {
  CreateEvaluationCampaignPayload,
  EvaluationCampaignGateBindings,
} from '../../types/evaluationCampaign'
import type {
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationCatalogChangeProfile,
  EvaluationChangeProfileId,
  EvaluationRun,
  EvidenceLevel,
} from '../../types/evaluationPlane'
import { canonicalEvaluationCampaignGateBindings } from '../../utils/evaluationCampaignBindingContract'
import {
  equalEvaluationCapacityLoadProtocol,
  equalEvaluationCapacitySLO,
} from '../../utils/evaluationCapacitySLOContract'
import { newEvaluationClientRequestID } from '../../utils/evaluationIdentity'

export const EVALUATION_CAMPAIGN_LIMITS = { name: 200, description: 4000 } as const

const EVIDENCE_LEVEL = new Map<EvidenceLevel, number>([
  ['E0', 0],
  ['E1', 1],
  ['E2', 2],
  ['E3', 3],
  ['E4', 4],
  ['E5', 5],
])

export interface EvaluationCampaignDraft {
  clientRequestID: string
  name: string
  description: string
  changeProfile: EvaluationChangeProfileId
  gateBindings: EvaluationCampaignGateBindings
}

export function newEvaluationCampaignClientRequestID(): string {
  return newEvaluationClientRequestID()
}

function sameOrdered<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function pairedCampaignCohortMismatches(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): string[] {
  const mismatches: string[] = []
  if (baseline.mode !== candidate.mode) mismatches.push('mode')
  if (baseline.target_id === candidate.target_id) mismatches.push('deployment target')
  if (
    !baseline.mixture ||
    !candidate.mixture ||
    baseline.mixture.id !== candidate.mixture.id ||
    baseline.mixture.recipe_name !== candidate.mixture.recipe_name
  ) {
    mismatches.push('Mixture subject')
  }
  if (baseline.change_profile !== candidate.change_profile) mismatches.push('change profile')
  if (baseline.sample_limit !== candidate.sample_limit) mismatches.push('sample limit')
  if (baseline.concurrency !== candidate.concurrency) mismatches.push('concurrency')
  if (!equalEvaluationCapacitySLO(baseline.capacity_slo, candidate.capacity_slo)) {
    mismatches.push('capacity SLO')
  }
  if (
    !equalEvaluationCapacityLoadProtocol(
      baseline.capacity_load_protocol,
      candidate.capacity_load_protocol,
    )
  ) {
    mismatches.push('capacity load protocol')
  }
  if (baseline.seed !== candidate.seed) mismatches.push('seed')
  if (!sameOrdered(baseline.suite_ids, candidate.suite_ids)) mismatches.push('suite order')
  if (!sameOrdered(baseline.track_ids, candidate.track_ids)) mismatches.push('track order')
  return mismatches
}

function fidelityCohortMismatches(reference: EvaluationRun, live: EvaluationRun): string[] {
  const mismatches: string[] = []
  if (reference.change_profile !== live.change_profile) mismatches.push('change profile')
  if (reference.target_id !== live.target_id) mismatches.push('target')
  if (reference.sample_limit !== live.sample_limit) mismatches.push('sample limit')
  if (reference.seed !== live.seed) mismatches.push('seed')
  if (!sameOrdered(reference.suite_ids, live.suite_ids)) mismatches.push('suite order')
  if (!sameOrdered(reference.track_ids, live.track_ids)) mismatches.push('track order')
  if (
    !reference.completed_at ||
    !live.started_at ||
    Date.parse(live.started_at) <= Date.parse(reference.completed_at)
  ) {
    mismatches.push('fresh-live order')
  }
  return mismatches
}

function runExecutorIDs(run: EvaluationRun, catalog: EvaluationCatalog): string[] | null {
  const suites = run.suite_ids.map((suiteID) =>
    catalog.suites.find((suite) => suite.id === suiteID),
  )
  if (suites.some((suite) => !suite)) return null
  const executorIDs = suites.map((suite) => suite?.executors[run.mode]).filter(Boolean) as string[]
  return executorIDs.length === suites.length ? executorIDs : null
}

function syntheticReplay(run: EvaluationRun, catalog: EvaluationCatalog): boolean {
  if (run.mode !== 'replay') return false
  const target = catalog.targets.find((candidate) => candidate.id === run.target_id)
  const executors = runExecutorIDs(run, catalog) || []
  return (
    target?.kind === 'builtin-fixture' || executors.some((executor) => executor.includes('fixture'))
  )
}

function runTrackEvidenceAtLeast(
  run: EvaluationRun,
  trackID: EvaluationCatalogCampaignSlot['track_id'],
  minimum: EvidenceLevel,
): boolean {
  if (!trackID) return false
  const level = run.track_evidence_levels[trackID]
  return Boolean(level && (EVIDENCE_LEVEL.get(level) || 0) >= (EVIDENCE_LEVEL.get(minimum) || 0))
}

export function campaignRunMatchesSlot(
  run: EvaluationRun,
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
  options: { minimumEvidenceLevel?: EvidenceLevel } = {},
): boolean {
  const minimumEvidenceLevel = options.minimumEvidenceLevel || slot.minimum_evidence_level
  if (
    run.status !== 'completed' ||
    run.change_profile !== profile.id ||
    (slot.mode !== undefined && run.mode !== slot.mode) ||
    (slot.track_id !== undefined && !run.track_ids.includes(slot.track_id)) ||
    !runTrackEvidenceAtLeast(run, slot.track_id, minimumEvidenceLevel) ||
    syntheticReplay(run, catalog)
  ) {
    return false
  }
  const target = catalog.targets.find((candidate) => candidate.id === run.target_id)
  if (!target || target.healthy === false) return false
  const suites = run.suite_ids.map((suiteID) =>
    catalog.suites.find((suite) => suite.id === suiteID),
  )
  if (suites.length === 0 || suites.some((suite) => !suite)) return false
  const executors = runExecutorIDs(run, catalog)
  return Boolean(
    executors && executors.every((executor) => slot.accepted_executor_ids.includes(executor)),
  )
}

function controlledPairSourceMatchesSlot(
  run: EvaluationRun,
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
): boolean {
  if (
    run.status !== 'completed' ||
    run.mode !== 'live' ||
    run.change_profile !== profile.id ||
    !run.mixture ||
    (slot.mode !== undefined && slot.mode !== 'live')
  ) {
    return false
  }
  const target = catalog.targets.find((candidate) => candidate.id === run.target_id)
  const suite =
    run.suite_ids.length === 1
      ? catalog.suites.find((candidate) => candidate.id === run.suite_ids[0])
      : undefined
  const executors = runExecutorIDs(run, catalog)
  return Boolean(
    target &&
      target.healthy !== false &&
      target.labels?.router_auth === undefined &&
      run.track_ids.every((trackID) => target.track_ids.includes(trackID)) &&
      suite?.campaign_eligible &&
      suite.campaign_minimum_cases >= 59 &&
      run.sample_limit >= suite.campaign_minimum_cases &&
      sameOrdered(run.track_ids, suite.track_ids) &&
      runTrackEvidenceAtLeast(run, 'routing', 'E3') &&
      runTrackEvidenceAtLeast(run, 'model_pool', 'E4') &&
      runTrackEvidenceAtLeast(run, 'joint', 'E5') &&
      executors?.every((executor) => slot.accepted_executor_ids.includes(executor)),
  )
}

export function controlledPairBaselineSourceOptions(
  runs: EvaluationRun[],
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
): EvaluationRun[] {
  return runs.filter((run) => controlledPairSourceMatchesSlot(run, catalog, profile, slot))
}

export function controlledPairCandidateSourceOptions(
  runs: EvaluationRun[],
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
  baselineSourceRunID: string,
): EvaluationRun[] {
  const baseline = runs.find((run) => run.id === baselineSourceRunID)
  if (!baseline) return []
  return runs.filter(
    (run) =>
      run.id !== baseline.id &&
      controlledPairSourceMatchesSlot(run, catalog, profile, slot) &&
      pairedCampaignCohortMismatches(baseline, run).length === 0,
  )
}

export function campaignRunOptions(
  runs: EvaluationRun[],
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
): EvaluationRun[] {
  return runs.filter((run) => campaignRunMatchesSlot(run, catalog, profile, slot))
}

export function fidelityReferenceOptions(
  runs: EvaluationRun[],
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
): EvaluationRun[] {
  return runs.filter(
    (run) =>
      run.mode === 'live' &&
      campaignRunMatchesSlot(run, catalog, profile, slot, {
        minimumEvidenceLevel: 'E4',
      }),
  )
}

export function fidelityLiveOptions(
  runs: EvaluationRun[],
  catalog: EvaluationCatalog,
  profile: EvaluationCatalogChangeProfile,
  slot: EvaluationCatalogCampaignSlot,
  referenceRunID: string,
): EvaluationRun[] {
  const reference = runs.find((run) => run.id === referenceRunID)
  if (!reference) return []
  return runs.filter(
    (run) =>
      run.mode === 'live' &&
      campaignRunMatchesSlot(run, catalog, profile, slot) &&
      fidelityCohortMismatches(reference, run).length === 0,
  )
}

export function campaignSlotRunIDs(
  slot: EvaluationCatalogCampaignSlot,
  bindings: EvaluationCampaignGateBindings,
): string[] {
  switch (slot.gate_id) {
    case 'G2':
      return bindings.g2_run_id ? [bindings.g2_run_id] : []
    case 'G3':
      return bindings.g3_controlled_pair
        ? [
            bindings.g3_controlled_pair.baseline_run_id,
            bindings.g3_controlled_pair.candidate_run_id,
          ].filter(Boolean)
        : []
    case 'G4':
      return bindings.g4_run_id ? [bindings.g4_run_id] : []
    case 'G5':
      return bindings.g5_fidelity
        ? [bindings.g5_fidelity.reference_run_id, bindings.g5_fidelity.live_run_id].filter(Boolean)
        : []
    case 'G6':
      return bindings.g6_run_id ? [bindings.g6_run_id] : []
    case 'G7':
      return bindings.g7_run_id ? [bindings.g7_run_id] : []
    case 'G8':
      return bindings.g8_run_id ? [bindings.g8_run_id] : []
    case 'G9':
      return bindings.g9_run_id ? [bindings.g9_run_id] : []
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

export function validateEvaluationCampaignDraft(
  catalog: EvaluationCatalog,
  runs: EvaluationRun[],
  draft: EvaluationCampaignDraft,
  ledgerAvailable: boolean,
  ledgerComplete: boolean,
  allRunsLoaded: boolean,
): string | null {
  const name = draft.name.trim()
  const description = draft.description.trim()
  if (!ledgerAvailable) return 'The durable run ledger is unavailable.'
  if (!ledgerComplete) return 'Repair quarantined run evidence before making a decision.'
  if (!allRunsLoaded) return 'Load the complete run ledger before selecting campaign evidence.'
  if (!name) return 'Campaign name is required.'
  if (utf8Length(name) > EVALUATION_CAMPAIGN_LIMITS.name) {
    return `Campaign name must be at most ${EVALUATION_CAMPAIGN_LIMITS.name} bytes.`
  }
  if (utf8Length(description) > EVALUATION_CAMPAIGN_LIMITS.description) {
    return `Campaign description must be at most ${EVALUATION_CAMPAIGN_LIMITS.description} bytes.`
  }
  const profile = catalog.change_profiles.find((candidate) => candidate.id === draft.changeProfile)
  if (!profile) return 'Select a change profile from the server campaign catalog.'
  const byID = new Map(runs.map((run) => [run.id, run]))
  const allBoundRunIDs = profile.campaign_slots.flatMap((slot) =>
    campaignSlotRunIDs(slot, draft.gateBindings),
  )
  if (new Set(allBoundRunIDs).size !== allBoundRunIDs.length) {
    return 'Each campaign slot requires independent run evidence; one run cannot fill two slots.'
  }
  for (const slot of profile.campaign_slots) {
    const ids = campaignSlotRunIDs(slot, draft.gateBindings)
    if (slot.disposition === 'required' && ids.length === 0) {
      return `Select required ${slot.gate_id} ${slot.name.toLowerCase()} evidence.`
    }
    if (slot.disposition === 'not_applicable' && ids.length > 0) {
      return `${slot.gate_id} is not applicable to this change profile.`
    }
    for (const id of ids) {
      const run = byID.get(id)
      if (!run) return 'A selected campaign run is not present in the complete ledger.'
      const reference = slot.binding_kind === 'fidelity_pair' && id === ids[0]
      const compatible =
        slot.binding_kind === 'controlled_pair'
          ? controlledPairSourceMatchesSlot(run, catalog, profile, slot)
          : campaignRunMatchesSlot(run, catalog, profile, slot, {
              ...(reference ? { minimumEvidenceLevel: 'E4' as const } : {}),
            })
      if (!compatible) {
        return `${slot.gate_id} evidence is not compatible with the server catalog slot.`
      }
    }
    if (slot.binding_kind !== 'run' && ids.length === 1) {
      return `${slot.gate_id} requires a complete evidence pair.`
    }
    if (new Set(ids).size !== ids.length) return `${slot.gate_id} requires distinct runs.`
    if (slot.binding_kind === 'controlled_pair' && ids.length === 2) {
      const baseline = byID.get(ids[0])!
      const candidate = byID.get(ids[1])!
      if (
        candidate.baseline_run_id !== baseline.id ||
        pairedCampaignCohortMismatches(baseline, candidate).length > 0
      ) {
        return `${slot.gate_id} requires one server-controlled exact cohort.`
      }
    }
    if (slot.binding_kind === 'fidelity_pair' && ids.length === 2) {
      const reference = byID.get(ids[0])!
      const live = byID.get(ids[1])!
      if (
        reference.mode !== 'live' ||
        live.mode !== 'live' ||
        fidelityCohortMismatches(reference, live).length > 0
      ) {
        return `${slot.gate_id} requires one exact reference-to-live cohort.`
      }
    }
  }
  return null
}

export function buildEvaluationCampaignRequest(
  draft: EvaluationCampaignDraft,
): CreateEvaluationCampaignPayload {
  return {
    client_request_id: draft.clientRequestID,
    name: draft.name.trim(),
    description: draft.description.trim(),
    change_profile: draft.changeProfile,
    gate_bindings: canonicalEvaluationCampaignGateBindings(draft.gateBindings),
  }
}
