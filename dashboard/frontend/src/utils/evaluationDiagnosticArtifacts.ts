import type {
  EvaluationCapacityLevel,
  EvaluationCapacityProfile,
  EvaluationFailureSummary,
  EvaluationFailureSummaryRow,
  EvaluationTrackId,
} from '../types/evaluationPlane'
import { EVALUATION_TRACK_IDS } from '../types/evaluationPlane'

const FAILURE_SUMMARY_NAME = 'failure-summary.json'
const CAPACITY_PROFILE_NAME = 'capacity-profile.json'
const MAX_CAPACITY_LEVELS = 128
const MAX_JSON_DEPTH = 20
const MAX_JSON_COLLECTION_SIZE = 1024
const TRACK_IDS = new Set<string>(EVALUATION_TRACK_IDS)

type DiagnosticArtifactIssueKind = 'invalid' | 'unavailable'

export interface EvaluationDiagnosticArtifactIssue {
  kind: DiagnosticArtifactIssueKind
  artifactName: string
  message: string
}

export class InvalidEvaluationDiagnosticArtifactError extends Error {
  constructor(
    readonly artifactName: string,
    detail: string,
  ) {
    super(`${artifactName}: ${detail}`)
    this.name = 'InvalidEvaluationDiagnosticArtifactError'
  }
}

function invalid(artifactName: string, detail: string): never {
  throw new InvalidEvaluationDiagnosticArtifactError(artifactName, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordWithExactKeys(
  value: unknown,
  keys: readonly string[],
  artifactName: string,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(artifactName, `${path} must be an object`)
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    invalid(artifactName, `${path} has an unexpected structure`)
  }
  return value
}

function finiteNumber(value: unknown, artifactName: string, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    invalid(artifactName, `${path} must be a finite number greater than or equal to ${minimum}`)
  }
  return value
}

function boundedInteger(
  value: unknown,
  artifactName: string,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(artifactName, `${path} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function nullableFiniteNumber(value: unknown, artifactName: string, path: string): number | null {
  return value === null ? null : finiteNumber(value, artifactName, path)
}

function safeJSONValue(value: unknown, artifactName: string, path: string, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) invalid(artifactName, `${path} exceeds the nesting limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return finiteNumber(value, artifactName, path, -Number.MAX_VALUE)
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_SIZE) {
      invalid(artifactName, `${path} exceeds the collection limit`)
    }
    return value.map((item, index) =>
      safeJSONValue(item, artifactName, `${path}[${index}]`, depth + 1),
    )
  }
  if (!isRecord(value)) invalid(artifactName, `${path} must contain JSON values only`)
  const entries = Object.entries(value)
  if (entries.length > MAX_JSON_COLLECTION_SIZE) {
    invalid(artifactName, `${path} exceeds the collection limit`)
  }
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      safeJSONValue(item, artifactName, `${path}.${key}`, depth + 1),
    ]),
  )
}

function decodeFailureSummaryRow(value: unknown, index: number): EvaluationFailureSummaryRow {
  const path = `by_track[${index}]`
  const row = recordWithExactKeys(
    value,
    ['track_id', 'succeeded', 'failed', 'unavailable'],
    FAILURE_SUMMARY_NAME,
    path,
  )
  if (typeof row.track_id !== 'string' || !TRACK_IDS.has(row.track_id)) {
    invalid(FAILURE_SUMMARY_NAME, `${path}.track_id is not a supported evaluation track`)
  }
  return {
    track_id: row.track_id as EvaluationTrackId,
    succeeded: boundedInteger(row.succeeded, FAILURE_SUMMARY_NAME, `${path}.succeeded`),
    failed: boundedInteger(row.failed, FAILURE_SUMMARY_NAME, `${path}.failed`),
    unavailable: boundedInteger(row.unavailable, FAILURE_SUMMARY_NAME, `${path}.unavailable`),
  }
}

export function decodeEvaluationFailureSummary(value: unknown): EvaluationFailureSummary {
  const root = recordWithExactKeys(
    value,
    ['schema_version', 'total_records', 'failed', 'unavailable', 'by_track'],
    FAILURE_SUMMARY_NAME,
    'artifact',
  )
  if (root.schema_version !== 'evaluation.v1') {
    invalid(FAILURE_SUMMARY_NAME, 'schema_version must be evaluation.v1')
  }
  if (!Array.isArray(root.by_track) || root.by_track.length > EVALUATION_TRACK_IDS.length) {
    invalid(FAILURE_SUMMARY_NAME, 'by_track must be a bounded array')
  }
  const byTrack = root.by_track.map(decodeFailureSummaryRow)
  if (new Set(byTrack.map((row) => row.track_id)).size !== byTrack.length) {
    invalid(FAILURE_SUMMARY_NAME, 'by_track contains duplicate tracks')
  }
  const totalRecords = boundedInteger(root.total_records, FAILURE_SUMMARY_NAME, 'total_records')
  const failed = boundedInteger(root.failed, FAILURE_SUMMARY_NAME, 'failed')
  const unavailable = boundedInteger(root.unavailable, FAILURE_SUMMARY_NAME, 'unavailable')
  const totals = byTrack.reduce(
    (result, row) => ({
      records: result.records + row.succeeded + row.failed + row.unavailable,
      failed: result.failed + row.failed,
      unavailable: result.unavailable + row.unavailable,
    }),
    { records: 0, failed: 0, unavailable: 0 },
  )
  if (
    totals.records !== totalRecords ||
    totals.failed !== failed ||
    totals.unavailable !== unavailable
  ) {
    invalid(FAILURE_SUMMARY_NAME, 'aggregate counts do not match by_track')
  }
  return {
    schema_version: 'evaluation.v1',
    total_records: totalRecords,
    failed,
    unavailable,
    by_track: byTrack,
  }
}

