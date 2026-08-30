import type { EvaluationComparisonStatistic } from '../../types/evaluationReport'
import { GateVerdictBadge } from './EvaluationPrimitives'
import tableStyles from './EvaluationReportTable.module.css'
import styles from './EvaluationComparisonStatistics.module.css'

const ANALYSIS_UNIT_LABELS: Record<EvaluationComparisonStatistic['analysis_unit'], string> = {
  case_mean: 'Case mean',
  case_max: 'Case maximum',
  case_oracle_regret: 'Case oracle regret',
  case_normalized_regret: 'Case normalized regret',
}

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
  minimumFractionDigits: 0,
})

function formatValue(value: number): string {
  return number.format(value)
}

function formatDelta(value: number): string {
  if (value === 0) return '0'
  return `${value > 0 ? '+' : '−'}${formatValue(Math.abs(value))}`
}

function formatInterval(interval: number[]): string {
  if (interval.length !== 2) return 'Not estimable'
  return `[${formatValue(interval[0])}, ${formatValue(interval[1])}]`
}

function unavailableReason(statistic: EvaluationComparisonStatistic): string | null {
  if (statistic.verdict !== 'unavailable') return null
  if (statistic.sample_count < 20) {
    return `Needs at least 20 independent case units; observed ${statistic.sample_count}.`
  }
  if (
    statistic.delta_confidence_interval.length !== 2 ||
    statistic.candidate_confidence_interval.length !== 2
  ) {
    return 'Needs complete candidate and paired-delta 95% confidence intervals.'
  }
  return 'The confidence interval crosses a frozen decision boundary.'
}

export default function EvaluationComparisonStatistics({
  statistics,
}: {
  statistics: EvaluationComparisonStatistic[]
}) {
  if (statistics.length === 0) {
    return (
      <div className={styles.empty} role="status">
        No registered paired statistic was estimable from this run pair. G3 remains unavailable.
      </div>
    )
  }

  return (
    <div className={tableStyles.tableScroll} tabIndex={0} aria-label="Scroll scientific statistics">
      <table className={`${tableStyles.table} ${styles.table}`}>
        <caption>Server-reduced paired scientific statistics</caption>
        <thead>
          <tr>
            <th scope="col">Statistic</th>
            <th scope="col">Baseline</th>
            <th scope="col">Candidate</th>
            <th scope="col">Paired delta · 95% CI</th>
            <th scope="col">Candidate 95% CI</th>
            <th scope="col">NI margin</th>
            <th scope="col">N</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {statistics.map((statistic) => {
            const reason = unavailableReason(statistic)
            return (
              <tr key={`${statistic.track_id}-${statistic.id}`}>
                <th scope="row">
                  <strong>{statistic.id}</strong>
                  <span>{ANALYSIS_UNIT_LABELS[statistic.analysis_unit]}</span>
                  <small>
                    {statistic.direction === 'higher_is_better'
                      ? 'Higher is better'
                      : 'Lower is better'}
                  </small>
                </th>
                <td>{formatValue(statistic.baseline_value)}</td>
                <td>{formatValue(statistic.candidate_value)}</td>
                <td>
                  <strong>{formatDelta(statistic.delta)}</strong>
                  <span>{formatInterval(statistic.delta_confidence_interval)}</span>
                </td>
                <td>{formatInterval(statistic.candidate_confidence_interval)}</td>
                <td>±{formatValue(statistic.non_inferiority_margin)}</td>
                <td>{statistic.sample_count}</td>
                <td>
                  <GateVerdictBadge verdict={statistic.verdict} disposition="required" />
                  {reason ? <small className={styles.reason}>{reason}</small> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
