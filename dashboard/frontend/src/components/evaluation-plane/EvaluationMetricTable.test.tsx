import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationMetric } from '../../types/evaluationPlane'
import EvaluationMetricTable from './EvaluationMetricTable'

const metrics = [
  {
    id: 'safety.violation_rate',
    name: 'Safety violation rate',
    track_id: 'safety',
    value: 0,
    unit: 'violations/case',
  },
  {
    id: 'routing.accuracy',
    name: 'Routing accuracy',
    track_id: 'routing',
    value: 0.8,
    unit: 'fraction',
  },
] satisfies EvaluationMetric[]

describe('EvaluationMetricTable attestation labels', () => {
  it('keeps every legacy E0 metric visible without calling any row server-reduced', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E0',
        serverAttested: false,
      }),
    )

    expect(markup).toContain('Safety violation rate')
    expect(markup).toContain('Routing accuracy')
    expect(markup).toContain('Legacy worker-derived E0 / integrity-only')
    expect(markup).not.toContain('Server-reduced')
  })

  it('distinguishes the bounded server-reduced E0 set after exact attestation', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E0',
        serverAttested: true,
      }),
    )

    expect(markup).toContain('Server-reduced E0')
    expect(markup).toContain('Worker-derived E0 / diagnostic only')
  })

  it('marks an unattested higher-level report integrity-only', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E5',
        serverAttested: false,
      }),
    )

    expect(markup).toContain('Legacy unattested E5 / integrity-only')
    expect(markup).not.toContain('Server-reduced')
  })

  it('keeps non-reduced E5 metrics diagnostic under the exact v2 contract', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E5',
        serverAttested: true,
      }),
    )

    expect(markup).toContain('Server-reduced E5')
    expect(markup).toContain('Worker-derived E5 / diagnostic only')
  })
})
