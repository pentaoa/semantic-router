import { describe, expect, it } from 'vitest'

import {
  decodeEvaluationCapacityProfile,
  decodeEvaluationFailureSummary,
  evaluationDiagnosticArtifactIssue,
  InvalidEvaluationDiagnosticArtifactError,
} from './evaluationDiagnosticArtifacts'

const validFailureSummary = {
  schema_version: 'evaluation.v1',
  total_records: 4,
  failed: 1,
  unavailable: 1,
  by_track: [
    {
      track_id: 'routing',
      succeeded: 2,
      failed: 1,
      unavailable: 1,
    },
  ],
}

const validCapacityLevel = {
  concurrency: 1,
  requests: 4,
  successes: 3,
  errors: 1,
  elapsed_seconds: 1.5,
  throughput_rps: 2.67,
  latency_p50_ms: 100,
  latency_p95_ms: 160,
  latency_p99_ms: 180,
  input_tokens: 120,
  output_tokens: 60,
  runtime_cost_usd: 0.004,
}

const validCapacityProfile = {
  schema_version: 'evaluation.v1',
  kind: 'bounded-concurrency-sweep',
  levels: [validCapacityLevel],
  slo: null,
}

describe('evaluation diagnostic artifact decoding', () => {
  it('returns rebuilt values for exact failure-summary and capacity-profile schemas', () => {
    expect(decodeEvaluationFailureSummary(validFailureSummary)).toEqual(validFailureSummary)
    expect(
      decodeEvaluationCapacityProfile({
        ...validCapacityProfile,
        slo: { latency_p95_ms: 250, labels: ['interactive'] },
      }),
    ).toEqual({
      ...validCapacityProfile,
      slo: { latency_p95_ms: 250, labels: ['interactive'] },
    })
  })

  it.each([
    ['null root', null],
    ['unknown root field', { ...validFailureSummary, unexpected: true }],
    ['non-finite aggregate', { ...validFailureSummary, total_records: Number.POSITIVE_INFINITY }],
    ['null track collection', { ...validFailureSummary, by_track: null }],
    [
      'unknown track',
      {
        ...validFailureSummary,
        by_track: [{ ...validFailureSummary.by_track[0], track_id: 'unknown' }],
      },
    ],
    [
      'duplicate track',
      {
        ...validFailureSummary,
        total_records: 8,
        failed: 2,
        unavailable: 2,
        by_track: [validFailureSummary.by_track[0], validFailureSummary.by_track[0]],
      },
    ],
    ['inconsistent aggregate', { ...validFailureSummary, failed: 0 }],
    [
      'negative row count',
      {
        ...validFailureSummary,
        by_track: [{ ...validFailureSummary.by_track[0], failed: -1 }],
      },
    ],
  ])('rejects an invalid failure summary: %s', (_name, value) => {
    expect(() => decodeEvaluationFailureSummary(value)).toThrow(
      InvalidEvaluationDiagnosticArtifactError,
    )
  })

  it.each([
    ['null root', null],
    ['unknown root field', { ...validCapacityProfile, unexpected: true }],
    ['null levels', { ...validCapacityProfile, levels: null }],
    [
      'non-finite measurement',
      {
        ...validCapacityProfile,
        levels: [{ ...validCapacityLevel, throughput_rps: Number.POSITIVE_INFINITY }],
      },
    ],
    [
      'unknown level field',
      {
        ...validCapacityProfile,
        levels: [{ ...validCapacityLevel, unexpected: true }],
      },
    ],
    [
      'inconsistent request counts',
      {
        ...validCapacityProfile,
        levels: [{ ...validCapacityLevel, successes: 4 }],
      },
    ],
    [
      'partial latency percentiles',
      {
        ...validCapacityProfile,
        levels: [{ ...validCapacityLevel, latency_p95_ms: null }],
      },
    ],
    [
      'reversed latency percentiles',
      {
        ...validCapacityProfile,
        levels: [{ ...validCapacityLevel, latency_p50_ms: 200 }],
      },
    ],
    [
      'duplicate concurrency',
      {
        ...validCapacityProfile,
        levels: [validCapacityLevel, validCapacityLevel],
      },
    ],
    ['invalid SLO shape', { ...validCapacityProfile, slo: [] }],
    ['non-finite SLO value', { ...validCapacityProfile, slo: { latency: Number.NaN } }],
  ])('rejects an invalid capacity profile: %s', (_name, value) => {
    expect(() => decodeEvaluationCapacityProfile(value)).toThrow(
      InvalidEvaluationDiagnosticArtifactError,
    )
  })

  it('classifies malformed JSON and schema failures as invalid without hiding load errors', () => {
    expect(evaluationDiagnosticArtifactIssue('capacity-profile.json', new SyntaxError())).toEqual({
      kind: 'invalid',
      artifactName: 'capacity-profile.json',
      message: 'capacity-profile.json did not match the required evaluation.v1 diagnostic schema.',
    })
    expect(
      evaluationDiagnosticArtifactIssue(
        'failure-summary.json',
        new InvalidEvaluationDiagnosticArtifactError('failure-summary.json', 'bad shape'),
      ).kind,
    ).toBe('invalid')
    expect(
      evaluationDiagnosticArtifactIssue('failure-summary.json', new Error('HTTP 404')),
    ).toEqual({
      kind: 'unavailable',
      artifactName: 'failure-summary.json',
      message: 'failure-summary.json could not be loaded. HTTP 404',
    })
  })
})
