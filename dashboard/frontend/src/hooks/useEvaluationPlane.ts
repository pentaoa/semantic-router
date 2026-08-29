import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  CreateEvaluationRunRequest,
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

export function useEvaluationPlane() {
  const [catalog, setCatalog] = useState<EvaluationCatalog | null>(null)
  const [runs, setRuns] = useState<EvaluationRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runLedgerComplete, setRunLedgerComplete] = useState(false)
  const [runLedgerWarnings, setRunLedgerWarnings] = useState<EvaluationRunLedgerWarning[]>([])
  const [loadPending, setLoadPending] = useState({ catalog: true, runs: true })
  const [refreshing, setRefreshing] = useState(false)
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

  const refresh = useCallback(async (showLoading = false) => {
    const catalogVersion = ++catalogRequestVersion.current
    const runsVersion = ++runsRequestVersion.current
    catalogController.current?.abort()
    runsController.current?.abort()
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
    const runsRequest = listEvaluationRuns(nextRunsController.signal)
      .then((ledger) => {
        if (nextRunsController.signal.aborted || runsVersion !== runsRequestVersion.current) return
        setRuns(sortRuns(ledger.runs))
        setRunsLoaded(true)
        setRunLedgerComplete(ledger.ledger_complete)
        setRunLedgerWarnings(ledger.warnings)
        setRunsError(null)
        setLastUpdatedAt(new Date())
      })
      .catch((reason: unknown) => {
        if (nextRunsController.signal.aborted || runsVersion !== runsRequestVersion.current) return
        setRunLedgerComplete(false)
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
  }, [])

  const refreshRuns = useCallback(async () => {
    const version = ++runsRequestVersion.current
    runsController.current?.abort()
    const controller = new AbortController()
    runsController.current = controller
    setRefreshing(true)
    try {
      const ledger = await listEvaluationRuns(controller.signal)
      if (controller.signal.aborted || version !== runsRequestVersion.current) return
      setRuns(sortRuns(ledger.runs))
      setRunsLoaded(true)
      setRunLedgerComplete(ledger.ledger_complete)
      setRunLedgerWarnings(ledger.warnings)
      setRunsError(null)
      setLastUpdatedAt(new Date())
    } catch (refreshError) {
      if (controller.signal.aborted || version !== runsRequestVersion.current) return
      setRunLedgerComplete(false)
      setRunsError(messageFrom(refreshError, 'Failed to refresh evaluation runs.'))
    } finally {
      if (version === runsRequestVersion.current) {
        setLoadPending((current) => ({ ...current, runs: false }))
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh(true)
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshRuns()
    }, 5_000)
    const handleVisibility = () => {
      if (!document.hidden) void refreshRuns()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      catalogRequestVersion.current += 1
      runsRequestVersion.current += 1
      catalogController.current?.abort()
      runsController.current?.abort()
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
        setRefreshing(false)
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
    async (request: CreateEvaluationRunRequest) => {
      if (!catalog) {
        setMutationError('The evaluation catalog is not available yet.')
        return null
      }
      return mutateRun(
        'create',
        () => createEvaluationRun(request, catalog),
        'Failed to create the evaluation run.',
      )
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
      setRefreshing(false)
      setRuns((current) => current.filter((run) => run.id !== id))
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
    loading: loadPending.catalog || loadPending.runs,
    refreshing,
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
    createRun,
    startRun,
    cancelRun,
    deleteRun,
  }
}
