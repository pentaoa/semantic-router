import type {
  EvaluationCapacityFailureReason,
  EvaluationCapacityLevel,
  EvaluationCapacityProfile,
  EvaluationCapacityRepetition,
  EvaluationCapacitySLOAssessment,
} from '../types/evaluationReport'
import type {
  EvaluationCapacityLoadProtocol,
  EvaluationCapacitySLO,
} from '../types/evaluationPlane'
import {
  decodeEvaluationCapacityLoadProtocol,
  decodeEvaluationCapacitySLO,
  equalEvaluationCapacityLoadProtocol,
  equalEvaluationCapacitySLO,
} from './evaluationCapacitySLOContract'
import {
  approximatelyEqual,
  booleanValue,
  boundedInteger,
  invalid,
  nonNegativeFiniteNumber,
  positiveFiniteNumber,
  recordWithExactKeys,
} from './evaluationDiagnosticArtifactValidation'

const ARTIFACT_NAME = 'capacity-profile.json'
const FAILURE_REASONS: EvaluationCapacityFailureReason[] = [
  'required_concurrency',
  'warmup_errors',
  'latency_p95',
  'error_rate_upper_bound',
  'throughput',
  'throughput_scaling',
  'throughput_stability',
  'latency_stability',
]

function arithmeticMean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleCV(values: number[]): number {
  const mean = arithmeticMean(values)
  if (mean === 0) return 0
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(Math.max(variance, 0)) / mean
}

function oneSidedWilsonUpper(events: number, total: number): number {
  const z = 1.6448536269514722
  const estimate = events / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const center = estimate + z2 / (2 * total)
  const margin = z * Math.sqrt((estimate * (1 - estimate)) / total + z2 / (4 * total ** 2))
  return Math.min(1, (center + margin) / denominator)
}

function decodeRepetition(value: unknown, path: string): EvaluationCapacityRepetition {
  const row = recordWithExactKeys(
    value,
    [
      'concurrency',
      'repetition',
      'requests',
      'successes',
      'errors',
      'elapsed_seconds',
      'throughput_rps',
      'latency_p95_ms',
    ],
    ARTIFACT_NAME,
    path,
  )
  const requests = boundedInteger(row.requests, ARTIFACT_NAME, `${path}.requests`, 1)
  const successes = boundedInteger(row.successes, ARTIFACT_NAME, `${path}.successes`)
  const errors = boundedInteger(row.errors, ARTIFACT_NAME, `${path}.errors`)
  const elapsed = positiveFiniteNumber(
    row.elapsed_seconds,
    ARTIFACT_NAME,
    `${path}.elapsed_seconds`,
  )
  const throughput = positiveFiniteNumber(
    row.throughput_rps,
    ARTIFACT_NAME,
    `${path}.throughput_rps`,
  )
  if (successes + errors !== requests || !approximatelyEqual(throughput, requests / elapsed)) {
    invalid(ARTIFACT_NAME, `${path} counts or throughput do not match its request window`)
  }
  return {
    concurrency: boundedInteger(row.concurrency, ARTIFACT_NAME, `${path}.concurrency`, 1, 128),
    repetition: boundedInteger(row.repetition, ARTIFACT_NAME, `${path}.repetition`, 1, 5),
    requests,
    successes,
    errors,
    elapsed_seconds: elapsed,
    throughput_rps: throughput,
    latency_p95_ms: nonNegativeFiniteNumber(
      row.latency_p95_ms,
      ARTIFACT_NAME,
      `${path}.latency_p95_ms`,
    ),
  }
}

function ratio(value: unknown, path: string): number {
  const result = nonNegativeFiniteNumber(value, ARTIFACT_NAME, path)
  if (result > 1) invalid(ARTIFACT_NAME, `${path} must be between zero and one`)
  return result
}