function decodeCapacityLevel(value: unknown, index: number): EvaluationCapacityLevel {
  const path = `levels[${index}]`
  const level = recordWithExactKeys(
    value,
    [
      'concurrency',
      'requests',
      'successes',
      'errors',
      'elapsed_seconds',
      'throughput_rps',
      'latency_p50_ms',
      'latency_p95_ms',
      'latency_p99_ms',
      'input_tokens',
      'output_tokens',
      'runtime_cost_usd',
    ],
    CAPACITY_PROFILE_NAME,
    path,
  )
  const requests = boundedInteger(level.requests, CAPACITY_PROFILE_NAME, `${path}.requests`, 1)
  const successes = boundedInteger(level.successes, CAPACITY_PROFILE_NAME, `${path}.successes`)
  const errors = boundedInteger(level.errors, CAPACITY_PROFILE_NAME, `${path}.errors`)
  if (successes + errors !== requests) {
    invalid(CAPACITY_PROFILE_NAME, `${path} success and error counts must equal requests`)
  }
  const latencyP50 = nullableFiniteNumber(
    level.latency_p50_ms,
    CAPACITY_PROFILE_NAME,
    `${path}.latency_p50_ms`,
  )
  const latencyP95 = nullableFiniteNumber(
    level.latency_p95_ms,
    CAPACITY_PROFILE_NAME,
    `${path}.latency_p95_ms`,
  )
  const latencyP99 = nullableFiniteNumber(
    level.latency_p99_ms,
    CAPACITY_PROFILE_NAME,
    `${path}.latency_p99_ms`,
  )
  const latencies = [latencyP50, latencyP95, latencyP99]
  if (
    latencies.some((latency) => latency === null) &&
    latencies.some((latency) => latency !== null)
  ) {
    invalid(CAPACITY_PROFILE_NAME, `${path} latency percentiles must be all measured or all null`)
  }
  if (
    latencyP50 !== null &&
    latencyP95 !== null &&
    latencyP99 !== null &&
    (latencyP50 > latencyP95 || latencyP95 > latencyP99)
  ) {
    invalid(CAPACITY_PROFILE_NAME, `${path} latency percentiles must be monotonic`)
  }
  return {
    concurrency: boundedInteger(
      level.concurrency,
      CAPACITY_PROFILE_NAME,
      `${path}.concurrency`,
      1,
      MAX_CAPACITY_LEVELS,
    ),
    requests,
    successes,
    errors,
    elapsed_seconds: finiteNumber(
      level.elapsed_seconds,
      CAPACITY_PROFILE_NAME,
      `${path}.elapsed_seconds`,
    ),
    throughput_rps: finiteNumber(
      level.throughput_rps,
      CAPACITY_PROFILE_NAME,
      `${path}.throughput_rps`,
    ),
    latency_p50_ms: latencyP50,
    latency_p95_ms: latencyP95,
    latency_p99_ms: latencyP99,
    input_tokens: boundedInteger(level.input_tokens, CAPACITY_PROFILE_NAME, `${path}.input_tokens`),
    output_tokens: boundedInteger(
      level.output_tokens,
      CAPACITY_PROFILE_NAME,
      `${path}.output_tokens`,
    ),
    runtime_cost_usd: finiteNumber(
      level.runtime_cost_usd,
      CAPACITY_PROFILE_NAME,
      `${path}.runtime_cost_usd`,
    ),
  }
}

export function decodeEvaluationCapacityProfile(value: unknown): EvaluationCapacityProfile {
  const root = recordWithExactKeys(
    value,
    ['schema_version', 'kind', 'levels', 'slo'],
    CAPACITY_PROFILE_NAME,
    'artifact',
  )
  if (root.schema_version !== 'evaluation.v1') {
    invalid(CAPACITY_PROFILE_NAME, 'schema_version must be evaluation.v1')
  }
  if (root.kind !== 'bounded-concurrency-sweep') {
    invalid(CAPACITY_PROFILE_NAME, 'kind must be bounded-concurrency-sweep')
  }
  if (!Array.isArray(root.levels) || root.levels.length > MAX_CAPACITY_LEVELS) {
    invalid(CAPACITY_PROFILE_NAME, 'levels must be a bounded array')
  }
  const levels = root.levels.map(decodeCapacityLevel)
  if (
    levels.some((level, index) => index > 0 && level.concurrency <= levels[index - 1].concurrency)
  ) {
    invalid(CAPACITY_PROFILE_NAME, 'levels must use unique, ascending concurrency values')
  }
  if (root.slo !== null && !isRecord(root.slo)) {
    invalid(CAPACITY_PROFILE_NAME, 'slo must be an object or null')
  }
  const slo =
    root.slo === null
      ? null
      : (safeJSONValue(root.slo, CAPACITY_PROFILE_NAME, 'slo') as Record<string, unknown>)
  return {
    schema_version: 'evaluation.v1',
    kind: 'bounded-concurrency-sweep',
    levels,
    slo,
  }
}

export function evaluationDiagnosticArtifactIssue(
  artifactName: string,
  reason: unknown,
): EvaluationDiagnosticArtifactIssue {
  if (reason instanceof InvalidEvaluationDiagnosticArtifactError || reason instanceof SyntaxError) {
    return {
      kind: 'invalid',
      artifactName,
      message: `${artifactName} did not match the required evaluation.v1 diagnostic schema.`,
    }
  }
  return {
    kind: 'unavailable',
    artifactName,
    message: `${artifactName} could not be loaded. ${reason instanceof Error ? reason.message : 'The artifact request failed.'}`,
  }
}
