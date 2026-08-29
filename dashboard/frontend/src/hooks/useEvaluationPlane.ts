import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  CreateEvaluationRunRequest,
  EvaluationCatalog,
  EvaluationComparison,
  EvaluationReport,
  EvaluationRun,
  EvaluationRunLedgerWarning,
  EvaluationRunEvent,
} from '../types/evaluationPlane'
import {
  cancelEvaluationRun,
  compareEvaluationRuns,
  createEvaluationRun,
  deleteEvaluationRun,
  getEvaluationCatalog,
  getEvaluationReport,
  listEvaluationRuns,
  startEvaluationRun,
  subscribeToEvaluationRun,
} from '../utils/evaluationPlaneApi'
import { appendEvaluationEvent } from './evaluationEventSupport'

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
  const [loading, setLoading] = useState(true)
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
    if (showLoading) setLoading(true)
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
        if (catalogVersion === catalogRequestVersion.current) setLoading(false)
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
      if (version === runsRequestVersion.current) setRefreshing(false)
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
    loading,
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

export function useEvaluationReport(runID: string | null) {
  const [report, setReport] = useState<EvaluationReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const refresh = useCallback(async () => {
    if (!runID) return
    const version = ++requestVersion.current
    setLoading(true)
    try {
      const nextReport = await getEvaluationReport(runID)
      if (version !== requestVersion.current) return
      setReport(nextReport)
      setError(null)
    } catch (reportError) {
      if (version !== requestVersion.current) return
      setReport(null)
      setError(messageFrom(reportError, 'Failed to load the evaluation report.'))
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [runID])

  useEffect(() => {
    const version = ++requestVersion.current
    setReport(null)
    setError(null)
    setLoading(false)
    if (!runID) return
    const controller = new AbortController()
    setLoading(true)
    void getEvaluationReport(runID, controller.signal)
      .then((nextReport) => {
        if (version !== requestVersion.current) return
        setReport(nextReport)
        setError(null)
      })
      .catch((reportError: unknown) => {
        if (controller.signal.aborted || version !== requestVersion.current) return
        setError(messageFrom(reportError, 'Failed to load the evaluation report.'))
      })
      .finally(() => {
        if (!controller.signal.aborted && version === requestVersion.current) setLoading(false)
      })
    return () => {
      requestVersion.current += 1
      controller.abort()
    }
  }, [runID])

  return { report: report?.run.id === runID ? report : null, loading, error, refresh }
}

export function useEvaluationComparison(
  baselineID: string,
  candidateID: string,
  runLedgerComplete = true,
) {
  const [comparison, setComparison] = useState<EvaluationComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const compare = useCallback(async () => {
    if (!runLedgerComplete || !baselineID || !candidateID || baselineID === candidateID) return
    const version = ++requestVersion.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setLoading(true)
    setComparison(null)
    try {
      const nextComparison = await compareEvaluationRuns(
        baselineID,
        candidateID,
        nextController.signal,
      )
      if (nextController.signal.aborted || version !== requestVersion.current) return
      setComparison(nextComparison)
      setError(null)
    } catch (comparisonError) {
      if (nextController.signal.aborted || version !== requestVersion.current) return
      setError(messageFrom(comparisonError, 'Failed to compare evaluation runs.'))
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [baselineID, candidateID, runLedgerComplete])

  useEffect(() => {
    requestVersion.current += 1
    controller.current?.abort()
    setComparison(null)
    setError(null)
    setLoading(false)
  }, [baselineID, candidateID, runLedgerComplete])

  useEffect(
    () => () => {
      requestVersion.current += 1
      controller.current?.abort()
    },
    [],
  )

  return { comparison, loading, error, compare }
}

export function useEvaluationRunEvents(run: EvaluationRun | null, onTerminal: () => void) {
  const [events, setEvents] = useState<EvaluationRunEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const terminalHandler = useRef(onTerminal)
  terminalHandler.current = onTerminal
  const runID = run?.id || null
  const runStatus = run?.status || null

  useEffect(() => {
    setEvents([])
    setError(null)
    setConnected(false)
    if (!runID) return

    let disconnect: (() => void) | null = null
    const connect = () => {
      if (document.hidden || disconnect) return
      disconnect = subscribeToEvaluationRun(
        runID,
        (event) => {
          setConnected(true)
          setError(null)
          setEvents((current) => appendEvaluationEvent(current, event))
        },
        () => {
          disconnect = null
          setConnected(false)
          terminalHandler.current()
        },
        (streamError) => {
          disconnect = null
          setConnected(false)
          setError(streamError.message)
        },
      )
    }
    const handleVisibility = () => {
      if (document.hidden) {
        disconnect?.()
        disconnect = null
        setConnected(false)
      } else {
        connect()
      }
    }
    connect()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      disconnect?.()
    }
  }, [runID, runStatus])

  return useMemo(() => ({ events, connected, error }), [connected, error, events])
}