function decodeLevel(value: unknown, index: number): EvaluationCapacityLevel {
  const path = `levels[${index}]`
  const level = recordWithExactKeys(
    value,
    [
      'concurrency',
      'warmup_requests',
      'warmup_errors',
      'warmup_elapsed_seconds',
      'measurement_requests',
      'successes',
      'errors',
      'elapsed_seconds',
      'throughput_rps',
      'throughput_cv',
      'latency_p50_ms',
      'latency_p95_ms',
      'latency_p99_ms',
      'latency_p95_cv',
      'error_rate',
      'error_rate_upper_bound',
      'input_tokens',
      'output_tokens',
      'runtime_cost_usd',
      'repetitions',
      'throughput_scaling_efficiency',
      'warmup_passed',
      'latency_slo_passed',
      'error_slo_passed',
      'throughput_slo_passed',
      'scaling_slo_passed',
      'throughput_stability_passed',
      'latency_stability_passed',
      'qualified',
    ],
    ARTIFACT_NAME,
    path,
  )
  const concurrency = boundedInteger(
    level.concurrency,
    ARTIFACT_NAME,
    `${path}.concurrency`,
    1,
    128,
  )
  const warmupRequests = boundedInteger(
    level.warmup_requests,
    ARTIFACT_NAME,
    `${path}.warmup_requests`,
    1,
  )
  const warmupErrors = boundedInteger(level.warmup_errors, ARTIFACT_NAME, `${path}.warmup_errors`)
  const measurementRequests = boundedInteger(
    level.measurement_requests,
    ARTIFACT_NAME,
    `${path}.measurement_requests`,
    1,
  )
  const successes = boundedInteger(level.successes, ARTIFACT_NAME, `${path}.successes`)
  const errors = boundedInteger(level.errors, ARTIFACT_NAME, `${path}.errors`)
  if (warmupErrors > warmupRequests || successes + errors !== measurementRequests) {
    invalid(ARTIFACT_NAME, `${path} request accounting is inconsistent`)
  }
  if (
    !Array.isArray(level.repetitions) ||
    level.repetitions.length < 3 ||
    level.repetitions.length > 5
  ) {
    invalid(ARTIFACT_NAME, `${path}.repetitions must contain three to five independent windows`)
  }
  const repetitions = level.repetitions.map((row, repetition) =>
    decodeRepetition(row, `${path}.repetitions[${repetition}]`),
  )
  if (
    repetitions.some(
      (row, repetition) => row.concurrency !== concurrency || row.repetition !== repetition + 1,
    ) ||
    repetitions.reduce((sum, row) => sum + row.requests, 0) !== measurementRequests ||
    repetitions.reduce((sum, row) => sum + row.successes, 0) !== successes ||
    repetitions.reduce((sum, row) => sum + row.errors, 0) !== errors
  ) {
    invalid(ARTIFACT_NAME, `${path}.repetitions do not exactly cover the level`)
  }
  const elapsed = positiveFiniteNumber(
    level.elapsed_seconds,
    ARTIFACT_NAME,
    `${path}.elapsed_seconds`,
  )
  const throughput = positiveFiniteNumber(
    level.throughput_rps,
    ARTIFACT_NAME,
    `${path}.throughput_rps`,
  )
  const throughputCV = nonNegativeFiniteNumber(
    level.throughput_cv,
    ARTIFACT_NAME,
    `${path}.throughput_cv`,
  )
  const latencyP50 = nonNegativeFiniteNumber(
    level.latency_p50_ms,
    ARTIFACT_NAME,
    `${path}.latency_p50_ms`,
  )
  const latencyP95 = nonNegativeFiniteNumber(
    level.latency_p95_ms,
    ARTIFACT_NAME,
    `${path}.latency_p95_ms`,
  )
  const latencyP99 = nonNegativeFiniteNumber(
    level.latency_p99_ms,
    ARTIFACT_NAME,
    `${path}.latency_p99_ms`,
  )
  const latencyP95CV = nonNegativeFiniteNumber(
    level.latency_p95_cv,
    ARTIFACT_NAME,
    `${path}.latency_p95_cv`,
  )
  const errorRate = ratio(level.error_rate, `${path}.error_rate`)
  const errorUpper = ratio(level.error_rate_upper_bound, `${path}.error_rate_upper_bound`)
  const throughputValues = repetitions.map((row) => row.throughput_rps)
  const latencyP95Values = repetitions.map((row) => row.latency_p95_ms)
  if (
    latencyP50 > latencyP95 ||
    latencyP95 > latencyP99 ||
    !approximatelyEqual(
      elapsed,
      repetitions.reduce((sum, row) => sum + row.elapsed_seconds, 0),
    ) ||
    !approximatelyEqual(throughput, arithmeticMean(throughputValues)) ||
    !approximatelyEqual(throughputCV, sampleCV(throughputValues)) ||
    !approximatelyEqual(latencyP95CV, sampleCV(latencyP95Values)) ||
    !approximatelyEqual(errorRate, errors / measurementRequests) ||
    !approximatelyEqual(errorUpper, oneSidedWilsonUpper(errors, measurementRequests))
  ) {
    invalid(ARTIFACT_NAME, `${path} statistics do not match its independent repetitions`)
  }
  const scaling =
    level.throughput_scaling_efficiency === null
      ? null
      : nonNegativeFiniteNumber(
          level.throughput_scaling_efficiency,
          ARTIFACT_NAME,
          `${path}.throughput_scaling_efficiency`,
        )
  return {
    concurrency,
    warmup_requests: warmupRequests,
    warmup_errors: warmupErrors,
    warmup_elapsed_seconds: positiveFiniteNumber(
      level.warmup_elapsed_seconds,
      ARTIFACT_NAME,
      `${path}.warmup_elapsed_seconds`,
    ),
    measurement_requests: measurementRequests,
    successes,
    errors,
    elapsed_seconds: elapsed,
    throughput_rps: throughput,
    throughput_cv: throughputCV,
    latency_p50_ms: latencyP50,
    latency_p95_ms: latencyP95,
    latency_p99_ms: latencyP99,
    latency_p95_cv: latencyP95CV,
    error_rate: errorRate,
    error_rate_upper_bound: errorUpper,
    input_tokens: boundedInteger(level.input_tokens, ARTIFACT_NAME, `${path}.input_tokens`),
    output_tokens: boundedInteger(level.output_tokens, ARTIFACT_NAME, `${path}.output_tokens`),
    runtime_cost_usd: nonNegativeFiniteNumber(
      level.runtime_cost_usd,
      ARTIFACT_NAME,
      `${path}.runtime_cost_usd`,
    ),
    repetitions,
    throughput_scaling_efficiency: scaling,
    warmup_passed: booleanValue(level.warmup_passed, ARTIFACT_NAME, `${path}.warmup_passed`),
    latency_slo_passed: booleanValue(
      level.latency_slo_passed,
      ARTIFACT_NAME,
      `${path}.latency_slo_passed`,
    ),
    error_slo_passed: booleanValue(
      level.error_slo_passed,
      ARTIFACT_NAME,
      `${path}.error_slo_passed`,
    ),
    throughput_slo_passed: booleanValue(
      level.throughput_slo_passed,
      ARTIFACT_NAME,
      `${path}.throughput_slo_passed`,
    ),
    scaling_slo_passed: booleanValue(
      level.scaling_slo_passed,
      ARTIFACT_NAME,
      `${path}.scaling_slo_passed`,
    ),
    throughput_stability_passed: booleanValue(
      level.throughput_stability_passed,
      ARTIFACT_NAME,
      `${path}.throughput_stability_passed`,
    ),
    latency_stability_passed: booleanValue(
      level.latency_stability_passed,
      ARTIFACT_NAME,
      `${path}.latency_stability_passed`,
    ),
    qualified: booleanValue(level.qualified, ARTIFACT_NAME, `${path}.qualified`),
  }
}

