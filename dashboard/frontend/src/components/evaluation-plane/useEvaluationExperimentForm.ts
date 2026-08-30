import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import type {
  EvaluationCapacitySLO,
  EvaluationChangeProfileId,
  EvaluationCatalog,
  EvaluationExperimentIntent,
  EvaluationMode,
  EvaluationRun,
  EvaluationTrackId,
} from '../../types/evaluationPlane'
import { EVALUATION_SCHEMA_VERSION } from '../../types/evaluationPlane'
import { requiresCapacitySLO } from '../../utils/evaluationCapacitySLOContract'
import { defaultEvaluationCapacityLoadProtocol } from '../../utils/evaluationCapacitySLOContract'
import {
  gateApplicabilityForProfile,
  SUPPORTED_GATE_CONTRACT_VERSION,
} from './evaluationGateContract'
import {
  baselineCohortIssue,
  compatibleEvaluationSuites,
  exactCohortFromRun,
  minimumCatalogEvidenceClass,
  reconcileEvaluationScope,
  selectedSuiteTracks,
  supportedEvaluationTracks,
  toggleEvaluationSuite,
  validateEvaluationDraft,
} from './evaluationExperiment'
import { newEvaluationClientRequestID } from '../../utils/evaluationIdentity'

interface UseEvaluationExperimentFormProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  canAutoStart: boolean
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  pending: boolean
  initialTargetID?: string
  preserveMissingLiveTarget?: boolean
  onSubmit: (intent: EvaluationExperimentIntent) => Promise<boolean>
}

export interface EvaluationCapacitySLOInput {
  requiredConcurrency: string
  maxLatencyP95MS: string
  maxErrorRate: string
  minThroughputRPS: string
  minThroughputScalingEfficiency: string
}

const EMPTY_CAPACITY_SLO_INPUT: EvaluationCapacitySLOInput = {
  requiredConcurrency: '',
  maxLatencyP95MS: '',
  maxErrorRate: '',
  minThroughputRPS: '',
  minThroughputScalingEfficiency: '',
}

function capacitySLOFromInput(input: EvaluationCapacitySLOInput): EvaluationCapacitySLO {
  const numberFromInput = (value: string) => (value.trim() ? Number(value) : Number.NaN)
  return {
    schema_version: EVALUATION_SCHEMA_VERSION,
    required_concurrency: numberFromInput(input.requiredConcurrency),
    max_latency_p95_ms: numberFromInput(input.maxLatencyP95MS),
    max_error_rate: numberFromInput(input.maxErrorRate),
    min_throughput_rps: numberFromInput(input.minThroughputRPS),
    min_throughput_scaling_efficiency: numberFromInput(input.minThroughputScalingEfficiency),
  }
}

function inputFromCapacitySLO(slo: EvaluationCapacitySLO): EvaluationCapacitySLOInput {
  return {
    requiredConcurrency: String(slo.required_concurrency),
    maxLatencyP95MS: String(slo.max_latency_p95_ms),
    maxErrorRate: String(slo.max_error_rate),
    minThroughputRPS: String(slo.min_throughput_rps),
    minThroughputScalingEfficiency: String(slo.min_throughput_scaling_efficiency),
  }
}

