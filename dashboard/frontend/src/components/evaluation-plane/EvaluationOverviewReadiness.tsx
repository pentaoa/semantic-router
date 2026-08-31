import type { EvaluationRun } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import type { EvaluationView } from './EvaluationNavigation'
import styles from './EvaluationOverview.module.css'
import type { EvaluationOverviewModel } from './evaluationOverview'
import { EvaluationActionButton, GateVerdictBadge } from './EvaluationPrimitives'
import planeStyles from './EvaluationPlane.module.css'

interface EvaluationOverviewReadinessProps {
  model: EvaluationOverviewModel
  runs: EvaluationRun[]
  totalRuns: number
  hasMoreRuns: boolean
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  reportLoading: boolean
  onNavigate: (view: EvaluationView) => void
}

export default function EvaluationOverviewReadiness({
  model,
  runs,
  totalRuns,
  hasMoreRuns,
  runLedgerAvailable,
  runLedgerComplete,
  reportLoading,
  onNavigate,
}: EvaluationOverviewReadinessProps) {
  return (
    <>
      <section className={styles.readiness} aria-labelledby="evaluation-readiness-title">
        <div className={styles.readinessCopy}>
          <span className={planeStyles.eyebrow}>Decision readiness</span>
          <h2 id="evaluation-readiness-title">
            {model.latestEvidenceName || 'Establish the first evidence baseline'}
          </h2>
          <p>
            {model.hasLatestReport
              ? model.isDiagnostic
                ? 'This server-attested E0 report exposes a bounded set of independently reduced diagnostics. Promotion remains withheld until native benchmark and execution receipts qualify the claim.'
                : 'Review required blockers and measured outcomes before changing the production recipe or model pool.'
              : !runLedgerAvailable
                ? 'Run history is unavailable. Retry the ledger before selecting baselines or drawing conclusions from prior evidence.'
                : reportLoading && model.hasRequestedReportRun
                  ? 'Loading the newest completed report and its server attestation. No decision state is inferred while evidence is in flight.'
                  : 'Create a bounded replay or live run. The plane keeps missing evidence explicit and never promotes an unmeasured gate.'}
          </p>
        </div>
        <div className={styles.readinessActions}>
          {model.latestVerdict ? (
            <GateVerdictBadge verdict={model.latestVerdict} disposition="required" />
          ) : null}
          <EvaluationActionButton type="button" variant="primary" onClick={() => onNavigate('new')}>
            New experiment
          </EvaluationActionButton>
          <EvaluationActionButton type="button" onClick={() => onNavigate('runs')}>
            Inspect runs
          </EvaluationActionButton>
        </div>
      </section>

      <dl className={styles.statusStrip} aria-label="Evaluation plane status">
        <div>
          <dt>
            {hasMoreRuns
              ? 'Loaded runs'
              : !runLedgerAvailable
                ? 'Run ledger'
                : runLedgerComplete
                  ? 'Runs'
                  : 'Visible runs'}
          </dt>
          <dd>
            {!runLedgerAvailable ? '—' : hasMoreRuns ? `${runs.length}/${totalRuns}` : runs.length}
          </dd>
          <span>
            {!runLedgerAvailable
              ? 'Unavailable'
              : runLedgerComplete
                ? `${model.running} active loaded`
                : 'Ledger incomplete'}
          </span>
        </div>
        <div>
          <dt>{hasMoreRuns ? 'Completed loaded' : 'Completed'}</dt>
          <dd>{runLedgerAvailable ? model.completed : '—'}</dd>
          <span>
            {!runLedgerAvailable
              ? 'Run ledger unavailable'
              : model.latestRun
                ? formatDateTime(model.latestRun.created_at)
                : 'No history yet'}
          </span>
        </div>
        <div>
          <dt>{hasMoreRuns ? 'Failures loaded' : 'Failures'}</dt>
          <dd>{runLedgerAvailable ? model.failed : '—'}</dd>
          <span>{hasMoreRuns ? 'Among loaded runs' : 'Execution failures only'}</span>
        </div>
        <div>
          <dt>Required blockers</dt>
          <dd>{model.hasLatestReport ? model.requiredBlockers : '—'}</dd>
          <span>Failed or needs evidence</span>
        </div>
      </dl>
    </>
  )
}
