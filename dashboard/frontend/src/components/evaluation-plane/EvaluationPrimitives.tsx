import type { ReactNode } from 'react'

import type {
  EvaluationCoverage,
  EvaluationGate,
  EvaluationMetric,
  EvaluationRunStatus,
  EvaluationTrackId,
  EvaluationTrackStatus,
  GateVerdict,
} from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import {
  clampFraction,
  formatMetric,
  gateVerdictPresentation,
  RUN_STATUS_LABELS,
  TRACK_STATUS_LABELS,
} from './evaluationPresentation'
import styles from './EvaluationPlane.module.css'

export function RunStatusBadge({
  status,
}: {
  status: EvaluationRunStatus | EvaluationTrackStatus
}) {
  const label =
    status in RUN_STATUS_LABELS
      ? RUN_STATUS_LABELS[status as EvaluationRunStatus]
      : TRACK_STATUS_LABELS[status]
  return <span className={`${styles.badge} ${styles[`status_${status}`]}`}>{label}</span>
}

export function GateVerdictBadge({
  verdict,
  disposition = 'advisory',
}: {
  verdict: GateVerdict
  disposition?: EvaluationGate['disposition']
}) {
  const presentation = gateVerdictPresentation({ verdict, disposition })
  return (
    <span
      className={`${styles.badge} ${styles[`gate_${verdict}`]}`}
      title={presentation.explanation}
    >
      {presentation.label}
    </span>
  )
}

export function TrackChips({ trackIDs }: { trackIDs: EvaluationTrackId[] }) {
  return (
    <div className={styles.chips} aria-label="Evaluation tracks">
      {trackIDs.map((trackID) => (
        <span key={trackID} className={styles.chip} title={TRACK_PRESENTATION[trackID].description}>
          {TRACK_PRESENTATION[trackID].label}
        </span>
      ))}
    </div>
  )
}

export function CoverageBar({ coverage }: { coverage: EvaluationCoverage }) {
  const fraction = clampFraction(coverage.fraction)
  return (
    <div className={styles.coverage}>
      <div className={styles.coverageCopy}>
        <span>Coverage</span>
        <strong>{(fraction * 100).toFixed(1)}%</strong>
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label="Evaluation coverage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      <small>
        {coverage.evaluated} of {coverage.total} case-track observations
        {coverage.unavailable ? ` · ${coverage.unavailable} without an observation` : ''}
      </small>
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'negative'
}

export function MetricCard({ label, value, detail, tone = 'neutral' }: MetricCardProps) {
  return (
    <div className={`${styles.metricCard} ${styles[`metric_${tone}`]}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}

export function MetricGrid({ metrics }: { metrics: EvaluationMetric[] }) {
  if (metrics.length === 0) {
    return <p className={styles.emptyCopy}>No metrics were produced for this evidence slice.</p>
  }
  return (
    <div className={styles.metricGrid}>
      {metrics.map((metric) => (
        <MetricCard
          key={`${metric.track_id || 'all'}-${metric.id}`}
          label={metric.name}
          value={formatMetric(metric)}
          detail={
            typeof metric.sample_count === 'number'
              ? `${metric.sample_count} samples${metric.confidence_interval ? ' · confidence interval available' : ''}`
              : undefined
          }
        />
      ))}
    </div>
  )
}