function nullableConcurrency(value: unknown, path: string): number | null {
  return value === null ? null : boundedInteger(value, ARTIFACT_NAME, path, 1, 128)
}

function decodeAssessment(value: unknown): EvaluationCapacitySLOAssessment {
  const assessment = recordWithExactKeys(
    value,
    [
      'qualified_concurrency',
      'saturation_concurrency',
      'slo_headroom',
      'verdict',
      'failure_reasons',
    ],
    ARTIFACT_NAME,
    'assessment',
  )
  if (assessment.verdict !== 'pass' && assessment.verdict !== 'fail') {
    invalid(ARTIFACT_NAME, 'assessment.verdict must be pass or fail')
  }
  if (
    !Array.isArray(assessment.failure_reasons) ||
    assessment.failure_reasons.some(
      (reason) =>
        typeof reason !== 'string' ||
        !FAILURE_REASONS.includes(reason as EvaluationCapacityFailureReason),
    )
  ) {
    invalid(ARTIFACT_NAME, 'assessment.failure_reasons are invalid')
  }
  const failureReasons = assessment.failure_reasons as EvaluationCapacityFailureReason[]
  const canonical = FAILURE_REASONS.filter((reason) => failureReasons.includes(reason))
  if (
    failureReasons.length !== new Set(failureReasons).size ||
    failureReasons.some((reason, index) => canonical[index] !== reason)
  ) {
    invalid(ARTIFACT_NAME, 'assessment.failure_reasons must be unique and canonical')
  }
  const headroom = boundedInteger(
    assessment.slo_headroom,
    ARTIFACT_NAME,
    'assessment.slo_headroom',
    -128,
    128,
  )
  return {
    qualified_concurrency: nullableConcurrency(
      assessment.qualified_concurrency,
      'assessment.qualified_concurrency',
    ),
    saturation_concurrency: nullableConcurrency(
      assessment.saturation_concurrency,
      'assessment.saturation_concurrency',
    ),
    slo_headroom: headroom,
    verdict: assessment.verdict,
    failure_reasons: failureReasons,
  }
}