export default function useEvaluationExperimentForm({
  catalog,
  runs,
  canAutoStart,
  runLedgerAvailable,
  runLedgerComplete,
  pending,
  initialTargetID: requestedTargetID,
  preserveMissingLiveTarget = false,
  onSubmit,
}: UseEvaluationExperimentFormProps) {
  const requestedTarget = requestedTargetID
    ? catalog.targets.find(
        (target) =>
          target.id === requestedTargetID && target.modes.includes('live') && target.mixture,
      )
    : undefined
  const preferredLiveTarget = catalog.targets.find(
    (target) =>
      target.kind === 'mixture-of-models' &&
      Boolean(target.mixture) &&
      target.modes.includes('live') &&
      target.healthy !== false,
  )
  const replayFallbackTarget = catalog.targets.find(
    (target) => target.modes.includes('replay') && target.healthy !== false,
  )
  const initialMode: EvaluationMode =
    requestedTarget || preserveMissingLiveTarget || preferredLiveTarget ? 'live' : 'replay'
  const defaultTargetID =
    requestedTarget?.id ||
    (!preserveMissingLiveTarget
      ? preferredLiveTarget?.id || replayFallbackTarget?.id
      : undefined) ||
    ''
  const initialSuite = compatibleEvaluationSuites(catalog, defaultTargetID, initialMode)[0]
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<EvaluationMode>(initialMode)
  const [changeProfile, setChangeProfile] = useState<EvaluationChangeProfileId | ''>(
    catalog.change_profiles[0]?.id || '',
  )
  const [targetID, setTargetID] = useState(defaultTargetID)
  const [suiteIDs, setSuiteIDs] = useState<string[]>(initialSuite ? [initialSuite.id] : [])
  const [trackIDs, setTrackIDs] = useState<EvaluationTrackId[]>(initialSuite?.track_ids || [])
  const [sampleLimit, setSampleLimit] = useState(100)
  const [concurrency, setConcurrency] = useState(4)
  const [capacitySLOInput, setCapacitySLOInput] =
    useState<EvaluationCapacitySLOInput>(EMPTY_CAPACITY_SLO_INPUT)
  const [seed, setSeed] = useState(42)
  const [baselineRunID, setBaselineRunID] = useState('')
  const [autoStart, setAutoStart] = useState(canAutoStart)
  const [validationError, setValidationError] = useState('')
  const errorRef = useRef<HTMLDivElement | null>(null)
  const createAttempt = useRef<{ fingerprint: string; id: string } | null>(null)

  useEffect(() => {
    if (!requestedTarget || baselineRunID || pending) return
    const suite = compatibleEvaluationSuites(catalog, requestedTarget.id, 'live')[0]
    setMode('live')
    setTargetID(requestedTarget.id)
    setSuiteIDs(suite ? [suite.id] : [])
    setTrackIDs(suite?.track_ids || [])
  }, [baselineRunID, catalog, pending, requestedTarget])

  const availableTrackIDs = useMemo(
    () => supportedEvaluationTracks(catalog, targetID, mode),
    [catalog, mode, targetID],
  )
  const compatibleSuites = useMemo(
    () => compatibleEvaluationSuites(catalog, targetID, mode),
    [catalog, mode, targetID],
  )
  const completedRuns = useMemo(
    () =>
      runLedgerAvailable && runLedgerComplete
        ? runs.filter((run) => run.status === 'completed')
        : [],
    [runLedgerAvailable, runLedgerComplete, runs],
  )
  const selectedBaseline = completedRuns.find((run) => run.id === baselineRunID) || null
  const baselineLocked = selectedBaseline !== null
  const capacitySLOActive = requiresCapacitySLO(mode, trackIDs)
  const capacitySLO = capacitySLOActive ? capacitySLOFromInput(capacitySLOInput) : undefined
  const capacityLoadProtocol = capacitySLOActive
    ? selectedBaseline?.capacity_load_protocol ||
      (Number.isSafeInteger(concurrency) && concurrency >= 2
        ? defaultEvaluationCapacityLoadProtocol(concurrency)
        : undefined)
    : undefined
  const selectableTrackIDs = useMemo(
    () => selectedSuiteTracks(catalog, targetID, mode, suiteIDs),
    [catalog, mode, suiteIDs, targetID],
  )
  const selectedChangeProfile = catalog.change_profiles.find(
    (profile) => profile.id === changeProfile,
  )
  const gateApplicability =
    changeProfile && catalog.gate_contract_version === SUPPORTED_GATE_CONTRACT_VERSION
      ? gateApplicabilityForProfile(changeProfile)
      : []
  const catalogEvidenceClass = minimumCatalogEvidenceClass(
    catalog,
    suiteIDs.filter((suiteID) => compatibleSuites.some((suite) => suite.id === suiteID)),
  )

  useEffect(() => {
    if (baselineRunID) return
    if (requestedTarget && targetID === requestedTarget.id && mode === 'live') return
    if (preserveMissingLiveTarget && mode === 'live' && !targetID) return
    const compatibleTarget = catalog.targets.find(
      (target) => target.id === targetID && target.modes.includes(mode) && target.healthy !== false,
    )
    if (!compatibleTarget) {
      setTargetID(
        catalog.targets.find((target) => target.modes.includes(mode) && target.healthy !== false)
          ?.id || '',
      )
    }
  }, [baselineRunID, catalog.targets, mode, preserveMissingLiveTarget, requestedTarget, targetID])

  useEffect(() => {
    setSuiteIDs((current) =>
      current.filter((suiteID) => compatibleSuites.some((suite) => suite.id === suiteID)),
    )
  }, [compatibleSuites])

  useEffect(() => {
    setTrackIDs(
      (current) => reconcileEvaluationScope(catalog, targetID, mode, suiteIDs, current).trackIDs,
    )
  }, [catalog, mode, suiteIDs, targetID])

  useEffect(() => {
    if (!catalog.change_profiles.some((profile) => profile.id === changeProfile)) {
      setChangeProfile(catalog.change_profiles[0]?.id || '')
    }
  }, [catalog.change_profiles, changeProfile])

  useEffect(() => {
    if ((!runLedgerAvailable || !runLedgerComplete) && baselineRunID) {
      setBaselineRunID('')
      setValidationError(
        runLedgerAvailable
          ? 'Baseline selection was cleared because the durable run ledger is incomplete.'
          : 'Baseline selection was cleared because the run ledger is unavailable.',
      )
      return
    }
    if (!baselineRunID) return
    const baseline = completedRuns.find((run) => run.id === baselineRunID)
    const issue = baseline
      ? baselineCohortIssue(catalog, baseline)
      : 'The run is no longer available.'
    if (issue) {
      setBaselineRunID('')
      setValidationError(`Baseline selection was cleared. ${issue}`)
    }
  }, [baselineRunID, catalog, completedRuns, runLedgerAvailable, runLedgerComplete])

  useEffect(() => {
    if (!canAutoStart) setAutoStart(false)
  }, [canAutoStart])

  useEffect(() => {
    if (validationError) errorRef.current?.focus()
  }, [validationError])

  const toggleSuite = (suiteID: string) => {
    if (baselineLocked || pending) return
    const next = toggleEvaluationSuite(catalog, targetID, mode, suiteIDs, trackIDs, suiteID)
    setSuiteIDs(next.suiteIDs)
    setTrackIDs(next.trackIDs)
  }

  const toggleTrack = (trackID: EvaluationTrackId) => {
    if (baselineLocked || pending || !selectableTrackIDs.includes(trackID)) return
    setTrackIDs((current) =>
      current.includes(trackID) ? current.filter((id) => id !== trackID) : [...current, trackID],
    )
  }

  const selectBaseline = (runID: string) => {
    if (pending) return
    if (!runID) {
      setBaselineRunID('')
      setValidationError('')
      return
    }
    const baseline = completedRuns.find((run) => run.id === runID)
    const issue = baseline ? baselineCohortIssue(catalog, baseline) : 'The run is unavailable.'
    if (!baseline || issue) {
      setBaselineRunID('')
      setValidationError(`This run cannot be used as a baseline. ${issue}`)
      return
    }
    const cohort = exactCohortFromRun(baseline)
    setMode(cohort.mode)
    setTargetID(cohort.targetID)
    setChangeProfile(cohort.changeProfile)
    setSuiteIDs(cohort.suiteIDs)
    setTrackIDs(cohort.trackIDs)
    setSampleLimit(cohort.sampleLimit)
    setConcurrency(cohort.concurrency)
    setCapacitySLOInput(
      cohort.capacitySLO ? inputFromCapacitySLO(cohort.capacitySLO) : EMPTY_CAPACITY_SLO_INPUT,
    )
    setSeed(cohort.seed)
    setBaselineRunID(baseline.id)
    setValidationError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    if (!changeProfile) {
      setValidationError('Select a change profile from the server catalog.')
      return
    }
    const error = validateEvaluationDraft(catalog, runs, {
      name,
      description,
      mode,
      targetID,
      changeProfile,
      suiteIDs,
      trackIDs,
      sampleLimit,
      concurrency,
      capacitySLO,
      capacityLoadProtocol,
      seed,
      baselineRunID,
    })
    if (error) {
      setValidationError(error)
      return
    }
    setValidationError('')
    const request: Omit<EvaluationExperimentIntent, 'client_request_id'> = {
      name: name.trim(),
      description: description.trim(),
      suite_ids: suiteIDs,
      track_ids: trackIDs,
      mode,
      target_id: targetID,
      change_profile: changeProfile,
      sample_limit: sampleLimit,
      concurrency,
      ...(capacitySLO ? { capacity_slo: capacitySLO } : {}),
      ...(capacityLoadProtocol ? { capacity_load_protocol: capacityLoadProtocol } : {}),
      seed,
      ...(baselineRunID ? { baseline_run_id: baselineRunID } : {}),
      autoStart,
    }
    const fingerprint = JSON.stringify(request)
    if (!createAttempt.current || createAttempt.current.fingerprint !== fingerprint) {
      createAttempt.current = { fingerprint, id: newEvaluationClientRequestID() }
    }
    const created = await onSubmit({
      ...request,
      client_request_id: createAttempt.current.id,
    })
    if (created) {
      createAttempt.current = null
      setName('')
      setDescription('')
      setCapacitySLOInput(EMPTY_CAPACITY_SLO_INPUT)
    }
  }

  return {
    name,
    description,
    mode,
    changeProfile,
    targetID,
    suiteIDs,
    trackIDs,
    sampleLimit,
    concurrency,
    capacitySLOActive,
    capacitySLOInput,
    capacityLoadProtocol,
    seed,
    baselineRunID,
    autoStart,
    validationError,
    errorRef,
    availableTrackIDs,
    compatibleSuites,
    completedRuns,
    baselineLocked,
    selectableTrackIDs,
    selectedChangeProfile,
    gateApplicability,
    catalogEvidenceClass,
    setName,
    setDescription,
    setMode,
    setChangeProfile,
    setTargetID,
    setSampleLimit,
    setConcurrency,
    setCapacitySLOField: (field: keyof EvaluationCapacitySLOInput, value: string) =>
      setCapacitySLOInput((current) => ({ ...current, [field]: value })),
    applyCapacitySLOPreset: (preset: EvaluationCapacitySLOInput) => setCapacitySLOInput(preset),
    setSeed,
    setAutoStart,
    toggleSuite,
    toggleTrack,
    selectBaseline,
    submit,
  }
}

export type EvaluationExperimentFormModel = ReturnType<typeof useEvaluationExperimentForm>
