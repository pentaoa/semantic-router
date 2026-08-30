import type { EvaluationReport } from '../types/evaluationReport'
import type { EvaluationRun } from '../types/evaluationPlane'
import {
  EVALUATION_ATTESTATION_REVISION,
  EVALUATION_GATE_CONTRACT_VERSION,
  EVALUATION_SCHEMA_VERSION,
} from '../types/evaluationPlane'
import {
  assertCurrentEvaluationContract,
  EVALUATION_CHANGE_PROFILE_SET,
  EVALUATION_EVIDENCE_LEVEL_SET,
  EVALUATION_GATE_DISPOSITION_SET,
  EVALUATION_GATE_VERDICT_SET,
  EVALUATION_TRACK_ID_SET,
  hasOnlyEvaluationFields,
  isEvaluationRecord,
  isFiniteNumber,
  isKnownValue,
  isNonEmptyText,
  isNonNegativeInteger,
  isOptionalText,
  isStringRecord,
  isTextArray,
} from './evaluationContractValidation'
import { decodeEvaluationRun } from './evaluationRunContract'

const TRACK_STATUS_SET = new Set([
  'pending',
  'running',
  'sealing',
  'completed',
  'failed',
  'cancelled',
  'unavailable',
  'skipped',
])

export function isEvaluationCoverage(value: unknown): boolean {
  if (
    !isEvaluationRecord(value) ||
    !hasOnlyEvaluationFields(value, [
      'evaluated',
      'total',
      'fraction',
      'unavailable',
      'confidence_level',
      'confidence_interval',
    ]) ||
    !isNonNegativeInteger(value.evaluated) ||
    !isNonNegativeInteger(value.total) ||
    value.evaluated > value.total ||
    !isFiniteNumber(value.fraction) ||
    value.fraction < 0 ||
    value.fraction > 1 ||
    (value.unavailable !== undefined && !isNonNegativeInteger(value.unavailable)) ||
    (value.confidence_level !== undefined &&
      (!isFiniteNumber(value.confidence_level) ||
        value.confidence_level < 0 ||
        value.confidence_level > 1))
  ) {
    return false
  }
  return (
    value.confidence_interval === undefined ||
    (Array.isArray(value.confidence_interval) &&
      value.confidence_interval.length === 2 &&
      value.confidence_interval.every(isFiniteNumber))
  )
}

export function isEvaluationMetric(value: unknown): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'id',
      'name',
      'track_id',
      'value',
      'unit',
      'direction',
      'baseline_value',
      'delta',
      'confidence_interval',
      'sample_count',
    ]) &&
    isNonEmptyText(value.id) &&
    isNonEmptyText(value.name) &&
    (value.track_id === undefined || isKnownValue(value.track_id, EVALUATION_TRACK_ID_SET)) &&
    (value.value === null || isFiniteNumber(value.value)) &&
    typeof value.unit === 'string' &&
    (value.direction === undefined ||
      ['higher_is_better', 'lower_is_better', 'target'].includes(String(value.direction))) &&
    (value.baseline_value === undefined ||
      value.baseline_value === null ||
      isFiniteNumber(value.baseline_value)) &&
    (value.delta === undefined || value.delta === null || isFiniteNumber(value.delta)) &&
    (value.confidence_interval === undefined ||
      (Array.isArray(value.confidence_interval) &&
        value.confidence_interval.length === 2 &&
        value.confidence_interval.every(isFiniteNumber))) &&
    (value.sample_count === undefined || isNonNegativeInteger(value.sample_count))
  )
}

