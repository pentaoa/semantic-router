import { useEffect, useState } from 'react'

import type {
  EvaluationCapacityProfile,
  EvaluationFailureSummary,
  EvaluationReport,
} from '../types/evaluationPlane'
import { getEvaluationArtifactJSON } from '../utils/evaluationPlaneApi'

interface EvaluationReportDiagnosticsState {
  failureSummary: EvaluationFailureSummary | null
  capacityProfile: EvaluationCapacityProfile | null
  loading: boolean
  errors: string[]
}

function artifactID(report: EvaluationReport, name: string): string | null {
  return (
    report.artifacts.find((artifact) => artifact.name.toLowerCase() === name.toLowerCase())?.id ||
    null
  )
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback
}

export default function useEvaluationReportDiagnostics(
  report: EvaluationReport,
): EvaluationReportDiagnosticsState {
  const [state, setState] = useState<EvaluationReportDiagnosticsState>({
    failureSummary: null,
    capacityProfile: null,
    loading: false,
    errors: [],
  })

  useEffect(() => {
    const failureID = artifactID(report, 'failure-summary.json')
    const capacityID = artifactID(report, 'capacity-profile.json')
    if (!failureID && !capacityID) {
      setState({ failureSummary: null, capacityProfile: null, loading: false, errors: [] })
      return
    }

    const controller = new AbortController()
    setState({ failureSummary: null, capacityProfile: null, loading: true, errors: [] })
    const failure = failureID
      ? getEvaluationArtifactJSON<EvaluationFailureSummary>(
          report.run.id,
          failureID,
          controller.signal,
        )
      : Promise.resolve(null)
    const capacity = capacityID
      ? getEvaluationArtifactJSON<EvaluationCapacityProfile>(
          report.run.id,
          capacityID,
          controller.signal,
        )
      : Promise.resolve(null)

    void Promise.allSettled([failure, capacity]).then(([failureResult, capacityResult]) => {
      if (controller.signal.aborted) return
      const errors: string[] = []
      if (failureResult.status === 'rejected') {
        errors.push(
          `Outcome accounting: ${errorMessage(failureResult.reason, 'artifact could not be loaded.')}`,
        )
      }
      if (capacityResult.status === 'rejected') {
        errors.push(
          `Capacity profile: ${errorMessage(capacityResult.reason, 'artifact could not be loaded.')}`,
        )
      }
      setState({
        failureSummary: failureResult.status === 'fulfilled' ? failureResult.value : null,
        capacityProfile: capacityResult.status === 'fulfilled' ? capacityResult.value : null,
        loading: false,
        errors,
      })
    })

    return () => controller.abort()
  }, [report])

  return state
}
