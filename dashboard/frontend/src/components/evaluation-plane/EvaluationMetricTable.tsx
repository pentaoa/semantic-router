import { useDeferredValue, useMemo, useState } from 'react'

import type {
  EvidenceLevel,
  EvaluationMetric,
  EvaluationTrackId,
} from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import {
  formatConfidenceInterval,
  formatDelta,
  formatMetric,
  isServerReducedMetric,
  legacyEvaluationEvidenceLabel,
  metricDeltaTone,
} from './evaluationPresentation'
import styles from './EvaluationReport.module.css'

interface EvaluationMetricTableProps {
  metrics: EvaluationMetric[]
  caption?: string
  compact?: boolean
  controls?: boolean
  evidenceLevel?: EvidenceLevel
  serverAttested?: boolean
}

function directionLabel(direction: EvaluationMetric['direction']): string {
  switch (direction) {
    case 'higher_is_better':
      return 'Higher is better'
    case 'lower_is_better':
      return 'Lower is better'
    case 'target':
      return 'Target range'
    default:
      return 'Diagnostic'
  }
}

function metricEvidenceLabel(
  evidenceLevel: EvidenceLevel | undefined,
  serverAttested: boolean,
  metricID: string,
): string | undefined {
  if (!evidenceLevel) return undefined
  if (!serverAttested) return legacyEvaluationEvidenceLabel(evidenceLevel)
  return isServerReducedMetric(metricID)
    ? `Server-reduced ${evidenceLevel}`
    : `Worker-derived ${evidenceLevel} / diagnostic only`
}

function MetricValue({ metric }: { metric: EvaluationMetric }) {
  if (metric.value === null || !Number.isFinite(metric.value)) {
    return (
      <span className={styles.missingValue} title="This run did not produce this metric.">
        Not measured
      </span>
    )
  }
  return <>{formatMetric(metric)}</>
}

export default function EvaluationMetricTable({
  metrics,
  caption = 'Evaluation metrics',
  compact = false,
  controls = true,
  evidenceLevel,
  serverAttested = false,
}: EvaluationMetricTableProps) {
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState<EvaluationTrackId | 'all'>('all')
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const tracks = useMemo(
    () =>
      [
        ...new Set(metrics.map((metric) => metric.track_id).filter(Boolean)),
      ].sort() as EvaluationTrackId[],
    [metrics],
  )
  const visible = useMemo(
    () =>
      metrics.filter((metric) => {
        if (track !== 'all' && metric.track_id !== track) return false
        if (!deferredSearch) return true
        return `${metric.id} ${metric.name} ${metric.track_id || ''} ${metric.unit}`
          .toLowerCase()
          .includes(deferredSearch)
      }),
    [deferredSearch, metrics, track],
  )

  if (metrics.length === 0) {
    return <p className={styles.empty}>No metrics were produced for this evidence slice.</p>
  }

  return (
    <div className={styles.metricTableRegion}>
      {controls && metrics.length > 6 ? (
        <div className={styles.metricToolbar}>
          <label>
            <span>Find a metric</span>
            <input
              type="search"
              value={search}
              placeholder="Name or metric ID"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {tracks.length > 1 ? (
            <label>
              <span>Track</span>
              <select
                value={track}
                onChange={(event) => setTrack(event.target.value as EvaluationTrackId | 'all')}
              >
                <option value="all">All tracks</option>
                {tracks.map((trackID) => (
                  <option key={trackID} value={trackID}>
                    {TRACK_PRESENTATION[trackID].label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className={styles.metricResultCount} aria-live="polite">
            {visible.length} of {metrics.length}
          </span>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className={styles.empty}>No metrics match the current filters.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={`${styles.metricTable} ${compact ? styles.metricTableCompact : ''}`}>
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Value</th>
                {!compact ? <th scope="col">Baseline / delta</th> : null}
                {!compact ? <th scope="col">95% interval</th> : null}
                <th scope="col">Samples</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((metric) => {
                const delta = formatDelta(metric)
                const interval = formatConfidenceInterval(metric)
                const deltaTone = metricDeltaTone(metric)
                const metricEvidence = metricEvidenceLabel(evidenceLevel, serverAttested, metric.id)
                return (
                  <tr key={`${metric.track_id || 'all'}-${metric.id}`}>
                    <th scope="row">
                      <span className={styles.metricName}>{metric.name}</span>
                      <span className={styles.metricIdentity}>
                        {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'} ·{' '}
                        <code>{metric.id}</code>
                        {metricEvidence ? ` · ${metricEvidence}` : ''}
                      </span>
                    </th>
                    <td>
                      <strong className={styles.metricValue}>
                        <MetricValue metric={metric} />
                      </strong>
                      <span className={styles.metricDirection}>
                        {directionLabel(metric.direction)}
                      </span>
                    </td>
                    {!compact ? (
                      <td>
                        {metric.baseline_value !== null &&
                        typeof metric.baseline_value !== 'undefined' ? (
                          <>
                            <span>
                              {formatMetric({ value: metric.baseline_value, unit: metric.unit })}
                            </span>
                            <strong className={styles[`delta_${deltaTone}`]}>
                              {delta || 'No change'}
                            </strong>
                          </>
                        ) : (
                          <span className={styles.tableMuted}>No paired baseline</span>
                        )}
                      </td>
                    ) : null}
                    {!compact ? (
                      <td>
                        {interval ? (
                          <span>{interval}</span>
                        ) : (
                          <span className={styles.tableMuted}>Not estimated</span>
                        )}
                      </td>
                    ) : null}
                    <td>
                      {typeof metric.sample_count === 'number' ? (
                        new Intl.NumberFormat().format(metric.sample_count)
                      ) : (
                        <span className={styles.tableMuted}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
