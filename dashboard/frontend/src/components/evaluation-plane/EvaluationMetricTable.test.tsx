import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationMetric } from '../../types/evaluationReport'
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

describe('EvaluationMetricTable evidence labels', () => {
  it('distinguishes independently reduced metrics from diagnostic aggregates', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E0',
      }),
    )

    expect(markup).toContain('Server-reduced E0')
    expect(markup).toContain('Worker-derived E0 / diagnostic only')
  })

  it('retains the same evidence boundary at higher qualification levels', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationMetricTable, {
        metrics,
        controls: false,
        evidenceLevel: 'E5',
      }),
    )

    expect(markup).toContain('Server-reduced E5')
    expect(markup).toContain('Worker-derived E5 / diagnostic only')
  })
})
