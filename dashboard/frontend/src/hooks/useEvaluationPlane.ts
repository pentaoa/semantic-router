import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  CreateEvaluationRunPayload,
  EvaluationCatalog,
  EvaluationRun,
  EvaluationRunLedgerWarning,
} from '../types/evaluationPlane'
import {
  cancelEvaluationRun,
  createEvaluationRun,
  deleteEvaluationRun,
  getEvaluationCatalog,
  listEvaluationRuns,
  startEvaluationRun,
} from '../utils/evaluationPlaneApi'

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function sortRuns(runs: EvaluationRun[]): EvaluationRun[] {
  return [...runs].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
}

function mergeRuns(current: EvaluationRun[], nextPage: EvaluationRun[]): EvaluationRun[] {
  return sortRuns([...new Map([...current, ...nextPage].map((run) => [run.id, run])).values()])
}

export function useEvaluationPlane() {
  const [catalog, setCatalog] = useState<EvaluationCatalog | null>(null)
  const [runs, setRuns] = useState<EvaluationRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runLedgerComplete, setRunLedgerComplete] = useState(false)
  const [runLedgerWarnings, setRunLedgerWarnings] = useState<EvaluationRunLedgerWarning[]>([])
  const [runPage, setRunPage] = useState({
    nextCursor: null as string | null,
    totalRuns: 0,
    warningCount: 0,
  })
  const [loadPending, setLoadPending] = useState({ catalog: true, runs: true })
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false)
  const [loadingAllRuns, setLoadingAllRuns] = useState(false)
  const [runPollingPaused, setRunPollingPaused] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [mutationPending, setMutationPending] = useState(false)
  const [mutationKey, setMutationKey] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const catalogRequestVersion = useRef(0)
  const runsRequestVersion = useRef(0)
  const catalogController = useRef<AbortController | null>(null)
  const runsController = useRef<AbortController | null>(null)
  const mutationLock = useRef(false)
  const loadedPageCount = useRef(0)
  const loadingMoreRequest = useRef(false)

  const applyRunLedger = useCallback(
    (ledger: Awaited<ReturnType<typeof listEvaluationRuns>>, append: boolean) => {
      setRuns((current) => (append ? mergeRuns(current, ledger.runs) : sortRuns(ledger.runs)))
      setRunsLoaded(true)
      setRunLedgerComplete(ledger.ledger_complete)
      setRunLedgerWarnings(ledger.warnings)
      setRunPage({
        nextCursor: ledger.next_cursor || null,
        totalRuns: ledger.total_runs,
        warningCount: ledger.warning_count,
      })
      setRunsError(null)
      setLastUpdatedAt(new Date())
      loadedPageCount.current = append ? loadedPageCount.current + 1 : 1
      setRunPollingPaused(append)
    },
    [],
  )

  const refresh = useCallback(
    async (showLoading = false) => {
      const catalogVersion = ++catalogRequestVersion.current
      const runsVersion = ++runsRequestVersion.current
      catalogController.current?.abort()
      runsController.current?.abort()
      loadingMoreRequest.current = false
      setLoadingMoreRuns(false)
      setLoadingAllRuns(false)
      const nextCatalogController = new AbortController()
      const nextRunsController = new AbortController()
      catalogController.current = nextCatalogController
      runsController.current = nextRunsController
      if (showLoading) setLoadPending({ catalog: true, runs: true })
      else setRefreshing(true)
      const catalogRequest = getEvaluationCatalog(nextCatalogController.signal)
        .then((nextCatalog) => {
          if (
            nextCatalogController.signal.aborted ||
            catalogVersion !== catalogRequestVersion.current
          )
            return
          setCatalog(nextCatalog)
          setCatalogError(null)
        })
        .catch((reason: unknown) => {
          if (
            nextCatalogController.signal.aborted ||
            catalogVersion !== catalogRequestVersion.current
          )
            return
          setCatalogError(messageFrom(reason, 'Failed to load the evaluation catalog.'))
        })
        .finally(() => {
          if (catalogVersion === catalogRequestVersion.current) {
            setLoadPending((current) => ({ ...current, catalog: false }))
          }
        })
      const runsRequest = listEvaluationRuns({ signal: nextRunsController.signal })
        .then((ledger) => {
          if (nextRunsController.signal.aborted || runsVersion !== runsRequestVersion.current)
            return
          applyRunLedger(ledger, false)
        })
        .catch((reason: unknown) => {
          if (nextRunsController.signal.aborted || runsVersion !== runsRequestVersion.current)
            return
          setRunsError(messageFrom(reason, 'Failed to load evaluation runs.'))
        })
        .finally(() => {
          if (runsVersion === runsRequestVersion.current) {
            setLoadPending((current) => ({ ...current, runs: false }))
          }
        })
      await Promise.allSettled([catalogRequest, runsRequest])
      if (!nextRunsController.signal.aborted && runsVersion === runsRequestVersion.current) {
        setRefreshing(false)
      }
    },
    [applyRunLedger],
  )

  const refreshRuns = useCallback(async () => {
    const version = ++runsRequestVersion.current
    runsController.current?.abort()
    loadingMoreRequest.current = false
    setLoadingMoreRuns(false)
    setLoadingAllRuns(false)
    const controller = new AbortController()
    runsController.current = controller
    setRefreshing(true)
    try {
      const ledger = await listEvaluationRuns({ signal: controller.signal })
      if (controller.signal.aborted || version !== runsRequestVersion.current) return false
      applyRunLedger(ledger, false)
      return true
    } catch (refreshError) {
      if (controller.signal.aborted || version !== runsRequestVersion.current) return false
      setRunsError(messageFrom(refreshError, 'Failed to refresh evaluation runs.'))
      return false
    } finally {
      if (version === runsRequestVersion.current) {
        setLoadPending((current) => ({ ...current, runs: false }))
        setRefreshing(false)
      }
    }
  }, [applyRunLedger])

  const loadMoreRuns = useCallback(async () => {
    const cursor = runPage.nextCursor
    if (!cursor || refreshing || loadingMoreRuns) return
    const version = ++runsRequestVersion.current
    runsController.current?.abort()
    const controller = new AbortController()
    runsController.current = controller
    loadingMoreRequest.current = true
    setLoadingMoreRuns(true)
    try {
      const ledger = await listEvaluationRuns({ cursor, signal: controller.signal })
      if (controller.signal.aborted || version !== runsRequestVersion.current) return
      applyRunLedger(ledger, true)
    } catch (loadError) {
      if (controller.signal.aborted || version !== runsRequestVersion.current) return
      setRunsError(messageFrom(loadError, 'Failed to load more evaluation runs.'))
    } finally {
      if (version === runsRequestVersion.current) {
        loadingMoreRequest.current = false
        setLoadingMoreRuns(false)
      }
    }
  }, [applyRunLedger, loadingMoreRuns, refreshing, runPage.nextCursor])

  const loadAllRuns = useCallback(async () => {
    let cursor = runPage.nextCursor
    if (!cursor || refreshing || loadingMoreRuns) return
    const version = ++runsRequestVersion.current
    runsController.current?.abort()
    const controller = new AbortController()
    runsController.current = controller
    loadingMoreRequest.current = true
    setLoadingMoreRuns(true)
    setLoadingAllRuns(true)
    const pages: EvaluationRun[] = []
    let finalLedger: Awaited<ReturnType<typeof listEvaluationRuns>> | null = null
    let pageCount = 0
    try {
      while (cursor) {
        const ledger = await listEvaluationRuns({ cursor, signal: controller.signal })
        if (controller.signal.aborted || version !== runsRequestVersion.current) return
        pages.push(...ledger.runs)
        finalLedger = ledger
        cursor = ledger.next_cursor || ''
        pageCount += 1
      }
      if (!finalLedger) return
      const merged = mergeRuns(runs, pages)
      setRuns(merged)
      setRunsLoaded(true)
      setRunLedgerComplete(finalLedger.ledger_complete)
      setRunLedgerWarnings(finalLedger.warnings)
      setRunPage({
        nextCursor: null,
        totalRuns: finalLedger.total_runs,
        warningCount: finalLedger.warning_count,
      })
      setRunsError(
        merged.length === finalLedger.total_runs
          ? null
          : 'The run ledger changed while it was loading. Refresh before building a campaign.',
      )
      setLastUpdatedAt(new Date())
      loadedPageCount.current += pageCount
      setRunPollingPaused(true)
    } catch (loadError) {
      if (controller.signal.aborted || version !== runsRequestVersion.current) return
      setRunsError(messageFrom(loadError, 'Failed to load the complete evaluation run ledger.'))
    } finally {
      if (version === runsRequestVersion.current) {
        loadingMoreRequest.current = false
        setLoadingMoreRuns(false)
        setLoadingAllRuns(false)
      }
    }
  }, [loadingMoreRuns, refreshing, runPage.nextCursor, runs])

  useEffect(() => {
    void refresh(true)
    const interval = window.setInterval(() => {
      if (!document.hidden && !loadingMoreRequest.current && loadedPageCount.current <= 1)
        void refreshRuns()
    }, 5_000)
    const handleVisibility = () => {
      if (!document.hidden && !loadingMoreRequest.current && loadedPageCount.current <= 1)
        void refreshRuns()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      catalogRequestVersion.current += 1
      runsRequestVersion.current += 1
      catalogController.current?.abort()
      runsController.current?.abort()
      loadingMoreRequest.current = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refresh, refreshRuns])

  const replaceRun = useCallback((nextRun: EvaluationRun) => {
    setRuns((current) =>
      sortRuns([nextRun, ...current.filter((candidate) => candidate.id !== nextRun.id)]),
    )
  }, [])

  const mutateRun = useCallback(
    async (key: string, operation: () => Promise<EvaluationRun>, fallback: string) => {
      if (mutationLock.current) return null
      mutationLock.current = true
      setMutationPending(true)
      setMutationKey(key)
      setMutationError(null)
      try {
        const run = await operation()
        runsRequestVersion.current += 1
        runsController.current?.abort()
        loadingMoreRequest.current = false
        setRefreshing(false)
        setLoadingMoreRuns(false)
        setLoadingAllRuns(false)
        replaceRun(run)
        setLastUpdatedAt(new Date())
        return run
      } catch (mutationFailure) {
        setMutationError(messageFrom(mutationFailure, fallback))
        return null
      } finally {
        mutationLock.current = false
        setMutationPending(false)
        setMutationKey(null)
      }
    },
    [replaceRun],
  )

  const createRun = useCallback(
    async (request: CreateEvaluationRunPayload) => {
      if (!catalog) {
        setMutationError('The evaluation catalog is not available yet.')
        return null
      }
      const created = await mutateRun(
        'create',
        () => createEvaluationRun(request, catalog),
        'Failed to create the evaluation run.',
      )
      if (created) {
        setRunPage((current) => ({ ...current, totalRuns: current.totalRuns + 1 }))
      }
      return created
    },
    [catalog, mutateRun],
  )

  const startRun = useCallback(
    (id: string) =>
      mutateRun(`start:${id}`, () => startEvaluationRun(id), 'Failed to start the evaluation run.'),
    [mutateRun],
  )

  const cancelRun = useCallback(
    (id: string) =>
      mutateRun(
        `cancel:${id}`,
        () => cancelEvaluationRun(id),
        'Failed to cancel the evaluation run.',
      ),
    [mutateRun],
  )

  const deleteRun = useCallback(async (id: string) => {
    if (mutationLock.current) return false
    mutationLock.current = true
    setMutationPending(true)
    setMutationKey(`delete:${id}`)
    setMutationError(null)
    try {
      await deleteEvaluationRun(id)
      runsRequestVersion.current += 1
      runsController.current?.abort()
      loadingMoreRequest.current = false
      setRefreshing(false)
      setLoadingMoreRuns(false)
      setLoadingAllRuns(false)
      setRuns((current) => current.filter((run) => run.id !== id))
      setRunPage((current) => ({
        ...current,
        totalRuns: Math.max(0, current.totalRuns - 1),
      }))
      setLastUpdatedAt(new Date())
      return true
    } catch (mutationFailure) {
      setMutationError(messageFrom(mutationFailure, 'Failed to delete the evaluation run.'))
      return false
    } finally {
      mutationLock.current = false
      setMutationPending(false)
      setMutationKey(null)
    }
  }, [])

  return {
    catalog,
    runs,
    runsLoaded,
    runLedgerComplete,
    runLedgerWarnings,
    runLedgerWarningCount: runPage.warningCount,
    totalRuns: runPage.totalRuns,
    hasMoreRuns: Boolean(runPage.nextCursor),
    loading: loadPending.catalog || loadPending.runs,
    refreshing,
    loadingMoreRuns,
    loadingAllRuns,
    runPollingPaused,
    error: catalogError || runsError,
    catalogError,
    runsError,
    lastUpdatedAt,
    mutationPending,
    mutationKey,
    mutationError,
    clearMutationError: () => setMutationError(null),
    refresh: () => refresh(true),
    refreshRuns,
    loadMoreRuns,
    loadAllRuns,
    createRun,
    startRun,
    cancelRun,
    deleteRun,
  }
}
