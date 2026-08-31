import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import DashboardManagerLayout from '../components/DashboardManagerLayout'
import ProductLoadingState from '../components/ProductLoadingState'
import EvaluationExperimentForm from '../components/evaluation-plane/EvaluationExperimentForm'
import EvaluationNavigation, {
  type EvaluationView,
} from '../components/evaluation-plane/EvaluationNavigation'
import EvaluationOverview from '../components/evaluation-plane/EvaluationOverview'
import EvaluationReports from '../components/evaluation-plane/EvaluationReports'
import EvaluationRuns from '../components/evaluation-plane/EvaluationRuns'
import { EvaluationActionButton } from '../components/evaluation-plane/EvaluationPrimitives'
import { defaultComparisonPair } from '../components/evaluation-plane/evaluationRunSupport'
import { useAuth } from '../contexts/AuthContext'
import { useReadonly } from '../contexts/ReadonlyContext'
import { useEvaluationPlane } from '../hooks/useEvaluationPlane'
import { useEvaluationReport } from '../hooks/useEvaluationReport'
import { useEvaluationRun } from '../hooks/useEvaluationRun'
import { useEvaluationRunEvents } from '../hooks/useEvaluationRunEvents'
import type { EvaluationExperimentIntent, EvaluationRun } from '../types/evaluationPlane'
import { canRunEvaluation, canWriteEvaluation } from '../utils/accessControl'
import {
  parseEvaluationRoute,
  removeEvaluationRun,
  serializeEvaluationRoute,
  type EvaluationRoute,
} from './evaluationRoute'
import styles from './EvaluationPage.module.css'
import EvaluationCompareWorkspace from './EvaluationCompareWorkspace'
import EvaluationPageStatus from './EvaluationPageStatus'
import EvaluationRunActionDialogs from './EvaluationRunActionDialogs'