function expectedFailureReasons(
  levels: EvaluationCapacityLevel[],
  slo: EvaluationCapacitySLO,
  qualifiedConcurrency: number | null,
): EvaluationCapacityFailureReason[] {
  if (qualifiedConcurrency !== null && qualifiedConcurrency >= slo.required_concurrency) return []
  const target = levels.find((level) => level.concurrency >= slo.required_concurrency)
  if (!target) return ['required_concurrency']
  const checks: Array<[boolean, EvaluationCapacityFailureReason]> = [
    [target.warmup_passed, 'warmup_errors'],
    [target.latency_slo_passed, 'latency_p95'],
    [target.error_slo_passed, 'error_rate_upper_bound'],
    [target.throughput_slo_passed, 'throughput'],
    [target.scaling_slo_passed, 'throughput_scaling'],
    [target.throughput_stability_passed, 'throughput_stability'],
    [target.latency_stability_passed, 'latency_stability'],
  ]
  const reasons = checks.filter(([passed]) => !passed).map(([, reason]) => reason)
  return reasons.length ? reasons : ['required_concurrency']
}

function validateReduction(profile: EvaluationCapacityProfile): void {
  let envelopeOpen = true
  let previous: EvaluationCapacityLevel | null = null
  for (const [index, level] of profile.levels.entries()) {
    if (
      level.concurrency !== profile.protocol.concurrency_levels[index] ||
      level.repetitions.length !== profile.protocol.repetitions_per_level ||
      level.repetitions.some(
        (repetition) =>
          repetition.requests !== profile.protocol.measurement_requests_per_repetition,
      ) ||
      level.warmup_requests !== level.concurrency * profile.protocol.warmup_request_multiplier
    ) {
      invalid(ARTIFACT_NAME, 'levels do not match the frozen load protocol')
    }
    const scaling = previous
      ? level.throughput_rps / previous.throughput_rps / (level.concurrency / previous.concurrency)
      : null
    const expected = {
      warmup: level.warmup_errors === 0,
      latency: level.latency_p95_ms <= profile.slo.max_latency_p95_ms,
      errors: level.error_rate_upper_bound <= profile.slo.max_error_rate,
      throughput:
        level.concurrency < profile.slo.required_concurrency ||
        level.throughput_rps >= profile.slo.min_throughput_rps,
      scaling: scaling === null || scaling >= profile.slo.min_throughput_scaling_efficiency,
      throughputStable: level.throughput_cv <= profile.protocol.max_throughput_cv,
      latencyStable: level.latency_p95_cv <= profile.protocol.max_latency_p95_cv,
    }
    const qualified =
      envelopeOpen &&
      expected.warmup &&
      expected.latency &&
      expected.errors &&
      expected.throughput &&
      expected.scaling &&
      expected.throughputStable &&
      expected.latencyStable
    if (
      (scaling === null
        ? level.throughput_scaling_efficiency !== null
        : level.throughput_scaling_efficiency === null ||
          !approximatelyEqual(level.throughput_scaling_efficiency, scaling)) ||
      level.warmup_passed !== expected.warmup ||
      level.latency_slo_passed !== expected.latency ||
      level.error_slo_passed !== expected.errors ||
      level.throughput_slo_passed !== expected.throughput ||
      level.scaling_slo_passed !== expected.scaling ||
      level.throughput_stability_passed !== expected.throughputStable ||
      level.latency_stability_passed !== expected.latencyStable ||
      level.qualified !== qualified
    ) {
      invalid(ARTIFACT_NAME, 'level decisions do not match measured observations')
    }
    if (!qualified) envelopeOpen = false
    previous = level
  }
  const qualifiedConcurrency =
    [...profile.levels].reverse().find((level) => level.qualified)?.concurrency ?? null
  const saturationConcurrency =
    profile.levels.find((level) => !level.qualified)?.concurrency ?? null
  const headroom = (qualifiedConcurrency ?? 0) - profile.slo.required_concurrency
  const reasons = expectedFailureReasons(profile.levels, profile.slo, qualifiedConcurrency)
  const verdict = headroom >= 0 ? 'pass' : 'fail'
  if (
    profile.assessment.qualified_concurrency !== qualifiedConcurrency ||
    profile.assessment.saturation_concurrency !== saturationConcurrency ||
    profile.assessment.slo_headroom !== headroom ||
    profile.assessment.verdict !== verdict ||
    profile.assessment.failure_reasons.length !== reasons.length ||
    profile.assessment.failure_reasons.some((reason, index) => reason !== reasons[index])
  ) {
    invalid(ARTIFACT_NAME, 'assessment does not match the measured SLO envelope')
  }
}

