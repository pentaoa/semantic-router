import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
  EvaluationCapacityProfile,
  EvaluationFailureSummary,
} from '../../types/evaluationPlane'
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

const capacityProfile: EvaluationCapacityProfile = {
  schema_version: 'evaluation.v1',
  kind: 'capacity-profile',
  levels: [
    {
      concurrency: 1,
      requests: 4,
      successes: 4,
      errors: 0,
      elapsed_seconds: 1,
      throughput_rps: 4,
      latency_p50_ms: 10,
      latency_p95_ms: 12,
      latency_p99_ms: 13,
      input_tokens: 40,
      output_tokens: 20,
      runtime_cost_usd: 0.01,
    },
  ],
  slo: null,
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

  it('keeps legacy E0 diagnostics readable and integrity-only', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportDiagnostics, {
        failureSummary,
        capacityProfile,
        failureSummaryIssue: null,
        capacityProfileIssue: null,
        loading: false,
        integrityOnly: true,
        evidenceLevel: 'E0',
      }),
    )

    expect(markup).toContain('Legacy worker-derived E0 / integrity-only')
    expect(markup).toContain('Legacy report-derived capacity observations')
    expect(markup).not.toContain('Server-attested bounded concurrency')
  })

  it('uses server-attested diagnostic language only when authorized by the report', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationReportDiagnostics, {
        failureSummary,
        capacityProfile,
        failureSummaryIssue: null,
        capacityProfileIssue: null,
        loading: false,
        serverAttested: true,
        evidenceLevel: 'E0',
      }),
    )

    expect(markup).toContain('Server-attested diagnostic artifacts')
    expect(markup).toContain('Server-attested bounded concurrency observations')
    expect(markup).not.toContain('integrity-only')
  })
})
