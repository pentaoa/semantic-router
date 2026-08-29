import { describe, expect, it } from 'vitest'

import type { EvaluationReport } from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS } from '../../types/evaluationPlane'
import {
  clampFraction,
  EVALUATION_SERVER_ATTESTATION_REVISION,
  evidenceRank,
  formatDelta,
  formatMetric,
  hasServerEvaluationAttestation,
  legacyEvaluationEvidenceLabel,
  metricDeltaTone,
  selectHeadlineMetrics,
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

  it('elevates only server-reduced diagnostics for E0 reports', () => {
    const report = {
      attestation_revision: EVALUATION_SERVER_ATTESTATION_REVISION,
      run: { evidence_level: 'E0', track_ids: ['routing', 'safety', 'capacity'] },
      metrics: [
        {
          id: 'routing.accuracy',
          name: 'Routing accuracy',
          track_id: 'routing',
          value: 1,
          unit: 'fraction',
        },
        {
          id: 'safety.violation_rate',
          name: 'Safety violation rate',
          track_id: 'safety',
          value: 0,
          unit: 'violations/case',
        },
        {
          id: 'capacity.success_rate',
          name: 'Capacity success rate',
          track_id: 'capacity',
          value: 1,
          unit: 'fraction',
        },
      ],
    } as EvaluationReport

    expect(selectHeadlineMetrics(report).map((metric) => metric.id)).toEqual([
      'safety.violation_rate',
      'capacity.success_rate',
    ])
  })

  it('fails closed for missing and unknown E0 attestation revisions', () => {
    const report = {
      run: { evidence_level: 'E0', track_ids: ['joint', 'safety'] },
      metrics: [
        {
          id: 'joint.normalized_regret',
          name: 'Normalized regret',
          track_id: 'joint',
          value: 0.1,
          unit: 'fraction',
        },
        {
          id: 'safety.block_accuracy',
          name: 'Safety block accuracy',
          track_id: 'safety',
          value: 1,
          unit: 'fraction',
        },
      ],
    } as EvaluationReport

    expect(hasServerEvaluationAttestation(report)).toBe(false)
    expect(selectHeadlineMetrics(report)).toEqual([])

    const unknownRevision = { ...report, attestation_revision: 'evaluation-server-attestation.v3' }
    expect(hasServerEvaluationAttestation(unknownRevision)).toBe(false)
    expect(selectHeadlineMetrics(unknownRevision)).toEqual([])
  })

  it.each(['E1', 'E5'] as const)(
    'withholds %s headlines when the current server attestation is missing',
    (evidenceLevel) => {
      const report = {
        run: { evidence_level: evidenceLevel, track_ids: ['routing', 'safety'] },
        metrics: [
          {
            id: 'routing.accuracy',
            name: 'Routing accuracy',
            track_id: 'routing',
            value: 0.9,
            unit: 'fraction',
          },
          {
            id: 'safety.violation_rate',
            name: 'Safety violation rate',
            track_id: 'safety',
            value: 0,
            unit: 'violations/case',
          },
        ],
      } as EvaluationReport

      expect(selectHeadlineMetrics(report)).toEqual([])
      expect(
        selectHeadlineMetrics({
          ...report,
          attestation_revision: EVALUATION_SERVER_ATTESTATION_REVISION,
        }).map((metric) => metric.id),
      ).toEqual(['safety.violation_rate'])
    },
  )

  it('accepts only the exact v2 server attestation revision', () => {
    expect(
      hasServerEvaluationAttestation({
        attestation_revision: EVALUATION_SERVER_ATTESTATION_REVISION,
      }),
    ).toBe(true)
    expect(hasServerEvaluationAttestation({ attestation_revision: undefined })).toBe(false)
    expect(hasServerEvaluationAttestation({ attestation_revision: '' })).toBe(false)
    expect(legacyEvaluationEvidenceLabel('E0')).toBe('Legacy worker-derived E0 / integrity-only')
    expect(legacyEvaluationEvidenceLabel('E5')).toBe('Legacy unattested E5 / integrity-only')
  })
})
