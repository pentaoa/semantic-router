import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import EvaluationExperimentCapacitySLO from './EvaluationExperimentCapacitySLO'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import { defaultEvaluationCapacityLoadProtocol } from '../../utils/evaluationCapacitySLOContract'

function capacityForm(active: boolean): EvaluationExperimentFormModel {
  return {
    capacitySLOActive: active,
    capacityLoadProtocol: active ? defaultEvaluationCapacityLoadProtocol(8) : undefined,
    capacitySLOInput: {
      requiredConcurrency: '',
      maxLatencyP95MS: '',
      maxErrorRate: '',
      minThroughputRPS: '',
      minThroughputScalingEfficiency: '',
    },
    concurrency: 8,
    baselineLocked: false,
    setCapacitySLOField: vi.fn(),
    applyCapacitySLOPreset: vi.fn(),
  } as unknown as EvaluationExperimentFormModel
}

describe('EvaluationExperimentCapacitySLO', () => {
  it('is absent outside live Capacity and never inserts a silent passing default', () => {
    expect(
      renderToStaticMarkup(
        createElement(EvaluationExperimentCapacitySLO, { form: capacityForm(false) }),
      ),
    ).toBe('')

    const markup = renderToStaticMarkup(
      createElement(EvaluationExperimentCapacitySLO, { form: capacityForm(true) }),
    )
    expect(markup).toContain('Capacity service objective')
    expect(markup).toContain('Required for live capacity')
    expect(markup).toContain('No inferred pass criteria')
    expect(markup).toContain('Frozen capacity load protocol')
    expect(markup).toContain('c1 → c2 → c4 → c8')
    expect(markup).toContain('100 requests × 3 repetitions')
    expect(markup).toContain('95% · throughput and p95 CV ≤ 20%')
    expect(markup).toContain('Optional starting points')
    expect(markup).toContain('Latency guardrail')
    expect(markup).toContain('Balanced service')
    expect(markup).toContain('Throughput guardrail')
    expect(markup.match(/required=""/g)).toHaveLength(5)
    expect(markup).not.toContain('value="750"')
    expect(markup).not.toContain('value="0.01"')
  })
})
