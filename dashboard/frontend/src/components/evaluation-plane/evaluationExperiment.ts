import type {
  EvaluationCatalog,
  EvaluationCatalogSuite,
  EvaluationChangeProfileId,
  EvaluationMode,
  EvaluationRun,
  EvaluationTrackId,
  EvidenceLevel,
} from '../../types/evaluationPlane'

export const EVALUATION_RUN_LIMITS = {
  name: 200,
  description: 4000,
  sampleLimit: 100000,
  concurrency: 128,
  seed: 4294967295,
} as const

export interface EvaluationExactCohort {
  mode: EvaluationMode
  targetID: string
  changeProfile: EvaluationChangeProfileId
  suiteIDs: string[]
  trackIDs: EvaluationTrackId[]
  sampleLimit: number
  concurrency: number
  seed: number
}

export interface EvaluationDraft extends EvaluationExactCohort {
  name: string
  description: string
  baselineRunID: string
}

const EVIDENCE_LEVELS: EvidenceLevel[] = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5']

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function sameSet<T>(left: T[], right: T[]): boolean {
  const normalizedLeft = new Set(left)
  const normalizedRight = new Set(right)
  return (
    normalizedLeft.size === left.length &&
    normalizedRight.size === right.length &&
    normalizedLeft.size === normalizedRight.size &&
    [...normalizedLeft].every((value) => normalizedRight.has(value))
  )
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

export function supportedEvaluationTracks(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
): EvaluationTrackId[] {
  const target = catalog.targets.find((candidate) => candidate.id === targetID)
  if (!target || target.healthy === false || !target.modes.includes(mode)) return []
  return catalog.tracks
    .filter((track) => track.modes.includes(mode) && target.track_ids.includes(track.id))
    .map((track) => track.id)
}

export function compatibleEvaluationSuites(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
): EvaluationCatalogSuite[] {
  const availableTracks = supportedEvaluationTracks(catalog, targetID, mode)
  return catalog.suites.filter(
    (suite) =>
      suite.modes.includes(mode) &&
      suite.track_ids.length > 0 &&
      suite.track_ids.every((trackID) => availableTracks.includes(trackID)),
  )
}

export function reconcileEvaluationScope(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
  suiteIDs: string[],
  trackIDs: EvaluationTrackId[],
): { suiteIDs: string[]; trackIDs: EvaluationTrackId[] } {
  const compatibleSuiteIDs = new Set(
    compatibleEvaluationSuites(catalog, targetID, mode).map((suite) => suite.id),
  )
  const nextSuiteIDs = unique(suiteIDs).filter((suiteID) => compatibleSuiteIDs.has(suiteID))
  const selectedSuiteTracks = new Set(
    catalog.suites
      .filter((suite) => nextSuiteIDs.includes(suite.id))
      .flatMap((suite) => suite.track_ids),
  )
  const availableTracks = new Set(supportedEvaluationTracks(catalog, targetID, mode))
  return {
    suiteIDs: nextSuiteIDs,
    trackIDs: unique(trackIDs).filter(
      (trackID) => selectedSuiteTracks.has(trackID) && availableTracks.has(trackID),
    ),
  }
}

export function toggleEvaluationSuite(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
  suiteIDs: string[],
  trackIDs: EvaluationTrackId[],
  suiteID: string,
): { suiteIDs: string[]; trackIDs: EvaluationTrackId[] } {
  const current = reconcileEvaluationScope(catalog, targetID, mode, suiteIDs, trackIDs)
  if (current.suiteIDs.includes(suiteID)) {
    return reconcileEvaluationScope(
      catalog,
      targetID,
      mode,
      current.suiteIDs.filter((id) => id !== suiteID),
      current.trackIDs,
    )
  }

  const suite = compatibleEvaluationSuites(catalog, targetID, mode).find(
    (candidate) => candidate.id === suiteID,
  )
  if (!suite) return current
  return reconcileEvaluationScope(
    catalog,
    targetID,
    mode,
    [...current.suiteIDs, suite.id],
    [...current.trackIDs, ...suite.track_ids],
  )
}

export function selectedSuiteTracks(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
  suiteIDs: string[],
): EvaluationTrackId[] {
  const scope = reconcileEvaluationScope(
    catalog,
    targetID,
    mode,
    suiteIDs,
    catalog.tracks.map((track) => track.id),
  )
  return scope.trackIDs
}

export function minimumEvidenceClaimCeiling(
  catalog: EvaluationCatalog,
  suiteIDs: string[],
): EvidenceLevel | null {
  if (suiteIDs.length === 0) return null
  const suites = suiteIDs.map((suiteID) =>
    catalog.suites.find((candidate) => candidate.id === suiteID),
  )
  if (suites.some((suite) => !suite)) return null
  return suites.reduce<EvidenceLevel>((minimum, suite) => {
    const level = suite?.evidence_level || 'E0'
    return EVIDENCE_LEVELS.indexOf(level) < EVIDENCE_LEVELS.indexOf(minimum) ? level : minimum
  }, 'E5')
}

export function exactCohortFromRun(run: EvaluationRun): EvaluationExactCohort {
  return {
    mode: run.mode,
    targetID: run.target_id,
    changeProfile: run.change_profile,
    suiteIDs: [...run.suite_ids],
    trackIDs: [...run.track_ids],
    sampleLimit: run.sample_limit,
    concurrency: run.concurrency,
    seed: run.seed,
  }
}

export function exactCohortMatchesRun(cohort: EvaluationExactCohort, run: EvaluationRun): boolean {
  return (
    cohort.mode === run.mode &&
    cohort.targetID === run.target_id &&
    cohort.changeProfile === run.change_profile &&
    cohort.sampleLimit === run.sample_limit &&
    cohort.concurrency === run.concurrency &&
    cohort.seed === run.seed &&
    sameSet(cohort.suiteIDs, run.suite_ids) &&
    sameSet(cohort.trackIDs, run.track_ids)
  )
}

export function baselineCohortIssue(catalog: EvaluationCatalog, run: EvaluationRun): string | null {
  if (run.status !== 'completed') return 'Only completed runs can be used as a baseline.'
  if (!catalog.change_profiles.some((profile) => profile.id === run.change_profile)) {
    return 'Its change profile is no longer available in the server catalog.'
  }
  const target = catalog.targets.find((candidate) => candidate.id === run.target_id)
  if (!target) return 'Its execution target is no longer available in the server catalog.'
  if (target.healthy === false) return 'Its execution target is currently unavailable.'
  if (!target.modes.includes(run.mode)) return 'Its execution target no longer supports its mode.'
  if (!isBoundedInteger(run.sample_limit, 1, EVALUATION_RUN_LIMITS.sampleLimit)) {
    return 'Its sample limit is outside the supported cohort bounds.'
  }
  if (!isBoundedInteger(run.concurrency, 1, EVALUATION_RUN_LIMITS.concurrency)) {
    return 'Its concurrency is outside the supported cohort bounds.'
  }
  if (!isBoundedInteger(run.seed, 0, EVALUATION_RUN_LIMITS.seed)) {
    return 'Its seed is outside the supported cohort bounds.'
  }
  const reconciled = reconcileEvaluationScope(
    catalog,
    run.target_id,
    run.mode,
    run.suite_ids,
    run.track_ids,
  )
  if (
    run.suite_ids.length === 0 ||
    run.track_ids.length === 0 ||
    !sameSet(reconciled.suiteIDs, run.suite_ids) ||
    !sameSet(reconciled.trackIDs, run.track_ids)
  ) {
    return 'Its suites or tracks are no longer exactly reproducible from the server catalog.'
  }
  return null
}

export function compatibleSuiteEmptyReason(
  catalog: EvaluationCatalog,
  targetID: string,
  mode: EvaluationMode,
): string {
  const target = catalog.targets.find((candidate) => candidate.id === targetID)
  if (!target) {
    return `Select a healthy catalog target that supports ${mode}, or choose another mode.`
  }
  if (target.healthy === false)
    return 'The selected target is unavailable. Choose a healthy target.'
  if (!target.modes.includes(mode)) {
    return `The selected target does not support ${mode} evaluation. Choose another target or mode.`
  }
  return `No benchmark suite is fully supported by ${target.name} in ${mode} mode.`
}

export function validateEvaluationDraft(
  catalog: EvaluationCatalog,
  runs: EvaluationRun[],
  draft: EvaluationDraft,
): string | null {
  const name = draft.name.trim()
  const description = draft.description.trim()
  if (!name) return 'Experiment name is required.'
  if (utf8Length(name) > EVALUATION_RUN_LIMITS.name) {
    return `Experiment name must be at most ${EVALUATION_RUN_LIMITS.name} bytes.`
  }
  if (utf8Length(description) > EVALUATION_RUN_LIMITS.description) {
    return `Description must be at most ${EVALUATION_RUN_LIMITS.description} bytes.`
  }
  if (!catalog.change_profiles.some((profile) => profile.id === draft.changeProfile)) {
    return 'Select a change profile from the server catalog.'
  }
  const target = catalog.targets.find((candidate) => candidate.id === draft.targetID)
  if (!target || target.healthy === false || !target.modes.includes(draft.mode)) {
    return 'Select an available catalog target that supports this evaluation mode.'
  }
  if (draft.suiteIDs.length === 0) return 'Select at least one compatible benchmark suite.'
  if (draft.trackIDs.length === 0) return 'Select at least one track provided by those suites.'
  const reconciled = reconcileEvaluationScope(
    catalog,
    draft.targetID,
    draft.mode,
    draft.suiteIDs,
    draft.trackIDs,
  )
  if (
    !sameSet(reconciled.suiteIDs, draft.suiteIDs) ||
    !sameSet(reconciled.trackIDs, draft.trackIDs)
  ) {
    return 'The selected suites and tracks are no longer compatible with the target and mode.'
  }
  if (!isBoundedInteger(draft.sampleLimit, 1, EVALUATION_RUN_LIMITS.sampleLimit)) {
    return `Sample limit must be an integer between 1 and ${EVALUATION_RUN_LIMITS.sampleLimit}.`
  }
  if (!isBoundedInteger(draft.concurrency, 1, EVALUATION_RUN_LIMITS.concurrency)) {
    return `Concurrency must be an integer between 1 and ${EVALUATION_RUN_LIMITS.concurrency}.`
  }
  if (!isBoundedInteger(draft.seed, 0, EVALUATION_RUN_LIMITS.seed)) {
    return `Seed must be an integer between 0 and ${EVALUATION_RUN_LIMITS.seed}.`
  }
  if (draft.baselineRunID) {
    const baseline = runs.find((run) => run.id === draft.baselineRunID)
    if (!baseline) return 'The selected baseline run is no longer available.'
    const issue = baselineCohortIssue(catalog, baseline)
    if (issue) return `The selected baseline cannot be reproduced. ${issue}`
    if (!exactCohortMatchesRun(draft, baseline)) {
      return 'The candidate cohort must exactly match the selected baseline.'
    }
  }
  return null
}

export function newEvaluationClientRequestID(): string {
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    // The id is an idempotency token, not a credential. Keep creation usable in
    // constrained HTTP/WebView contexts that do not expose Web Crypto.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] % 16) + 64
  bytes[8] = (bytes[8] % 64) + 128
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
