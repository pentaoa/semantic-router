import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import type {
  EvaluationChangeProfileId,
  CreateEvaluationRunRequest,
  EvaluationCatalog,
  EvaluationMode,
  EvaluationRun,
  EvaluationTrackId,
} from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import {
  gateApplicabilityForProfile,
  SUPPORTED_GATE_CONTRACT_VERSION,
} from './evaluationGateContract'
import {
  baselineCohortIssue,
  compatibleEvaluationSuites,
  compatibleSuiteEmptyReason,
  EVALUATION_RUN_LIMITS,
  exactCohortFromRun,
  minimumEvidenceClaimCeiling,
  newEvaluationClientRequestID,
  reconcileEvaluationScope,
  selectedSuiteTracks,
  supportedEvaluationTracks,
  toggleEvaluationSuite,
  validateEvaluationDraft,
} from './evaluationExperiment'
import styles from './EvaluationForm.module.css'

interface EvaluationExperimentFormProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  canCreate: boolean
  canAutoStart: boolean
  pending: boolean
  onSubmit: (request: CreateEvaluationRunRequest) => Promise<boolean>
}

export default function EvaluationExperimentForm({
  catalog,
  runs,
  canCreate,
  canAutoStart,
  pending,
  onSubmit,
}: EvaluationExperimentFormProps) {
  const initialMode: EvaluationMode = 'replay'
  const initialTargetID =
    catalog.targets.find((target) => target.modes.includes(initialMode) && target.healthy !== false)
      ?.id || ''
  const initialSuite = compatibleEvaluationSuites(catalog, initialTargetID, initialMode)[0]
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<EvaluationMode>(initialMode)
  const [changeProfile, setChangeProfile] = useState<EvaluationChangeProfileId | ''>(
    catalog.change_profiles[0]?.id || '',
  )
  const [targetID, setTargetID] = useState(initialTargetID)
  const [suiteIDs, setSuiteIDs] = useState<string[]>(initialSuite ? [initialSuite.id] : [])
  const [trackIDs, setTrackIDs] = useState<EvaluationTrackId[]>(initialSuite?.track_ids || [])
  const [sampleLimit, setSampleLimit] = useState(100)
  const [concurrency, setConcurrency] = useState(4)
  const [seed, setSeed] = useState(42)
  const [baselineRunID, setBaselineRunID] = useState('')
  const [autoStart, setAutoStart] = useState(canAutoStart)
  const [validationError, setValidationError] = useState('')
  const errorRef = useRef<HTMLDivElement | null>(null)
  const createAttempt = useRef<{ fingerprint: string; id: string } | null>(null)

  const availableTrackIDs = useMemo(
    () => supportedEvaluationTracks(catalog, targetID, mode),
    [catalog, mode, targetID],
  )
  const compatibleSuites = useMemo(
    () => compatibleEvaluationSuites(catalog, targetID, mode),
    [catalog, mode, targetID],
  )
  const completedRuns = useMemo(() => runs.filter((run) => run.status === 'completed'), [runs])
  const selectedBaseline = completedRuns.find((run) => run.id === baselineRunID) || null
  const baselineLocked = selectedBaseline !== null
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
  const evidenceLevel = minimumEvidenceClaimCeiling(
    catalog,
    suiteIDs.filter((suiteID) => compatibleSuites.some((suite) => suite.id === suiteID)),
  )

  useEffect(() => {
    if (baselineRunID) return
    const compatibleTarget = catalog.targets.find(
      (target) => target.id === targetID && target.modes.includes(mode) && target.healthy !== false,
    )
    if (!compatibleTarget) {
      setTargetID(
        catalog.targets.find((target) => target.modes.includes(mode) && target.healthy !== false)
          ?.id || '',
      )
    }
  }, [baselineRunID, catalog.targets, mode, targetID])

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
    if (!baselineRunID) return
    const baseline = completedRuns.find((run) => run.id === baselineRunID)
    const issue = baseline
      ? baselineCohortIssue(catalog, baseline)
      : 'The run is no longer available.'
    if (issue) {
      setBaselineRunID('')
      setValidationError(`Baseline selection was cleared. ${issue}`)
    }
  }, [baselineRunID, catalog, completedRuns])

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
    setSeed(cohort.seed)
    setBaselineRunID(baseline.id)
    setValidationError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canCreate || pending) return
    if (!changeProfile)
      return setValidationError('Select a change profile from the server catalog.')
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
      seed,
      baselineRunID,
    })
    if (error) return setValidationError(error)
    setValidationError('')
    const request: CreateEvaluationRunRequest = {
      name: name.trim(),
      description: description.trim(),
      suite_ids: suiteIDs,
      track_ids: trackIDs,
      mode,
      target_id: targetID,
      change_profile: changeProfile,
      sample_limit: sampleLimit,
      concurrency,
      seed,
      ...(baselineRunID ? { baseline_run_id: baselineRunID } : {}),
      auto_start: autoStart,
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
    }
  }

  if (!canCreate) {
    return (
      <section className={styles.permissionState}>
        <span>Read-only evaluation access</span>
        <h2>Experiment creation is not available for this session.</h2>
        <p>You can still inspect completed evidence, reports, provenance, and comparisons.</p>
      </section>
    )
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={pending}>
      <div className={styles.intro}>
        <div>
          <span className={styles.eyebrow}>Immutable run snapshot</span>
          <h2>New evaluation experiment</h2>
          <p>
            Suites and execution targets come from the server catalog. The browser cannot supply its
            own execution address.
          </p>
        </div>
        <div className={styles.introBadges}>
          <span className={styles.evidence}>
            {evidenceLevel ? `Claim ceiling ${evidenceLevel}` : 'Evidence pending'}
          </span>
          <span className={styles.evidence}>{catalog.gate_contract_version}</span>
        </div>
      </div>

      {validationError ? (
        <div ref={errorRef} className={styles.error} role="alert" tabIndex={-1}>
          {validationError}
        </div>
      ) : null}

      <fieldset
        disabled={pending}
        aria-busy={pending}
        aria-label="Evaluation experiment fields"
        className={styles.formFields}
      >
        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <span>01</span>
            <div>
              <h3>Identity and execution</h3>
              <p>Name the hypothesis and choose replay or live evidence.</p>
            </div>
          </div>
          <div className={styles.fieldGrid}>
            <label className={styles.fieldWide}>
              Experiment name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Recipe v3 vs production baseline"
                maxLength={EVALUATION_RUN_LIMITS.name}
                required
              />
            </label>
            <label className={styles.fieldWide}>
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Hypothesis, expected trade-offs, and promotion decision."
                rows={3}
                maxLength={EVALUATION_RUN_LIMITS.description}
              />
            </label>
            <fieldset className={styles.choiceGroup}>
              <legend>Mode</legend>
              {(['replay', 'live'] as const).map((option) => (
                <label key={option} className={styles.choiceCard}>
                  <input
                    type="radio"
                    name="evaluation-mode"
                    value={option}
                    checked={mode === option}
                    disabled={baselineLocked}
                    onChange={() => setMode(option)}
                  />
                  <span>
                    <strong>{option === 'replay' ? 'Replay' : 'Live'}</strong>
                    <small>
                      {option === 'replay'
                        ? 'Deterministic, reproducible evidence.'
                        : 'Execute against an approved runtime target.'}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              Catalog target
              <select
                value={targetID}
                disabled={baselineLocked}
                onChange={(event) => setTargetID(event.target.value)}
                required
              >
                <option value="">Select target</option>
                {catalog.targets.map((target) => (
                  <option
                    key={target.id}
                    value={target.id}
                    disabled={!target.modes.includes(mode) || target.healthy === false}
                  >
                    {target.name}
                    {target.healthy === false ? ' · not configured' : ''}
                  </option>
                ))}
              </select>
              <small>
                {catalog.targets.find((target) => target.id === targetID)?.description ||
                  'Only server-approved targets are selectable.'}
              </small>
            </label>
            <label>
              Baseline run
              <select
                value={baselineRunID}
                onChange={(event) => selectBaseline(event.target.value)}
              >
                <option value="">No baseline</option>
                {completedRuns.map((run) => {
                  const issue = baselineCohortIssue(catalog, run)
                  return (
                    <option key={run.id} value={run.id} disabled={Boolean(issue)}>
                      {run.name} · {run.change_profile} · {run.mode}
                      {issue ? ' · not eligible' : ''}
                    </option>
                  )
                })}
              </select>
              <small role={baselineLocked ? 'status' : undefined}>
                {baselineLocked
                  ? 'Exact cohort copied and locked: profile, mode, target, suites, tracks, sample limit, concurrency, and seed.'
                  : 'Selecting a baseline copies and locks its exact comparable cohort.'}
              </small>
            </label>
          </div>
        </section>

        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <span>02</span>
            <div>
              <h3>Change profile and G0–G9 contract</h3>
              <p>
                The profile defines which release gates are required, advisory, or not applicable.
              </p>
            </div>
          </div>
          <div className={styles.profileHeader}>
            <label>
              Change profile
              <select
                value={changeProfile}
                disabled={baselineLocked}
                onChange={(event) =>
                  setChangeProfile(event.target.value as EvaluationChangeProfileId)
                }
                required
              >
                <option value="">Select profile</option>
                {catalog.change_profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <small>
                {selectedChangeProfile?.description ||
                  'Only server-declared change profiles are selectable.'}
              </small>
            </label>
            <div>
              <span>Gate contract</span>
              <code>{catalog.gate_contract_version}</code>
            </div>
          </div>
          {gateApplicability.length ? (
            <div className={styles.gateMatrix} aria-label="G0–G9 gate applicability">
              {gateApplicability.map((gate) => (
                <article key={gate.id} data-disposition={gate.disposition}>
                  <div>
                    <code>{gate.id}</code>
                    <strong>{gate.name}</strong>
                  </div>
                  <span>{gate.disposition.replace('_', ' ')}</span>
                  <small>{gate.description}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.contractWarning} role="status">
              This dashboard cannot explain applicability for gate contract{' '}
              <code>{catalog.gate_contract_version}</code>. The server report remains authoritative.
            </div>
          )}
        </section>

        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <span>03</span>
            <div>
              <h3>Benchmark suites</h3>
              <p>Select versioned workloads, then refine the tracks executed by this run.</p>
            </div>
          </div>
          {compatibleSuites.length ? (
            <div className={styles.catalogGrid}>
              {compatibleSuites.map((suite) => (
                <label
                  key={suite.id}
                  className={`${styles.catalogCard} ${suiteIDs.includes(suite.id) ? styles.selected : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={suiteIDs.includes(suite.id)}
                    disabled={baselineLocked}
                    onChange={() => toggleSuite(suite.id)}
                  />
                  <span>
                    <strong>{suite.name}</strong>
                    <small>{suite.description}</small>
                    <em>
                      Claim ceiling {suite.evidence_level}
                      {suite.case_count ? ` · ${suite.case_count} cases` : ''}
                      {suite.revision ? ` · ${suite.revision}` : ''}
                    </em>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className={styles.contractWarning} role="status">
              {compatibleSuiteEmptyReason(catalog, targetID, mode)}
            </div>
          )}
        </section>

        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <span>04</span>
            <div>
              <h3>Evaluation tracks</h3>
              <p>Each track reports its own status, metrics, evidence, and gates.</p>
            </div>
          </div>
          {selectableTrackIDs.length === 0 ? (
            <div className={styles.contractWarning} role="status">
              {suiteIDs.length === 0
                ? 'Select a compatible benchmark suite to make its tracks available.'
                : 'The selected suites do not expose any executable tracks for this target and mode.'}
            </div>
          ) : null}
          <div className={styles.trackGrid}>
            {catalog.tracks.map((track) => {
              const targetSupportsTrack = availableTrackIDs.includes(track.id)
              const available = selectableTrackIDs.includes(track.id)
              return (
                <label
                  key={track.id}
                  className={`${styles.trackCard} ${trackIDs.includes(track.id) ? styles.selected : ''} ${!available ? styles.disabled : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={trackIDs.includes(track.id)}
                    disabled={baselineLocked || !available}
                    onChange={() => toggleTrack(track.id)}
                  />
                  <span>
                    <strong>{TRACK_PRESENTATION[track.id].label}</strong>
                    <small>{track.description}</small>
                    <em>
                      {available
                        ? `${track.metrics.length} metrics`
                        : !targetSupportsTrack
                          ? `Not supported for ${mode} on this target`
                          : 'Not included by the selected suites'}
                    </em>
                  </span>
                </label>
              )
            })}
          </div>
        </section>

        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <span>05</span>
            <div>
              <h3>Budget and reproducibility</h3>
              <p>Bound execution and pin the deterministic seed.</p>
            </div>
          </div>
          <div className={styles.numericGrid}>
            <label>
              Sample limit
              <input
                type="number"
                min={1}
                max={EVALUATION_RUN_LIMITS.sampleLimit}
                step={1}
                value={sampleLimit}
                disabled={baselineLocked}
                onChange={(event) => setSampleLimit(Number(event.target.value))}
              />
            </label>
            <label>
              Concurrency
              <input
                type="number"
                min={1}
                max={EVALUATION_RUN_LIMITS.concurrency}
                step={1}
                value={concurrency}
                disabled={baselineLocked}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </label>
            <label>
              Seed
              <input
                type="number"
                min={0}
                max={EVALUATION_RUN_LIMITS.seed}
                step={1}
                value={seed}
                disabled={baselineLocked}
                onChange={(event) => setSeed(Number(event.target.value))}
              />
            </label>
          </div>
          <label className={styles.autoStart}>
            <input
              type="checkbox"
              checked={autoStart}
              disabled={!canAutoStart}
              onChange={(event) => setAutoStart(event.target.checked)}
            />
            <span>
              <strong>Start immediately</strong>
              <small>
                {canAutoStart
                  ? 'Create the snapshot and enqueue execution.'
                  : 'Requires evaluation.run permission.'}
              </small>
            </span>
          </label>
        </section>

        <div className={styles.actions}>
          <span>
            {suiteIDs.length} suites · {trackIDs.length} tracks · profile{' '}
            {changeProfile || 'not selected'} · target {targetID || 'not selected'}
          </span>
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : autoStart ? 'Create and start' : 'Create draft'}
          </button>
        </div>
      </fieldset>
    </form>
  )
}
