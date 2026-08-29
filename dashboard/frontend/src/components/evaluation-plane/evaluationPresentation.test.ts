import { describe, expect, it } from 'vitest'

import { EVALUATION_TRACK_IDS } from '../../types/evaluationPlane'
import {
  clampFraction,
  evidenceRank,
  formatDelta,
  formatMetric,
  metricDeltaTone,
} from './evaluationPresentation'

describe('evaluation presentation', () => {
  it('keeps the complete eight-track taxonomy', () => {
    expect(EVALUATION_TRACK_IDS).toEqual([
      'routing',
      'model_pool',
      'joint',
      'agentic',
      'multimodal',
      'preference',
      'safety',
      'capacity',
    ])
  })

  it('formats evidence metrics and deltas without manufacturing unavailable values', () => {
    expect(formatMetric({ value: 0.912, unit: 'ratio' })).toBe('91.2%')
    expect(formatMetric({ value: null, unit: 'ms' })).toBe('—')
    expect(formatDelta({ delta: -12.5, unit: 'ms' })).toBe('−12.5 ms')
    expect(formatDelta({ delta: -28, unit: 'ms' })).toBe('−28 ms')
    expect(formatMetric({ value: 0, unit: 'usd/request' })).toBe('$0.00 / req')
    expect(formatMetric({ value: 12.25, unit: 'requests/s' })).toBe('12.25 req/s')
    expect(clampFraction(2)).toBe(1)
    expect(evidenceRank('E5')).toBeGreaterThan(evidenceRank('E2'))
  })

  it('interprets deltas using the metric direction', () => {
    expect(metricDeltaTone({ delta: -12, direction: 'lower_is_better' })).toBe('positive')
    expect(metricDeltaTone({ delta: 0.05, direction: 'higher_is_better' })).toBe('positive')
    expect(metricDeltaTone({ delta: -0.05, direction: 'higher_is_better' })).toBe('negative')
    expect(metricDeltaTone({ delta: 12, direction: 'target' })).toBe('neutral')
  })
})
