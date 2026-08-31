import type { ButtonHTMLAttributes, ReactNode } from 'react'

import type {
  EvaluationRunStatus,
  EvaluationTrackId,
  EvaluationTrackStatus,
  GateVerdict,
} from '../../types/evaluationPlane'
import type {
  EvaluationCoverage,
  EvaluationGate,
  EvaluationMetric,
} from '../../types/evaluationReport'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import {
  clampFraction,
  formatMetric,
  gateVerdictPresentation,
  RUN_STATUS_LABELS,
  TRACK_STATUS_LABELS,
} from './evaluationPresentation'
import overviewStyles from './EvaluationOverview.module.css'
import styles from './EvaluationPlane.module.css'

interface EvaluationActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
  compact?: boolean
}

export function EvaluationActionButton({
  variant = 'secondary',
  compact = false,
  className = '',
  ...props
}: EvaluationActionButtonProps) {
  const variantClass = variant === 'primary' ? styles.primaryButton : styles.secondaryButton
  return (
    <button
      {...props}
      className={`${variantClass} ${compact ? styles.compactButton : ''} ${className}`.trim()}
    />
  )
}

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
        {coverage.unavailable ? ` · ${coverage.unavailable} not measured` : ''}
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
  const toneClass = tone === 'neutral' ? '' : overviewStyles[`metric_${tone}`]
  return (
    <div className={`${overviewStyles.metricCard} ${toneClass}`}>
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
    <div className={overviewStyles.metricGrid}>
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
