import type {
  EvaluationRunStatus,
  EvaluationTrackStatus,
  GateVerdict,
} from '../../types/evaluationPlane'
import type {
  EvaluationGate,
  EvaluationMetric,
  EvaluationReport,
} from '../../types/evaluationReport'

export const RUN_STATUS_LABELS: Record<EvaluationRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  sealing: 'Sealing evidence',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const TRACK_STATUS_LABELS: Record<EvaluationTrackStatus, string> = {
  ...RUN_STATUS_LABELS,
  unavailable: 'Not measured',
  skipped: 'Not selected',
}

export const GATE_VERDICT_LABELS: Record<GateVerdict, string> = {
  pass: 'Passed',
  fail: 'Blocked',
  unavailable: 'Evidence needed',
  waived: 'Waived',
  not_applicable: 'Not required',
}

export type EvaluationTone = 'neutral' | 'positive' | 'warning' | 'negative'

export function gateVerdictPresentation(gate: Pick<EvaluationGate, 'disposition' | 'verdict'>): {
  label: string
  tone: EvaluationTone
  explanation: string
} {
  switch (gate.verdict) {
    case 'pass':
      return {
        label: 'Passed',
        tone: 'positive',
        explanation: 'The recorded evidence satisfied this gate.',
      }
    case 'fail':
      return {
        label: 'Blocked',
        tone: 'negative',
        explanation: 'The observed evidence violated this gate.',
      }
    case 'waived':
      return {
        label: 'Waived',
        tone: 'neutral',
        explanation: 'The gate was explicitly waived with recorded rationale.',
      }
    case 'not_applicable':
      return {
        label: 'Not required',
        tone: 'neutral',
        explanation: 'This gate does not apply to the selected change profile.',
      }
    case 'unavailable':
      return gate.disposition === 'required'
        ? {
            label: 'Evidence needed',
            tone: 'warning',
            explanation: 'Required evidence was not produced, so this gate cannot pass.',
          }
        : {
            label: 'Not measured',
            tone: 'neutral',
            explanation: 'This advisory evidence was not produced by the run.',
          }
  }
}

export function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || typeof value === 'undefined' || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

export function formatMetric(metric: Pick<EvaluationMetric, 'value' | 'unit'>): string {
  if (metric.value === null || !Number.isFinite(metric.value)) return '\u2014'
  const unit = metric.unit.trim()
  switch (unit.toLowerCase()) {
    case 'ratio':
    case 'fraction':
      return formatPercent(metric.value)
    case 'percent':
    case '%':
      return `${metric.value.toFixed(1)}%`
    case 'ms':
      return `${metric.value.toFixed(Number.isInteger(metric.value) || metric.value >= 100 ? 0 : 1)} ms`
    case 's':
    case 'seconds':
      return `${metric.value.toFixed(2)} s`
    case 'usd':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: metric.value > 0 && metric.value < 0.01 ? 4 : 2,
        maximumFractionDigits: metric.value > 0 && metric.value < 0.01 ? 8 : 2,
      }).format(metric.value)
    case 'usd/request':
      return `${new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: metric.value > 0 && metric.value < 0.01 ? 4 : 2,
        maximumFractionDigits: metric.value > 0 && metric.value < 0.01 ? 8 : 2,
      }).format(metric.value)} / req`
    case 'count':
    case 'cases':
    case 'requests':
    case 'concurrency':
      return new Intl.NumberFormat().format(metric.value)
    case 'requests/s':
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(metric.value)} req/s`
    case 'bits':
      return `${metric.value.toFixed(2)} bits`
    case 'boolean':
      return metric.value > 0 ? 'Yes' : 'No'
    case 'violations/case':
      return `${metric.value.toFixed(4)} / case`
    default:
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(metric.value)}${unit ? ` ${unit}` : ''}`
  }
}

export function formatDelta(metric: Pick<EvaluationMetric, 'delta' | 'unit'>): string | null {
  if (metric.delta === null || typeof metric.delta === 'undefined') return null
  const formatted = formatMetric({ value: Math.abs(metric.delta), unit: metric.unit })
  return `${metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : ''}${formatted}`
}

export function formatConfidenceInterval(
  metric: Pick<EvaluationMetric, 'confidence_interval' | 'unit'>,
): string | null {
  if (!metric.confidence_interval || metric.confidence_interval.length !== 2) return null
  const [lower, upper] = metric.confidence_interval
  return `${formatMetric({ value: lower, unit: metric.unit })} \u2013 ${formatMetric({ value: upper, unit: metric.unit })}`
}

export function metricDeltaTone(
  metric: Pick<EvaluationMetric, 'delta' | 'direction'>,
): EvaluationTone {
  if (!metric.delta || !metric.direction || metric.direction === 'target') return 'neutral'
  const improved = metric.direction === 'higher_is_better' ? metric.delta > 0 : metric.delta < 0
  return improved ? 'positive' : 'negative'
}

export function evidenceRank(level: string): number {
  const parsed = Number(level.replace(/^E/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function effectiveGateVerdict(reported: GateVerdict, gates: EvaluationGate[]): GateVerdict {
  const requiredGates = gates.filter((gate) => gate.disposition === 'required')
  if (requiredGates.some((gate) => gate.verdict === 'fail')) return 'fail'
  if (requiredGates.some((gate) => gate.verdict === 'unavailable')) return 'unavailable'
  return reported
}

export function evaluationPromotionVerdict(report: EvaluationReport): GateVerdict {
  return effectiveGateVerdict(report.summary.verdict, report.gates)
}

const HEADLINE_METRIC_PRIORITY = [
  'joint.realized_quality',
  'routing.accuracy',
  'model_pool.oracle_gain',
  'model_pool.oracle_quality',
  'agentic.success_rate',
  'multimodal.quality',
  'multimodal.support_rate',
  'preference.agreement',
  'joint.normalized_regret',
  'safety.violation_rate',
  'safety.block_accuracy',
  'capacity.throughput_rps',
  'capacity.latency_p95_ms',
  'capacity.success_rate',
  'capacity.cost_per_successful_request',
] as const

// The v2 control plane independently reduces only these values from sealed
// records, regardless of the report's claim level. Every other aggregate stays
// available in the explorer but cannot become a headline under this revision.
const SERVER_REDUCED_HEADLINES = new Set([
  'joint.normalized_regret',
  'safety.violation_rate',
  'safety.block_accuracy',
  'capacity.success_rate',
])

export function isServerReducedMetric(metricID: string): boolean {
  return SERVER_REDUCED_HEADLINES.has(metricID)
}

export function selectHeadlineMetrics(report: EvaluationReport, limit = 4): EvaluationMetric[] {
  const available = report.metrics.filter((metric) => {
    if (metric.value === null || !Number.isFinite(metric.value)) return false
    return isServerReducedMetric(metric.id)
  })
  const byID = new Map(available.map((metric) => [metric.id, metric]))
  const selected: EvaluationMetric[] = []
  for (const id of HEADLINE_METRIC_PRIORITY) {
    const metric = byID.get(id)
    if (!metric || !report.run.track_ids.includes(metric.track_id || 'joint')) continue
    selected.push(metric)
    byID.delete(id)
    if (selected.length === limit) return selected
  }
  for (const metric of available) {
    if (!byID.has(metric.id)) continue
    selected.push(metric)
    if (selected.length === limit) break
  }
  return selected
}