export function isEvaluationGate(value: unknown): boolean {
  if (
    !isEvaluationRecord(value) ||
    !hasOnlyEvaluationFields(value, [
      'id',
      'name',
      'description',
      'track_id',
      'disposition',
      'verdict',
      'change_profile',
      'contract_version',
      'evidence_refs',
      'evidence_level',
      'observed',
      'threshold',
      'sample_count',
      'coverage',
      'owner',
      'evaluated_at',
      'rationale',
    ]) ||
    !isNonEmptyText(value.id) ||
    !isNonEmptyText(value.name) ||
    !isKnownValue(value.disposition, EVALUATION_GATE_DISPOSITION_SET) ||
    !isKnownValue(value.verdict, EVALUATION_GATE_VERDICT_SET) ||
    !isKnownValue(value.change_profile, EVALUATION_CHANGE_PROFILE_SET) ||
    value.contract_version !== EVALUATION_GATE_CONTRACT_VERSION ||
    !isTextArray(value.evidence_refs) ||
    (value.track_id !== undefined && !isKnownValue(value.track_id, EVALUATION_TRACK_ID_SET)) ||
    (value.evidence_level !== undefined &&
      !isKnownValue(value.evidence_level, EVALUATION_EVIDENCE_LEVEL_SET)) ||
    (value.observed !== undefined && value.observed !== null && !isFiniteNumber(value.observed)) ||
    (value.sample_count !== undefined && !isNonNegativeInteger(value.sample_count)) ||
    (value.coverage !== undefined && !isEvaluationCoverage(value.coverage)) ||
    !isOptionalText(value.description) ||
    !isOptionalText(value.owner) ||
    !isOptionalText(value.evaluated_at) ||
    !isOptionalText(value.rationale)
  ) {
    return false
  }
  return (
    value.threshold === undefined ||
    (isEvaluationRecord(value.threshold) &&
      hasOnlyEvaluationFields(value.threshold, ['operator', 'value', 'unit']) &&
      isNonEmptyText(value.threshold.operator) &&
      isFiniteNumber(value.threshold.value) &&
      isOptionalText(value.threshold.unit))
  )
}

function isEvaluationArtifact(value: unknown): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'id',
      'name',
      'kind',
      'uri',
      'digest',
      'media_type',
      'size_bytes',
    ]) &&
    isNonEmptyText(value.id) &&
    isNonEmptyText(value.name) &&
    isNonEmptyText(value.kind) &&
    isOptionalText(value.uri) &&
    isOptionalText(value.digest) &&
    isOptionalText(value.media_type) &&
    (value.size_bytes === undefined || isNonNegativeInteger(value.size_bytes))
  )
}

function isEvaluationCost(value: unknown): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'amount',
      'currency',
      'input_tokens',
      'output_tokens',
      'gpu_seconds',
      'energy_kwh',
    ]) &&
    (value.amount === null || isFiniteNumber(value.amount)) &&
    isNonEmptyText(value.currency) &&
    (value.input_tokens === undefined || isNonNegativeInteger(value.input_tokens)) &&
    (value.output_tokens === undefined || isNonNegativeInteger(value.output_tokens)) &&
    (value.gpu_seconds === undefined || isFiniteNumber(value.gpu_seconds)) &&
    (value.energy_kwh === undefined || isFiniteNumber(value.energy_kwh))
  )
}

function isEvaluationReportSummary(value: unknown): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'verdict',
      'quality_score',
      'latency_p95_ms',
      'runtime_cost',
      'capacity_tco',
      'coverage',
      'passed_gates',
      'failed_gates',
      'unavailable_gates',
    ]) &&
    isKnownValue(value.verdict, EVALUATION_GATE_VERDICT_SET) &&
    (value.quality_score === null || isFiniteNumber(value.quality_score)) &&
    (value.latency_p95_ms === null || isFiniteNumber(value.latency_p95_ms)) &&
    (value.runtime_cost === null || isFiniteNumber(value.runtime_cost)) &&
    (value.capacity_tco === null || isFiniteNumber(value.capacity_tco)) &&
    isEvaluationCoverage(value.coverage) &&
    isNonNegativeInteger(value.passed_gates) &&
    isNonNegativeInteger(value.failed_gates) &&
    isNonNegativeInteger(value.unavailable_gates)
  )
}

