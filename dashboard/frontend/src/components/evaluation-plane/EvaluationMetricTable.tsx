import { useDeferredValue, useEffect, useMemo, useState } from 'react'

import type { EvidenceLevel, EvaluationTrackId } from '../../types/evaluationPlane'
import type { EvaluationMetric } from '../../types/evaluationReport'
import { EvaluationActionButton } from './EvaluationPrimitives'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import {
  formatConfidenceInterval,
  formatDelta,
  formatMetric,
  isServerReducedMetric,
  metricDeltaTone,
} from './evaluationPresentation'
import styles from './EvaluationMetricTable.module.css'
import reportStyles from './EvaluationReportLayout.module.css'
import tableStyles from './EvaluationReportTable.module.css'

interface EvaluationMetricTableProps {
  metrics: EvaluationMetric[]
  caption?: string
  compact?: boolean
  controls?: boolean
  evidenceLevel?: EvidenceLevel
}

const METRICS_PAGE_SIZE = 20

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
  metricID: string,
): string | undefined {
  if (!evidenceLevel) return undefined
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
}: EvaluationMetricTableProps) {
  const [search, setSearch] = useState('')
  const [track, setTrack] = useState<EvaluationTrackId | 'all'>('all')
  const [page, setPage] = useState(1)
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const tracks = useMemo(
    () =>
      [
        ...new Set(metrics.map((metric) => metric.track_id).filter(Boolean)),
      ].sort() as EvaluationTrackId[],
    [metrics],
  )
  const filtered = useMemo(
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
  const pages = Math.max(1, Math.ceil(filtered.length / METRICS_PAGE_SIZE))
  const safePage = Math.min(page, pages)
  const firstVisibleIndex = (safePage - 1) * METRICS_PAGE_SIZE
  const visible = filtered.slice(firstVisibleIndex, firstVisibleIndex + METRICS_PAGE_SIZE)

  useEffect(() => setPage(1), [deferredSearch, track])
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])

  if (metrics.length === 0) {
    return <p className={reportStyles.empty}>No metrics were produced for this evidence slice.</p>
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
            {filtered.length
              ? `${firstVisibleIndex + 1}–${firstVisibleIndex + visible.length} of ${filtered.length}`
              : `0 of ${metrics.length}`}
            {filtered.length !== metrics.length ? ` matching · ${metrics.length} total` : ''}
          </span>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className={reportStyles.empty}>No metrics match the current filters.</p>
      ) : (
        <div
          className={tableStyles.tableScroll}
          role="region"
          tabIndex={0}
          aria-label={`Scrollable ${caption}`}
        >
          <table
            className={`${tableStyles.table} ${styles.metricTable} ${compact ? styles.metricTableCompact : ''}`}
          >
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
                const metricEvidence = metricEvidenceLabel(evidenceLevel, metric.id)
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
      {filtered.length > 0 && pages > 1 ? (
        <nav className={styles.metricPagination} aria-label="Metric table pages">
          <EvaluationActionButton
            type="button"
            compact
            disabled={safePage === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            Previous
          </EvaluationActionButton>
          <span>
            Page {safePage} of {pages}
          </span>
          <EvaluationActionButton
            type="button"
            compact
            disabled={safePage === pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
          >
            Next
          </EvaluationActionButton>
        </nav>
      ) : null}
    </div>
  )
}
