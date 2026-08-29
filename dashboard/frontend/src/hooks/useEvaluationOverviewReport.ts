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

  return { ...reportState, fallbackCount: fallbackIndex, retry }
}
