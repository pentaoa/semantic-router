import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import ConfirmDialog from '../components/ConfirmDialog'
import DashboardManagerLayout from '../components/DashboardManagerLayout'
import ProductLoadingState from '../components/ProductLoadingState'
import EvaluationCompare from '../components/evaluation-plane/EvaluationCompare'
import EvaluationExperimentForm from '../components/evaluation-plane/EvaluationExperimentForm'
import EvaluationNavigation, {
  type EvaluationView,
} from '../components/evaluation-plane/EvaluationNavigation'
import EvaluationOverview from '../components/evaluation-plane/EvaluationOverview'
import EvaluationReports from '../components/evaluation-plane/EvaluationReports'
import EvaluationRuns from '../components/evaluation-plane/EvaluationRuns'
import {
  defaultComparisonPair,
  eligibleComparisonCandidates,
} from '../components/evaluation-plane/evaluationRunSupport'
import { useAuth } from '../contexts/AuthContext'
import { useReadonly } from '../contexts/ReadonlyContext'
import { useEvaluationComparison } from '../hooks/useEvaluationComparison'
import { useEvaluationOverviewReport } from '../hooks/useEvaluationOverviewReport'
import { useEvaluationPlane } from '../hooks/useEvaluationPlane'
import { useEvaluationReport } from '../hooks/useEvaluationReport'
import { useEvaluationRunEvents } from '../hooks/useEvaluationRunEvents'
import type { CreateEvaluationRunRequest, EvaluationRun } from '../types/evaluationPlane'
import { canRunEvaluation, canWriteEvaluation } from '../utils/accessControl'
import styles from './EvaluationPage.module.css'

const VIEWS = new Set<EvaluationView>(['overview', 'new', 'runs', 'reports', 'compare'])

function selectedView(value: string | null): EvaluationView {
  return value && VIEWS.has(value as EvaluationView) ? (value as EvaluationView) : 'overview'
}

