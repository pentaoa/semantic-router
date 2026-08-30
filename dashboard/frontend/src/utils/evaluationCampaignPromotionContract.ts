import type {
  EvaluationCampaignG3PromotionPolicy,
  EvaluationCampaignG3PromotionStatistic,
} from '../types/evaluationCampaign'

type RecordValue = Record<string, unknown>

const CONFIDENCE_LEVEL = 0.95
const MINIMUM_CASES = 20

export const EVALUATION_CAMPAIGN_G3_PROMOTION_POLICY: EvaluationCampaignG3PromotionPolicy = {
  candidate_normalized_regret_maximum: 0.25,
  paired_normalized_regret_margin: 0.05,
  minimum_no_information_frontier_lift: 0.05,
  minimum_joint_reliability: 0.8,
  maximum_all_arm_failure_rate: 0.2,
  minimum_candidate_arm_reliability: 0.8,
}

const PROMOTION_CONTRACTS = [
  {
    id: 'campaign.g3.candidate_normalized_regret',
    direction: 'lower_is_better',
    threshold: { operator: '<=', value: 0.25, unit: 'fraction' },
  },
  {
    id: 'campaign.g3.paired_normalized_regret_delta',
    direction: 'lower_is_better',
    threshold: { operator: '<=', value: 0.05, unit: 'fraction' },
  },
  {
    id: 'campaign.g3.no_information_frontier_lift',
    direction: 'higher_is_better',
    threshold: { operator: '>=', value: 0.05, unit: 'quality' },
  },
  {
    id: 'campaign.g3.joint_reliability',
    direction: 'higher_is_better',
    threshold: { operator: '>=', value: 0.8, unit: 'fraction' },
  },
  {
    id: 'campaign.g3.all_arm_failure_rate',
    direction: 'lower_is_better',
    threshold: { operator: '<=', value: 0.2, unit: 'fraction' },
  },
] as const

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function interval(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(finite) &&
    (value.length === 0 || (value.length === 2 && value[0] <= value[1]))
  )
}

function decodePolicy(value: unknown): EvaluationCampaignG3PromotionPolicy {
  const keys = Object.keys(EVALUATION_CAMPAIGN_G3_PROMOTION_POLICY)
  if (
    !record(value) ||
    !exact(value, keys) ||
    keys.some(
      (key) =>
        value[key] !==
        EVALUATION_CAMPAIGN_G3_PROMOTION_POLICY[key as keyof EvaluationCampaignG3PromotionPolicy],
    )
  ) {
    throw new Error('Evaluation campaign G3 promotion policy is invalid.')
  }
  return value as unknown as EvaluationCampaignG3PromotionPolicy
}

function promotionVerdict(
  statistic: EvaluationCampaignG3PromotionStatistic,
): EvaluationCampaignG3PromotionStatistic['verdict'] {
  if (
    statistic.sample_count < MINIMUM_CASES ||
    statistic.missing_cases !== 0 ||
    statistic.confidence_interval.length !== 2
  ) {
    return 'unavailable'
  }
  const [lower, upper] = statistic.confidence_interval
  if (statistic.direction === 'higher_is_better') {
    if (lower >= statistic.threshold.value) return 'pass'
    if (upper < statistic.threshold.value) return 'fail'
    return 'unavailable'
  }
  if (upper <= statistic.threshold.value) return 'pass'
  if (lower > statistic.threshold.value) return 'fail'
  return 'unavailable'
}

function decodeStatistic(
  value: unknown,
  contract: (typeof PROMOTION_CONTRACTS)[number],
): EvaluationCampaignG3PromotionStatistic {
  if (
    !record(value) ||
    !exact(value, [
      'id',
      'direction',
      'estimate',
      'confidence_level',
      'confidence_interval',
      'threshold',
      'sample_count',
      'missing_cases',
      'verdict',
    ]) ||
    value.id !== contract.id ||
    value.direction !== contract.direction ||
    !finite(value.estimate) ||
    value.confidence_level !== CONFIDENCE_LEVEL ||
    !interval(value.confidence_interval) ||
    !record(value.threshold) ||
    !exact(value.threshold, ['operator', 'value', 'unit']) ||
    value.threshold.operator !== contract.threshold.operator ||
    value.threshold.value !== contract.threshold.value ||
    value.threshold.unit !== contract.threshold.unit ||
    !integer(value.sample_count) ||
    !integer(value.missing_cases) ||
    (value.verdict !== 'pass' && value.verdict !== 'fail' && value.verdict !== 'unavailable')
  ) {
    throw new Error(`Evaluation campaign G3 promotion statistic ${contract.id} is invalid.`)
  }
  const statistic = value as unknown as EvaluationCampaignG3PromotionStatistic
  const conclusive = statistic.sample_count >= MINIMUM_CASES && statistic.missing_cases === 0
  if (
    statistic.confidence_interval.length !== (conclusive ? 2 : 0) ||
    statistic.verdict !== promotionVerdict(statistic)
  ) {
    throw new Error(`Evaluation campaign G3 promotion statistic ${contract.id} is invalid.`)
  }
  return statistic
}

export function decodeEvaluationCampaignG3Promotion(
  policy: unknown,
  statistics: unknown,
): {
  policy: EvaluationCampaignG3PromotionPolicy
  statistics: EvaluationCampaignG3PromotionStatistic[]
} {
  const decodedPolicy = decodePolicy(policy)
  if (!Array.isArray(statistics) || statistics.length !== PROMOTION_CONTRACTS.length) {
    throw new Error('Evaluation campaign G3 promotion statistic vector is incomplete.')
  }
  return {
    policy: decodedPolicy,
    statistics: statistics.map((statistic, index) =>
      decodeStatistic(statistic, PROMOTION_CONTRACTS[index]),
    ),
  }
}

export function evaluationCampaignPromotionSampleCount(
  statistics: EvaluationCampaignG3PromotionStatistic[],
): number {
  return (
    statistics.find((statistic) => statistic.id === PROMOTION_CONTRACTS[0].id)?.sample_count || 0
  )
}
