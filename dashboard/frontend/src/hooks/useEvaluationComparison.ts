import { useCallback, useEffect, useRef, useState } from 'react'

import type { EvaluationComparison } from '../types/evaluationPlane'
import { compareEvaluationRuns } from '../utils/evaluationPlaneApi'

function comparisonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to compare evaluation runs.'
}

export function useEvaluationComparison(
  baselineID: string,
  candidateID: string,
  runLedgerComplete = true,
) {
  const [comparison, setComparison] = useState<EvaluationComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestPair, setRequestPair] = useState('')
  const [errorPair, setErrorPair] = useState('')
  const requestVersion = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const pair = `${baselineID}\u0000${candidateID}`

  const compare = useCallback(async () => {
    if (!runLedgerComplete || !baselineID || !candidateID || baselineID === candidateID) return
    const version = ++requestVersion.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setRequestPair(pair)
    setLoading(true)
    setComparison(null)
    setError(null)
    setErrorPair('')
    try {
      const nextComparison = await compareEvaluationRuns(
        baselineID,
        candidateID,
        nextController.signal,
      )
      if (nextController.signal.aborted || version !== requestVersion.current) return
      if (
        nextComparison.baseline_run_id !== baselineID ||
        nextComparison.candidate_run_id !== candidateID
      ) {
        throw new Error('Evaluation comparison response did not match the requested pair.')
      }
      setComparison(nextComparison)
      setError(null)
      setErrorPair('')
    } catch (comparisonError) {
      if (nextController.signal.aborted || version !== requestVersion.current) return
      setError(comparisonErrorMessage(comparisonError))
      setErrorPair(pair)
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [baselineID, candidateID, pair, runLedgerComplete])

  useEffect(() => {
    requestVersion.current += 1
    controller.current?.abort()
    setComparison(null)
    setError(null)
    setErrorPair('')
    setLoading(false)
  }, [baselineID, candidateID, runLedgerComplete])

  useEffect(
    () => () => {
      requestVersion.current += 1
      controller.current?.abort()
    },
    [],
  )

  const visibleComparison =
    comparison?.baseline_run_id === baselineID && comparison.candidate_run_id === candidateID
      ? comparison
      : null

  return {
    comparison: visibleComparison,
    loading: loading && requestPair === pair,
    error: errorPair === pair ? error : null,
    compare,
  }
}