export function EvaluationPage() {
  const { user } = useAuth()
  const { serverReadonly, isLoading: readonlyLoading } = useReadonly()
  const mutationsAllowed = !readonlyLoading && !serverReadonly
  const canWrite = mutationsAllowed && canWriteEvaluation(user)
  const canRun = mutationsAllowed && canRunEvaluation(user)
  const plane = useEvaluationPlane()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeView = selectedView(searchParams.get('view'))
  const selectedRunID = searchParams.get('run')
  const reportRunID = searchParams.get('report') || ''
  const baselineRunID = searchParams.get('baseline') || ''
  const candidateRunID = searchParams.get('candidate') || ''
  const [cancelTarget, setCancelTarget] = useState<EvaluationRun | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EvaluationRun | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const previousView = useRef(activeView)

  const updateLocation = useCallback(
    (values: Record<string, string | null>, replace = false) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          Object.entries(values).forEach(([key, value]) => {
            if (value) next.set(key, value)
            else next.delete(key)
          })
          return next
        },
        { replace },
      )
    },
    [setSearchParams],
  )

  const navigate = useCallback(
    (view: EvaluationView) => updateLocation({ view: view === 'overview' ? null : view }),
    [updateLocation],
  )

  const completedRuns = useMemo(
    () => plane.runs.filter((run) => run.status === 'completed'),
    [plane.runs],
  )
  const latestCompletedID = completedRuns[0]?.id || null
  const latestReportState = useEvaluationOverviewReport(completedRuns, activeView === 'overview')
  const reportState = useEvaluationReport(reportRunID || null)
  const comparisonState = useEvaluationComparison(
    baselineRunID,
    candidateRunID,
    plane.runLedgerComplete,
  )
  const selectedRun = plane.runs.find((run) => run.id === selectedRunID) || null
  const eventState = useEvaluationRunEvents(selectedRun, plane.refreshRuns)

  useEffect(() => {
    if (previousView.current !== activeView) {
      previousView.current = activeView
      panelRef.current?.focus()
    }
  }, [activeView])

  useEffect(() => {
    if (activeView === 'reports' && !reportRunID && latestCompletedID) {
      updateLocation({ report: latestCompletedID }, true)
    }
  }, [activeView, latestCompletedID, reportRunID, updateLocation])

  useEffect(() => {
    if (!plane.runsLoaded) return
    if (!plane.runLedgerComplete) {
      if (candidateRunID || baselineRunID) {
        updateLocation({ baseline: null, candidate: null }, true)
      }
      return
    }
    if (
      candidateRunID &&
      !eligibleComparisonCandidates(plane.runs).some(
        (run) => run.id === candidateRunID && run.baseline_run_id === baselineRunID,
      )
    ) {
      updateLocation({ baseline: null, candidate: null }, true)
      return
    }
    if (candidateRunID || baselineRunID) return
    const pair = defaultComparisonPair(plane.runs)
    if (pair) updateLocation({ baseline: pair.baselineID, candidate: pair.candidateID }, true)
  }, [
    baselineRunID,
    candidateRunID,
    plane.runLedgerComplete,
    plane.runs,
    plane.runsLoaded,
    updateLocation,
  ])

  useEffect(() => {
    if (!canRun) setCancelTarget(null)
    if (!canWrite) setDeleteTarget(null)
  }, [canRun, canWrite])

  const createRun = useCallback(
    async (request: CreateEvaluationRunRequest) => {
      if (!canWrite || (request.auto_start && !canRun)) return false
      const pendingRun = await plane.createRun({ ...request, auto_start: false })
      if (!pendingRun) return false
      updateLocation({ view: 'runs', run: pendingRun.id })
      if (!request.auto_start) return true
      const startedRun = await plane.startRun(pendingRun.id)
      return Boolean(startedRun)
    },
    [canRun, canWrite, plane, updateLocation],
  )

  const openReport = useCallback(
    (run: EvaluationRun) => {
      if (run.status !== 'completed') return
      updateLocation({ view: 'reports', report: run.id })
    },
    [updateLocation],
  )

  const confirmCancel = useCallback(async () => {
    if (!cancelTarget || !canRun) return
    const run = await plane.cancelRun(cancelTarget.id)
    if (run) {
      setCancelTarget(null)
      updateLocation({ run: run.id }, true)
    }
  }, [canRun, cancelTarget, plane, updateLocation])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !canWrite) return
    if (await plane.deleteRun(deleteTarget.id)) {
      const deletedID = deleteTarget.id
      setDeleteTarget(null)
      updateLocation(
        {
          run: selectedRunID === deletedID ? null : selectedRunID,
          report: reportRunID === deletedID ? null : reportRunID,
          candidate: candidateRunID === deletedID ? null : candidateRunID,
          baseline: baselineRunID === deletedID ? null : baselineRunID,
        },
        true,
      )
      requestAnimationFrame(() => panelRef.current?.focus())
    }
  }, [
    baselineRunID,
    canWrite,
    candidateRunID,
    deleteTarget,
    plane,
    reportRunID,
    selectedRunID,
    updateLocation,
  ])

  const runnableLevels = plane.catalog
    ? [...new Set(plane.catalog.suites.map((suite) => suite.evidence_level))].sort().join(' · ') ||
      'None'
    : 'Loading'

  return (
    <DashboardManagerLayout
      eyebrow="Evaluation plane"
      title="Evaluation"
      description="Measure routing recipes, model pools, and end-to-end behavior with reproducible evidence, honest qualification boundaries, and promotion gates."
      meta={[
        { label: 'Tracks', value: String(plane.catalog?.tracks.length || 8) },
        { label: 'Contract range', value: 'E0–E5' },
        { label: 'Current suites', value: runnableLevels },
      ]}
    >
      {!readonlyLoading && serverReadonly ? (
        <div className={styles.readonlyBanner} role="status">
          Evaluation evidence remains readable. Server read-only policy disables creation,
          execution, cancellation, and deletion.
        </div>
      ) : null}
      {plane.catalog && (plane.catalogError || plane.runsError) ? (
        <div className={styles.staleBanner} role="status">
          <span>Showing the last available state. {plane.catalogError || plane.runsError}</span>
          <button type="button" disabled={plane.refreshing} onClick={plane.refresh}>
            {plane.refreshing ? 'Retrying…' : 'Retry refresh'}
          </button>
        </div>
      ) : null}
      {plane.runsLoaded && !plane.runLedgerComplete && plane.runLedgerWarnings.length ? (
        <div className={styles.ledgerBanner} role="alert">
          <div>
            <strong>Run ledger incomplete</strong>
            <span>
              {plane.runLedgerWarnings.length} durable run bundle
              {plane.runLedgerWarnings.length === 1 ? ' is' : 's are'} quarantined. Visible runs
              remain inspectable, but baseline selection and comparison conclusions are blocked.
            </span>
          </div>
          <ul aria-label="Quarantined run evidence">
            {plane.runLedgerWarnings.map((warning) => (
              <li key={`${warning.code}-${warning.run_id}`}>
                <code>{warning.run_id}</code>
                <span>
                  {warning.evidence_file}: {warning.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plane.mutationError ? (
        <div className={styles.errorBanner} role="alert">
          <span>{plane.mutationError}</span>
          <button type="button" onClick={plane.clearMutationError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <EvaluationNavigation active={activeView} onChange={navigate} />

      <section
        id="evaluation-panel"
        ref={panelRef}
        role="tabpanel"
        aria-labelledby={`evaluation-tab-${activeView}`}
        tabIndex={-1}
        className={styles.panelRegion}
      >
        {plane.loading ? (
          <div className={styles.loading}>
            <ProductLoadingState label="Loading evaluation plane" />
          </div>
        ) : null}
        {!plane.loading && plane.catalogError && !plane.catalog ? (
          <div className={styles.loadError} role="alert">
            <h2>Evaluation catalog unavailable</h2>
            <p>{plane.catalogError}</p>
            <button type="button" onClick={plane.refresh}>
              Retry
            </button>
          </div>
        ) : null}
        {!plane.loading && plane.catalog ? (
          <>
            {activeView === 'overview' ? (
              <EvaluationOverview
                catalog={plane.catalog}
                runs={plane.runs}
                runLedgerComplete={plane.runLedgerComplete}
                latestReport={latestReportState.report}
                reportLoading={latestReportState.loading}
                reportError={latestReportState.error}
                reportFallbackCount={latestReportState.fallbackCount}
                onRetryReport={latestReportState.retry}
                onNavigate={navigate}
                onOpenReport={(id) => updateLocation({ view: 'reports', report: id }, true)}
              />
            ) : null}
            {activeView === 'new' ? (
              <EvaluationExperimentForm
                catalog={plane.catalog}
                runs={plane.runs}
                canCreate={canWrite}
                canAutoStart={canWrite && canRun}
                runLedgerComplete={plane.runLedgerComplete}
                pending={plane.mutationPending}
                onSubmit={createRun}
              />
            ) : null}
            {activeView === 'runs' ? (
              <EvaluationRuns
                runs={plane.runs}
                selectedRunID={selectedRunID}
                events={eventState.events}
                eventsConnected={eventState.connected}
                eventsError={eventState.error}
                onReconnectEvents={eventState.retry}
                canRun={canRun}
                canDelete={canWrite}
                refreshing={plane.refreshing}
                lastUpdatedAt={plane.lastUpdatedAt}
                mutationKey={plane.mutationKey}
                onSelect={(run) => updateLocation({ run: run.id }, true)}
                onStart={(run) => void plane.startRun(run.id)}
                onCancel={setCancelTarget}
                onDelete={setDeleteTarget}
                onOpenReport={openReport}
                onRefresh={() => void plane.refreshRuns()}
              />
            ) : null}
            {activeView === 'reports' ? (
              <EvaluationReports
                runs={plane.runs}
                selectedRunID={reportRunID}
                report={reportState.report}
                loading={reportState.loading}
                error={reportState.error}
                onSelect={(id) => updateLocation({ report: id }, true)}
                onRetry={() => void reportState.refresh()}
              />
            ) : null}
            {activeView === 'compare' ? (
              <EvaluationCompare
                runs={plane.runs}
                baselineID={baselineRunID}
                candidateID={candidateRunID}
                comparison={comparisonState.comparison}
                runLedgerComplete={plane.runLedgerComplete}
                loading={comparisonState.loading}
                error={comparisonState.error}
                onPairChange={(candidate, baseline) =>
                  updateLocation({ candidate, baseline }, true)
                }
                onCompare={() => void comparisonState.compare()}
                onCreateRun={() => navigate('new')}
              />
            ) : null}
          </>
        ) : null}
      </section>

      <ConfirmDialog
        isOpen={cancelTarget !== null}
        title={`Cancel ${cancelTarget?.name || 'this run'}?`}
        description="Execution stops and no completed report is published. Durable lifecycle events and terminal status remain available; worker staging is not presented as partial scientific evidence."
        eyebrow="Evaluation execution"
        confirmLabel="Cancel run"
        pendingLabel="Cancelling…"
        tone="warning"
        pending={plane.mutationKey === `cancel:${cancelTarget?.id || ''}`}
        details={cancelTarget ? <code>{cancelTarget.id}</code> : null}
        onCancel={() => setCancelTarget(null)}
        onConfirm={confirmCancel}
      />
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name || 'this run'}?`}
        description="This permanently removes the run bundle and Dashboard history. Download required artifacts before continuing."
        eyebrow="Evaluation evidence"
        confirmLabel="Delete run"
        pendingLabel="Deleting…"
        pending={plane.mutationKey === `delete:${deleteTarget?.id || ''}`}
        confirmationText={deleteTarget?.name}
        details={deleteTarget ? <code>{deleteTarget.id}</code> : null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </DashboardManagerLayout>
  )
}

export default EvaluationPage
