import type {
  EvaluationComparison,
  EvaluationComparisonStatistic,
  EvaluationGate,
} from '../types/evaluationReport'
import { EVALUATION_ATTESTATION_REVISION } from '../types/evaluationPlane'
import {
  assertCurrentEvaluationContract,
  EVALUATION_GATE_VERDICT_SET,
  EVALUATION_TRACK_ID_SET,
  hasOnlyEvaluationFields,
  isEvaluationRecord,
  isFiniteNumber,
  isKnownValue,
  isNonEmptyText,
  isNonNegativeInteger,
  isTextArray,
} from './evaluationContractValidation'
import { isEvaluationGate, isEvaluationMetric } from './evaluationReportContract'

const CONFIDENCE_LEVEL = 0.95
const MINIMUM_ANALYSIS_UNITS = 20
const G3_ABSOLUTE_BOUND = 0.25
const G3_REDUCTION = 'server-reduction:comparative-g3.v1'
const GATE_IDS = Array.from({ length: 10 }, (_, index) => `G${index}`)
const STATISTIC_CONTRACTS: Record<
  string,
  Pick<
    EvaluationComparisonStatistic,
    'track_id' | 'analysis_unit' | 'direction' | 'non_inferiority_margin'
  >
> = {
  'routing.accuracy': {
    track_id: 'routing',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.02,
  },
  'model_pool.oracle_quality': {
    track_id: 'model_pool',
    analysis_unit: 'case_max',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.02,
  },
  'joint.realized_quality': {
    track_id: 'joint',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.02,
  },
  'joint.reliability': {
    track_id: 'joint',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.01,
  },
  'joint.oracle_regret': {
    track_id: 'joint',
    analysis_unit: 'case_oracle_regret',
    direction: 'lower_is_better',
    non_inferiority_margin: 0.02,
  },
  'joint.normalized_regret': {
    track_id: 'joint',
    analysis_unit: 'case_normalized_regret',
    direction: 'lower_is_better',
    non_inferiority_margin: 0.05,
  },
  'agentic.task_score': {
    track_id: 'agentic',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.05,
  },
  'agentic.success_rate': {
    track_id: 'agentic',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.02,
  },
  'multimodal.quality': {
    track_id: 'multimodal',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.05,
  },
  'preference.agreement': {
    track_id: 'preference',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.02,
  },
  'safety.violation_case_rate': {
    track_id: 'safety',
    analysis_unit: 'case_mean',
    direction: 'lower_is_better',
    non_inferiority_margin: 0,
  },
  'capacity.success_rate': {
    track_id: 'capacity',
    analysis_unit: 'case_mean',
    direction: 'higher_is_better',
    non_inferiority_margin: 0.01,
  },
}

function approximatelyEqual(left: number, right: number): boolean {
  if (left === right) return true
  return Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right))
}

function statisticVerdict(
  statistic: EvaluationComparisonStatistic,
): 'pass' | 'fail' | 'unavailable' {
  if (
    statistic.sample_count < MINIMUM_ANALYSIS_UNITS ||
    statistic.delta_confidence_interval.length !== 2 ||
    statistic.candidate_confidence_interval.length !== 2
  ) {
    return 'unavailable'
  }
  const [lower, upper] = statistic.delta_confidence_interval
  if (statistic.direction === 'higher_is_better') {
    if (lower >= -statistic.non_inferiority_margin) return 'pass'
    if (upper < -statistic.non_inferiority_margin) return 'fail'
    return 'unavailable'
  }
  if (upper <= statistic.non_inferiority_margin) return 'pass'
  if (lower > statistic.non_inferiority_margin) return 'fail'
  return 'unavailable'
}

function decodeStatistic(value: unknown): EvaluationComparisonStatistic {
  if (
    !isEvaluationRecord(value) ||
    !hasOnlyEvaluationFields(value, [
      'id',
      'track_id',
      'analysis_unit',
      'direction',
      'non_inferiority_margin',
      'baseline_value',
      'candidate_value',
      'delta',
      'confidence_level',
      'delta_confidence_interval',
      'candidate_confidence_interval',
      'sample_count',
      'verdict',
    ]) ||
    !isNonEmptyText(value.id) ||
    !isKnownValue(value.track_id, EVALUATION_TRACK_ID_SET) ||
    !['case_mean', 'case_max', 'case_oracle_regret', 'case_normalized_regret'].includes(
      String(value.analysis_unit),
    ) ||
    !['higher_is_better', 'lower_is_better'].includes(String(value.direction)) ||
    !isFiniteNumber(value.non_inferiority_margin) ||
    value.non_inferiority_margin < 0 ||
    !isFiniteNumber(value.baseline_value) ||
    !isFiniteNumber(value.candidate_value) ||
    !isFiniteNumber(value.delta) ||
    !approximatelyEqual(value.candidate_value - value.baseline_value, value.delta) ||
    value.confidence_level !== CONFIDENCE_LEVEL ||
    !isNonNegativeInteger(value.sample_count) ||
    !Array.isArray(value.delta_confidence_interval) ||
    !value.delta_confidence_interval.every(isFiniteNumber) ||
    !Array.isArray(value.candidate_confidence_interval) ||
    !value.candidate_confidence_interval.every(isFiniteNumber) ||
    !['pass', 'fail', 'unavailable'].includes(String(value.verdict))
  ) {
    throw new Error('Evaluation comparison statistic is invalid.')
  }
  const statistic = value as unknown as EvaluationComparisonStatistic
  const contract = STATISTIC_CONTRACTS[statistic.id]
  if (
    !contract ||
    statistic.track_id !== contract.track_id ||
    statistic.analysis_unit !== contract.analysis_unit ||
    statistic.direction !== contract.direction ||
    statistic.non_inferiority_margin !== contract.non_inferiority_margin
  ) {
    throw new Error(`Evaluation comparison statistic ${statistic.id} is not registered.`)
  }
  const conclusive = statistic.sample_count >= MINIMUM_ANALYSIS_UNITS
  for (const interval of [
    statistic.delta_confidence_interval,
    statistic.candidate_confidence_interval,
  ]) {
    if (
      (conclusive && interval.length !== 2) ||
      (!conclusive && interval.length !== 0) ||
      (interval.length === 2 && interval[0] > interval[1])
    ) {
      throw new Error(`Evaluation comparison statistic ${statistic.id} has an invalid interval.`)
    }
  }
  if (statistic.verdict !== statisticVerdict(statistic)) {
    throw new Error(`Evaluation comparison statistic ${statistic.id} has an invalid verdict.`)
  }
  return statistic
}