export function EvaluationPage() {
  const { user } = useAuth()
  const { serverReadonly, isLoading: readonlyLoading } = useReadonly()
  const mutationsAllowed = !readonlyLoading && !serverReadonly
  const canWrite = mutationsAllowed && canWriteEvaluation(user)
  const canRun = mutationsAllowed && canRunEvaluation(user)
  const plane = useEvaluationPlane()
  const [searchParams, setSearchParams] = useSearchParams()
  const route = useMemo(() => parseEvaluationRoute(searchParams), [searchParams])
  const activeView = route.view
  const [cancelTarget, setCancelTarget] = useState<EvaluationRun | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EvaluationRun | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const previousView = useRef(activeView)

  const setRoute = useCallback(
    (nextRoute: EvaluationRoute, replace = false) => {
      setSearchParams(serializeEvaluationRoute(nextRoute), { replace })
    },
    [setSearchParams],
  )

  const completedRuns = useMemo(
    () => plane.runs.filter((run) => run.status === 'completed'),
    [plane.runs],
  )
  const latestCompletedID = completedRuns[0]?.id || null
  const selectedRunID = route.view === 'runs' ? route.runID || plane.runs[0]?.id || null : null
  const requestedReportRunID = route.view === 'reports' ? route.reportRunID : null
  const reportRunID = activeView === 'reports' ? requestedReportRunID || latestCompletedID : null
  const defaultPair = useMemo(
    () => (plane.runLedgerComplete ? defaultComparisonPair(plane.runs) : null),
    [plane.runLedgerComplete, plane.runs],
  )
  const latestReportState = useEvaluationReport(
    activeView === 'overview' ? latestCompletedID : null,
  )
  const reportState = useEvaluationReport(reportRunID)
  const loadedSelectedRun = plane.runs.find((run) => run.id === selectedRunID) || null
  const selectedRunState = useEvaluationRun(selectedRunID, loadedSelectedRun)
  const selectedRun = selectedRunState.run
  const refreshSelectedRunResource = selectedRunState.refresh
  const refreshRunLedger = plane.refreshRuns
  const refreshSelectedRun = useCallback(() => {
    void refreshSelectedRunResource()
    void refreshRunLedger()
  }, [refreshRunLedger, refreshSelectedRunResource])
  const eventState = useEvaluationRunEvents(selectedRun, refreshSelectedRun)

  const navigate = useCallback(
    (view: EvaluationView) => {
      switch (view) {
        case 'new':
          setRoute({ view, entrypoint: null })
          break
        case 'runs':
          setRoute({ view, runID: null })
          break
        case 'reports':
          setRoute({ view, reportRunID: latestCompletedID })
          break
        case 'compare':
          setRoute({
            view,
            baselineRunID: defaultPair?.baselineID || null,
            candidateRunID: defaultPair?.candidateID || null,
            campaignID: null,
          })
          break
        default:
          setRoute({ view: 'overview' })
      }
    },
    [defaultPair, latestCompletedID, setRoute],
  )

  useEffect(() => {
    if (previousView.current !== activeView) {
      previousView.current = activeView
      panelRef.current?.focus({ preventScroll: true })
    }
  }, [activeView])

  useEffect(() => {
    if (!canRun) setCancelTarget(null)
    if (!canWrite) setDeleteTarget(null)
  }, [canRun, canWrite])

  const createRun = useCallback(
    async (intent: EvaluationExperimentIntent) => {
      if (!canWrite || (intent.autoStart && !canRun)) return false
      const { autoStart, ...request } = intent
      const pendingRun = await plane.createRun(request)
      if (!pendingRun) return false
      setRoute({ view: 'runs', runID: pendingRun.id })
      if (!autoStart) return true
      const startedRun = await plane.startRun(pendingRun.id)
      return Boolean(startedRun)
    },
    [canRun, canWrite, plane, setRoute],
  )

  const openReport = useCallback(
    (run: EvaluationRun) => {
      if (run.status !== 'completed') return
      setRoute({ view: 'reports', reportRunID: run.id })
    },
    [setRoute],
  )

  const confirmCancel = useCallback(async () => {
    if (!cancelTarget || !canRun) return
    const run = await plane.cancelRun(cancelTarget.id)
    if (run) {
      setCancelTarget(null)
      setRoute({ view: 'runs', runID: run.id }, true)
    }
  }, [canRun, cancelTarget, plane, setRoute])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !canWrite) return
    if (await plane.deleteRun(deleteTarget.id)) {
      const deletedID = deleteTarget.id
      setDeleteTarget(null)
      setRoute(removeEvaluationRun(route, deletedID), true)
      requestAnimationFrame(() => panelRef.current?.focus())
    }
  }, [canWrite, deleteTarget, plane, route, setRoute])

  const runnableLevels = plane.catalog
    ? [
        ...new Set(
          plane.catalog.suites
            .filter((suite) => suite.methods.some((method) => method.status !== 'data_required'))
            .map((suite) => suite.evidence_level),
        ),
      ]
        .sort()
        .join(' · ') || 'None'
    : 'Loading'
  return (
    <DashboardManagerLayout
      compactHero
      eyebrow="Evaluation plane"
      title="Evaluation"
      description="Measure routing recipes, model pools, and end-to-end behavior with reproducible evidence, honest qualification boundaries, and promotion gates."
      meta={[
        { label: 'Tracks', value: String(plane.catalog?.tracks.length || 8) },
        { label: 'Contract range', value: 'E0–E5' },
        { label: 'Current suites', value: runnableLevels },
      ]}
    >
      <EvaluationPageStatus
        readonlyLoading={readonlyLoading}
        serverReadonly={serverReadonly}
        hasCatalog={plane.catalog !== null}
        catalogError={plane.catalogError}
        runsError={plane.runsError}
        runsLoaded={plane.runsLoaded}
        refreshing={plane.refreshing}
        runLedgerComplete={plane.runLedgerComplete}
        runLedgerWarningCount={plane.runLedgerWarningCount}
        runLedgerWarnings={plane.runLedgerWarnings}
        mutationError={plane.mutationError}
        onRefresh={plane.refresh}
        onClearMutationError={plane.clearMutationError}
      />

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
            <EvaluationActionButton type="button" onClick={plane.refresh}>
              Retry
            </EvaluationActionButton>
          </div>
        ) : null}
        {!plane.loading && plane.catalog ? (
          <>
            {activeView === 'overview' ? (
              <EvaluationOverview
                catalog={plane.catalog}
                runs={plane.runs}
                totalRuns={plane.totalRuns}
                hasMoreRuns={plane.hasMoreRuns}
                loadingMoreRuns={plane.loadingMoreRuns}
                runLedgerAvailable={plane.runsLoaded}
                runLedgerComplete={plane.runLedgerComplete}
                latestReport={latestReportState.report}
                requestedReportRunID={latestCompletedID}
                reportLoading={latestReportState.loading}
                reportError={latestReportState.error}
                onRetryReport={() => void latestReportState.refresh()}
                onLoadMoreRuns={() => void plane.loadMoreRuns()}
                onNavigate={navigate}
                onOpenReport={(id) => setRoute({ view: 'reports', reportRunID: id })}
              />
            ) : null}
            {activeView === 'new' ? (
              <EvaluationExperimentForm
                catalog={plane.catalog}
                runs={plane.runs}
                totalRuns={plane.totalRuns}
                canCreate={canWrite}
                canAutoStart={canWrite && canRun}
                runLedgerAvailable={plane.runsLoaded}
                runLedgerComplete={plane.runLedgerComplete}
                hasMoreRuns={plane.hasMoreRuns}
                loadingMoreRuns={plane.loadingMoreRuns}
                pending={plane.mutationPending}
                initialEntrypoint={route.view === 'new' ? route.entrypoint : null}
                onLoadMoreRuns={() => void plane.loadMoreRuns()}
                onSubmit={createRun}
              />
            ) : null}
            {activeView === 'runs' ? (
              <EvaluationRuns
                runs={plane.runs}
                selectedRunID={selectedRunID}
                selectedRun={selectedRun}
                selectedRunLoading={selectedRunState.loading}
                selectedRunError={selectedRunState.error}
                onRetrySelectedRun={() => void selectedRunState.refresh()}
                events={eventState.events}
                eventsConnected={eventState.connected}
                eventsError={eventState.error}
                onReconnectEvents={eventState.retry}
                canRun={canRun}
                canDelete={canWrite}
                refreshing={plane.refreshing}
                loadingMore={plane.loadingMoreRuns}
                runLedgerAvailable={plane.runsLoaded}
                autoRefreshPaused={plane.runPollingPaused}
                totalRuns={plane.totalRuns}
                hasMoreRuns={plane.hasMoreRuns}
                lastUpdatedAt={plane.lastUpdatedAt}
                mutationKey={plane.mutationKey}
                onSelect={(run) => setRoute({ view: 'runs', runID: run.id }, true)}
                onStart={(run) => void plane.startRun(run.id)}
                onCancel={setCancelTarget}
                onDelete={setDeleteTarget}
                onOpenReport={openReport}
                onRefresh={refreshSelectedRun}
                onLoadMore={() => void plane.loadMoreRuns()}
              />
            ) : null}
            {activeView === 'reports' ? (
              <EvaluationReports
                runs={plane.runs}
                selectedRunID={reportRunID || ''}
                report={reportState.report}
                loading={reportState.loading}
                runLedgerAvailable={plane.runsLoaded}
                totalRuns={plane.totalRuns}
                hasMoreRuns={plane.hasMoreRuns}
                loadingMoreRuns={plane.loadingMoreRuns}
                error={reportState.error}
                onSelect={(id) => setRoute({ view: 'reports', reportRunID: id }, true)}
                onRetry={() => void reportState.refresh()}
                onLoadMoreRuns={() => void plane.loadMoreRuns()}
              />
            ) : null}
            {route.view === 'compare' ? (
              <EvaluationCompareWorkspace
                catalog={plane.catalog}
                runs={plane.runs}
                totalRuns={plane.totalRuns}
                runLedgerAvailable={plane.runsLoaded}
                runLedgerComplete={plane.runLedgerComplete}
                hasMoreRuns={plane.hasMoreRuns}
                loadingMoreRuns={plane.loadingMoreRuns}
                loadingAllRuns={plane.loadingAllRuns}
                canCreateCampaign={canWrite}
                route={route}
                defaultPair={defaultPair}
                onRouteChange={(nextRoute) => setRoute(nextRoute, true)}
                onLoadMoreRuns={() => void plane.loadMoreRuns()}
                onLoadAllRuns={() => void plane.loadAllRuns()}
                onRefreshRuns={() => plane.refreshRuns()}
                onCreateRun={() => navigate('new')}
              />
            ) : null}
          </>
        ) : null}
      </section>

      <EvaluationRunActionDialogs
        cancelTarget={cancelTarget}
        deleteTarget={deleteTarget}
        mutationKey={plane.mutationKey}
        error={plane.mutationError}
        onCloseCancel={() => {
          setCancelTarget(null)
          plane.clearMutationError()
        }}
        onCloseDelete={() => {
          setDeleteTarget(null)
          plane.clearMutationError()
        }}
        onConfirmCancel={confirmCancel}
        onConfirmDelete={confirmDelete}
      />
    </DashboardManagerLayout>
  )
}

export default EvaluationPage