function isEvaluationTrackReport(value: unknown): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'track_id',
      'status',
      'evidence_level',
      'summary',
      'coverage',
      'metrics',
      'gates',
      'artifacts',
      'error',
    ]) &&
    isKnownValue(value.track_id, EVALUATION_TRACK_ID_SET) &&
    isKnownValue(value.status, TRACK_STATUS_SET) &&
    isKnownValue(value.evidence_level, EVALUATION_EVIDENCE_LEVEL_SET) &&
    typeof value.summary === 'string' &&
    isEvaluationCoverage(value.coverage) &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isEvaluationMetric) &&
    Array.isArray(value.gates) &&
    value.gates.every(isEvaluationGate) &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) && value.artifacts.every(isEvaluationArtifact))) &&
    isOptionalText(value.error)
  )
}

function isEvaluationProvenance(value: unknown, run: EvaluationRun): boolean {
  return (
    isEvaluationRecord(value) &&
    hasOnlyEvaluationFields(value, [
      'schema_version',
      'generated_at',
      'code_revision',
      'benchmark_revisions',
      'workload_snapshot_digest',
      'policy_snapshot_digest',
      'binding_snapshot_digest',
      'pool_snapshot_digest',
      'environment_snapshot_digest',
      'target_id',
      'seed',
      'redaction_policy',
    ]) &&
    value.schema_version === EVALUATION_SCHEMA_VERSION &&
    isNonEmptyText(value.generated_at) &&
    isOptionalText(value.code_revision) &&
    (value.benchmark_revisions === undefined || isStringRecord(value.benchmark_revisions)) &&
    isOptionalText(value.workload_snapshot_digest) &&
    isOptionalText(value.policy_snapshot_digest) &&
    isOptionalText(value.binding_snapshot_digest) &&
    isOptionalText(value.pool_snapshot_digest) &&
    isOptionalText(value.environment_snapshot_digest) &&
    isOptionalText(value.redaction_policy) &&
    value.target_id === run.target_id &&
    value.seed === run.seed
  )
}

export function decodeEvaluationReport(payload: unknown, runID: string): EvaluationReport {
  assertCurrentEvaluationContract(payload, 'Evaluation report response')
  if (payload.attestation_revision !== EVALUATION_ATTESTATION_REVISION) {
    throw new Error('Evaluation report is not attested by the current server contract.')
  }
  const run = decodeEvaluationRun(payload.run, runID)
  if (
    !hasOnlyEvaluationFields(payload, [
      'schema_version',
      'attestation_revision',
      'run',
      'summary',
      'tracks',
      'metrics',
      'gates',
      'costs',
      'recommendations',
      'provenance',
      'artifacts',
    ]) ||
    run.status !== 'completed' ||
    !isEvaluationReportSummary(payload.summary) ||
    !Array.isArray(payload.tracks) ||
    !payload.tracks.every(isEvaluationTrackReport) ||
    !Array.isArray(payload.metrics) ||
    !payload.metrics.every(isEvaluationMetric) ||
    !Array.isArray(payload.gates) ||
    !payload.gates.every(isEvaluationGate) ||
    !isEvaluationRecord(payload.costs) ||
    !hasOnlyEvaluationFields(payload.costs, ['runtime', 'evaluation_overhead', 'capacity_tco']) ||
    !isEvaluationCost(payload.costs.runtime) ||
    !isEvaluationCost(payload.costs.evaluation_overhead) ||
    !isEvaluationCost(payload.costs.capacity_tco) ||
    !isTextArray(payload.recommendations) ||
    !isEvaluationProvenance(payload.provenance, run) ||
    !Array.isArray(payload.artifacts) ||
    !payload.artifacts.every(isEvaluationArtifact)
  ) {
    throw new Error('Evaluation report response is incomplete.')
  }
  return payload as unknown as EvaluationReport
}