function validateG3(
  gates: EvaluationGate[],
  statistics: EvaluationComparisonStatistic[],
  baselineRunID: string,
  candidateRunID: string,
): void {
  if (
    gates.length !== GATE_IDS.length ||
    gates.some((gate, index) => gate.id !== GATE_IDS[index])
  ) {
    throw new Error('Evaluation comparison gate vector is incomplete.')
  }
  const gate = gates[3]
  const expectedRefs = [
    G3_REDUCTION,
    `run:baseline:${baselineRunID}`,
    `run:candidate:${candidateRunID}`,
    'comparison-statistic:joint.normalized_regret',
  ]
  if (
    gate.evidence_refs.length !== expectedRefs.length ||
    gate.evidence_refs.some((reference, index) => reference !== expectedRefs[index]) ||
    gate.evidence_level !== 'E4' ||
    gate.owner !== 'recipe-and-model-pool'
  ) {
    throw new Error('Evaluation comparison G3 is not server-owned.')
  }
  if (gate.disposition === 'not_applicable') {
    if (
      gate.verdict !== 'not_applicable' ||
      gate.observed !== undefined ||
      gate.threshold !== undefined
    ) {
      throw new Error('Evaluation comparison G3 not-applicable result is invalid.')
    }
    return
  }
  const statistic = statistics.find((item) => item.id === 'joint.normalized_regret')
  if (!statistic || statistic.sample_count < MINIMUM_ANALYSIS_UNITS) {
    if (
      gate.verdict !== 'unavailable' ||
      gate.observed !== undefined ||
      gate.threshold !== undefined
    ) {
      throw new Error('Evaluation comparison G3 overclaims incomplete paired evidence.')
    }
    return
  }
  const [absoluteLower, absoluteUpper] = statistic.candidate_confidence_interval
  const expectedVerdict =
    absoluteUpper <= G3_ABSOLUTE_BOUND && statistic.verdict === 'pass'
      ? 'pass'
      : absoluteLower > G3_ABSOLUTE_BOUND || statistic.verdict === 'fail'
        ? 'fail'
        : 'unavailable'
  if (
    gate.verdict !== expectedVerdict ||
    gate.observed !== absoluteUpper ||
    gate.threshold?.operator !== '<=' ||
    gate.threshold.value !== G3_ABSOLUTE_BOUND ||
    gate.threshold.unit !== 'fraction' ||
    gate.sample_count !== statistic.sample_count
  ) {
    throw new Error('Evaluation comparison G3 contradicts its server reduction.')
  }
}

export function decodeEvaluationComparison(
  payload: unknown,
  baselineRunID: string,
  candidateRunID: string,
): EvaluationComparison {
  assertCurrentEvaluationContract(payload, 'Evaluation comparison response')
  if (payload.attestation_revision !== EVALUATION_ATTESTATION_REVISION) {
    throw new Error('Evaluation comparison is not attested by the current server contract.')
  }
  if (
    !hasOnlyEvaluationFields(payload, [
      'schema_version',
      'attestation_revision',
      'baseline_run_id',
      'candidate_run_id',
      'verdict',
      'summary',
      'metrics',
      'statistics',
      'gates',
      'recommendations',
      'created_at',
    ]) ||
    payload.baseline_run_id !== baselineRunID ||
    payload.candidate_run_id !== candidateRunID ||
    !Array.isArray(payload.metrics) ||
    !payload.metrics.every(isEvaluationMetric) ||
    !Array.isArray(payload.statistics) ||
    !Array.isArray(payload.gates) ||
    !payload.gates.every(isEvaluationGate) ||
    !isKnownValue(payload.verdict, EVALUATION_GATE_VERDICT_SET) ||
    typeof payload.summary !== 'string' ||
    !isTextArray(payload.recommendations) ||
    !isNonEmptyText(payload.created_at)
  ) {
    throw new Error('Evaluation comparison response did not match the requested pair.')
  }
  const statistics = payload.statistics.map(decodeStatistic)
  if (new Set(statistics.map((statistic) => statistic.id)).size !== statistics.length) {
    throw new Error('Evaluation comparison statistic identities are not unique.')
  }
  const gates = payload.gates as EvaluationGate[]
  validateG3(gates, statistics, baselineRunID, candidateRunID)
  return { ...(payload as unknown as EvaluationComparison), statistics, gates }
}
