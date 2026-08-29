import { useCallback, useEffect, useState } from 'react'

import type { EvaluationRun } from '../types/evaluationPlane'
import { useEvaluationReport } from './useEvaluationReport'

const FALLBACK_LIMIT = 3
const FALLBACK_STATUSES = new Set([404, 409, 500])

export function useEvaluationOverviewReport(completedRuns: EvaluationRun[], enabled: boolean) {
  const [fallbackIndex, setFallbackIndex] = useState(0)
  const completedRunKey = completedRuns.map((run) => run.id).join('|')
  const runID = completedRuns[fallbackIndex]?.id || null
  const reportState = useEvaluationReport(enabled ? runID : null)
  const refresh = reportState.refresh

  useEffect(() => setFallbackIndex(0), [completedRunKey])

  useEffect(() => {
    if (
      enabled &&
      runID &&
      reportState.errorRunID === runID &&
      reportState.errorStatus !== null &&
      FALLBACK_STATUSES.has(reportState.errorStatus) &&
      fallbackIndex < FALLBACK_LIMIT &&
      fallbackIndex + 1 < completedRuns.length
    ) {
      setFallbackIndex((current) => current + 1)
    }
  }, [
    completedRuns.length,
    enabled,
    fallbackIndex,
    reportState.errorRunID,
    reportState.errorStatus,
    runID,
  ])

  const retry = useCallback(() => {
    if (fallbackIndex > 0) setFallbackIndex(0)
    else void refresh()
  }, [fallbackIndex, refresh])

  const requestedRunID = enabled ? runID : null
  const requestedReportLoaded = reportState.report?.run.id === requestedRunID
  const requestedReportFailed = reportState.errorRunID === requestedRunID
  const switchingRequests = Boolean(
    requestedRunID && !requestedReportLoaded && !requestedReportFailed,
  )

  return {
    ...reportState,
    loading: enabled && (reportState.loading || switchingRequests),
    error: requestedReportFailed ? reportState.error : null,
    errorRunID: requestedReportFailed ? reportState.errorRunID : null,
    errorStatus: requestedReportFailed ? reportState.errorStatus : null,
    requestedRunID,
    fallbackCount: fallbackIndex,
    retry,
  }
}
