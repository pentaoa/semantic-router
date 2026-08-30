import type { EvaluationCapacitySLOInput } from './useEvaluationExperimentForm'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import EvaluationExperimentSectionHeading from './EvaluationExperimentSectionHeading'
import styles from './EvaluationCapacitySLO.module.css'
import sectionStyles from './EvaluationExperimentSection.module.css'

interface EvaluationExperimentCapacitySLOProps {
  form: EvaluationExperimentFormModel
}

interface CapacitySLOPreset {
  id: string
  label: string
  description: string
  values: Omit<EvaluationCapacitySLOInput, 'requiredConcurrency'>
}

const CAPACITY_SLO_PRESETS: CapacitySLOPreset[] = [
  {
    id: 'latency',
    label: 'Latency guardrail',
    description: '250 ms p95 · 1% errors · 5 req/s · 60% scaling',
    values: {
      maxLatencyP95MS: '250',
      maxErrorRate: '0.01',
      minThroughputRPS: '5',
      minThroughputScalingEfficiency: '0.6',
    },
  },
  {
    id: 'balanced',
    label: 'Balanced service',
    description: '750 ms p95 · 2% errors · 10 req/s · 70% scaling',
    values: {
      maxLatencyP95MS: '750',
      maxErrorRate: '0.02',
      minThroughputRPS: '10',
      minThroughputScalingEfficiency: '0.7',
    },
  },
  {
    id: 'throughput',
    label: 'Throughput guardrail',
    description: '1500 ms p95 · 5% errors · 25 req/s · 80% scaling',
    values: {
      maxLatencyP95MS: '1500',
      maxErrorRate: '0.05',
      minThroughputRPS: '25',
      minThroughputScalingEfficiency: '0.8',
    },
  },
]

export default function EvaluationExperimentCapacitySLO({
  form,
}: EvaluationExperimentCapacitySLOProps) {
  if (!form.capacitySLOActive) return null

  const applyPreset = (preset: CapacitySLOPreset) => {
    form.applyCapacitySLOPreset({
      requiredConcurrency: String(form.concurrency),
      ...preset.values,
    })
  }

  return (
    <section className={`${sectionStyles.formSection} ${styles.sloSection}`}>
      <div className={styles.sloHeadingRow}>
        <EvaluationExperimentSectionHeading
          index="05"
          title="Capacity service objective"
          description="Freeze the service objective that G7 must prove from server-attested live load observations."
        />
        <span className={styles.sloRequired}>Required for live capacity</span>
      </div>

      <div className={styles.sloExplanation}>
        <strong>No inferred pass criteria</strong>
        <span>
          The server evaluates every declared SLO bound from the frozen load protocol. Missing or
          unstable measurements cannot qualify the operating point.
        </span>
      </div>

      {form.capacityLoadProtocol ? (
        <dl className={styles.protocolSummary} aria-label="Frozen capacity load protocol">
          <div>
            <dt>Concurrency ladder</dt>
            <dd>
              {form.capacityLoadProtocol.concurrency_levels.map((level) => `c${level}`).join(' → ')}
            </dd>
          </div>
          <div>
            <dt>Warmup</dt>
            <dd>{form.capacityLoadProtocol.warmup_request_multiplier} × concurrency requests</dd>
          </div>
          <div>
            <dt>Measurement</dt>
            <dd>
              {form.capacityLoadProtocol.measurement_requests_per_repetition} requests ×{' '}
              {form.capacityLoadProtocol.repetitions_per_level} repetitions
            </dd>
          </div>
          <div>
            <dt>Confidence / stability</dt>
            <dd>
              {(form.capacityLoadProtocol.confidence_level * 100).toFixed(0)}% · throughput and p95
              CV ≤ {(form.capacityLoadProtocol.max_throughput_cv * 100).toFixed(0)}%
            </dd>
          </div>
        </dl>
      ) : null}

      {!form.baselineLocked ? (
        <div className={styles.sloPresets} aria-label="Capacity SLO starting points">
          <div>
            <span>Optional starting points</span>
            <small>
              Choose explicitly, then review every value against your service objective.
            </small>
          </div>
          {CAPACITY_SLO_PRESETS.map((preset) => (
            <button key={preset.id} type="button" onClick={() => applyPreset(preset)}>
              <strong>{preset.label}</strong>
              <small>{preset.description}</small>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.sloGrid}>
        <label>
          <span>Required concurrency</span>
          <input
            type="number"
            min={1}
            max={form.concurrency}
            step={1}
            required
            value={form.capacitySLOInput.requiredConcurrency}
            disabled={form.baselineLocked}
            onChange={(event) =>
              form.setCapacitySLOField('requiredConcurrency', event.target.value)
            }
          />
          <small>G7 requires the qualified envelope to reach at least this level.</small>
        </label>
        <label>
          <span>Maximum p95 latency</span>
          <div className={styles.unitInput}>
            <input
              type="number"
              min="0.1"
              step="0.1"
              required
              value={form.capacitySLOInput.maxLatencyP95MS}
              disabled={form.baselineLocked}
              onChange={(event) => form.setCapacitySLOField('maxLatencyP95MS', event.target.value)}
            />
            <span>ms</span>
          </div>
          <small>Measured independently at every concurrency level.</small>
        </label>
        <label>
          <span>Maximum error rate</span>
          <div className={styles.unitInput}>
            <input
              type="number"
              min={0}
              max="0.999999"
              step="0.001"
              required
              value={form.capacitySLOInput.maxErrorRate}
              disabled={form.baselineLocked}
              onChange={(event) => form.setCapacitySLOField('maxErrorRate', event.target.value)}
            />
            <span>ratio</span>
          </div>
          <small>Use 0.01 for a one-percent request error budget.</small>
        </label>
        <label>
          <span>Minimum throughput</span>
          <div className={styles.unitInput}>
            <input
              type="number"
              min="0.1"
              step="0.1"
              required
              value={form.capacitySLOInput.minThroughputRPS}
              disabled={form.baselineLocked}
              onChange={(event) => form.setCapacitySLOField('minThroughputRPS', event.target.value)}
            />
            <span>req/s</span>
          </div>
          <small>Applies at and above the required concurrency.</small>
        </label>
        <label>
          <span>Minimum scaling efficiency</span>
          <div className={styles.unitInput}>
            <input
              type="number"
              min="0.01"
              max={1}
              step="0.01"
              required
              value={form.capacitySLOInput.minThroughputScalingEfficiency}
              disabled={form.baselineLocked}
              onChange={(event) =>
                form.setCapacitySLOField('minThroughputScalingEfficiency', event.target.value)
              }
            />
            <span>ratio</span>
          </div>
          <small>The frozen protocol defines how scaling efficiency is measured.</small>
        </label>
      </div>
    </section>
  )
}
