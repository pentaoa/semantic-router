import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationFailureSummary } from '../../types/evaluationPlane'
import EvaluationReportDiagnostics from './EvaluationReportDiagnostics'

const failureSummary: EvaluationFailureSummary = {
  schema_version: 'evaluation.v1',
  total_records: 4,
  failed: 0,
  unavailable: 0,
  by_track: [
    {
      track_id: 'routing',
      succeeded: 4,
      failed: 0,
      unavailable: 0,
    },
  ],
}

describe('EvaluationReportDiagnostics', () => {
  it('isolates an invalid capacity artifact while preserving valid outcome diagnostics', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportDiagnostics, {
        failureSummary,
        capacityProfile: null,
        failureSummaryIssue: null,
        capacityProfileIssue: {
          kind: 'invalid',
          artifactName: 'capacity-profile.json',
          message:
            'capacity-profile.json did not match the required evaluation.v1 diagnostic schema.',
        },
        loading: false,
      }),
    )

    expect(markup).toContain('Outcome accounting by evaluation track')
    expect(markup).toContain('Capacity profile diagnostic error')
    expect(markup).toContain('Invalid diagnostic artifact')
    expect(markup).toContain('capacity-profile.json did not match')
    expect(markup).not.toContain('This run did not publish aggregate diagnostics')
  })

  it('distinguishes an unavailable artifact from an invalid artifact', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportDiagnostics, {
        failureSummary: null,
        capacityProfile: null,
        failureSummaryIssue: {
          kind: 'unavailable',
          artifactName: 'failure-summary.json',
          message: 'failure-summary.json could not be loaded. HTTP 404',
        },
        capacityProfileIssue: null,
        loading: false,
      }),
    )

    expect(markup).toContain('Outcome accounting diagnostic error')
    expect(markup).toContain('Diagnostic artifact unavailable')
    expect(markup).not.toContain('Invalid diagnostic artifact')
  })
})