export function decodeEvaluationCapacityProfile(
  value: unknown,
  expectedSLO: EvaluationCapacitySLO | undefined,
  expectedProtocol: EvaluationCapacityLoadProtocol | undefined,
): EvaluationCapacityProfile {
  const root = recordWithExactKeys(
    value,
    ['schema_version', 'kind', 'protocol', 'levels', 'slo', 'assessment'],
    ARTIFACT_NAME,
    'artifact',
  )
  if (root.schema_version !== 'evaluation.v1' || root.kind !== 'repeated-closed-loop-capacity') {
    invalid(ARTIFACT_NAME, 'artifact must use the current repeated closed-loop capacity contract')
  }
  if (!expectedProtocol || !expectedSLO) {
    invalid(ARTIFACT_NAME, 'frozen report capacity contracts are unavailable')
  }
  let protocol: EvaluationCapacityLoadProtocol
  let slo: EvaluationCapacitySLO
  try {
    protocol = decodeEvaluationCapacityLoadProtocol(
      root.protocol,
      expectedProtocol.concurrency_levels[expectedProtocol.concurrency_levels.length - 1],
      'Capacity profile load protocol',
    )
    slo = decodeEvaluationCapacitySLO(root.slo, 'Capacity profile SLO')
  } catch (error) {
    invalid(
      ARTIFACT_NAME,
      error instanceof Error ? error.message : 'capacity contracts are invalid',
    )
  }
  if (
    !equalEvaluationCapacityLoadProtocol(protocol, expectedProtocol) ||
    !equalEvaluationCapacitySLO(slo, expectedSLO)
  ) {
    invalid(ARTIFACT_NAME, 'protocol or SLO differs from the frozen report run contract')
  }
  if (!Array.isArray(root.levels) || root.levels.length < 2 || root.levels.length > 8) {
    invalid(ARTIFACT_NAME, 'levels must contain two to eight protocol observations')
  }
  const profile: EvaluationCapacityProfile = {
    schema_version: 'evaluation.v1',
    kind: 'repeated-closed-loop-capacity',
    protocol,
    levels: root.levels.map(decodeLevel),
    slo,
    assessment: decodeAssessment(root.assessment),
  }
  validateReduction(profile)
  return profile
}
