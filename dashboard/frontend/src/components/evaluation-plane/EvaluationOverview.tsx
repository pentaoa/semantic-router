import type {
  EvaluationCatalog,
  EvaluationReport,
  EvaluationRun,
} from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import EvaluationMethodCoverage from './EvaluationMethodCoverage'
import {
  effectiveGateVerdict,
  formatMetric,
  hasServerEvaluationAttestation,
  legacyEvaluationEvidenceLabel,
  selectHeadlineMetrics,
} from './evaluationPresentation'
import type { EvaluationView } from './EvaluationNavigation'
import { GateVerdictBadge, RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationPlane.module.css'

interface EvaluationOverviewProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  runLedgerComplete: boolean
  latestReport: EvaluationReport | null
  reportLoading: boolean
  reportError: string | null
  onRetryReport: () => void
  onNavigate: (view: EvaluationView) => void
}

export default function EvaluationOverview({
  catalog,
  runs,
  runLedgerComplete,
  latestReport,
  reportLoading,
  reportError,
  onRetryReport,
  onNavigate,
}: EvaluationOverviewProps) {
  const running = runs.filter((run) => run.status === 'running').length
  const completed = runs.filter((run) => run.status === 'completed').length
  const failed = runs.filter((run) => run.status === 'failed').length
  const latestRun = runs[0]
  const latestReportRun = latestReport
    ? runs.find((run) => run.id === latestReport.run.id) || null
    : null
  const latestReportName = latestReportRun?.name || latestReport?.run.name
  const isDiagnostic = latestReport?.run.evidence_level === 'E0'
  const serverAttested = latestReport ? hasServerEvaluationAttestation(latestReport) : false
  const isServerAttestedDiagnostic = isDiagnostic && serverAttested
  const isLegacyReport = Boolean(latestReport) && !serverAttested
  const legacyEvidenceLabel = latestReport
    ? legacyEvaluationEvidenceLabel(latestReport.run.evidence_level)
    : null
  const latestVerdict = latestReport
    ? effectiveGateVerdict(latestReport.summary.verdict, latestReport.gates)
    : null
  const headlines = latestReport ? selectHeadlineMetrics(latestReport) : []
  const requiredBlockers = latestReport
    ? latestReport.gates.filter(
        (gate) =>
          gate.disposition === 'required' &&
          (gate.verdict === 'fail' || gate.verdict === 'unavailable'),
      ).length
    : 0

  return (
    <div className={styles.sectionStack}>
      <section className={styles.readiness} aria-labelledby="evaluation-readiness-title">
        <div className={styles.readinessCopy}>
          <span className={styles.eyebrow}>Decision readiness</span>
          <h2 id="evaluation-readiness-title">
            {latestReportName || 'Establish the first evidence baseline'}
          </h2>
          <p>
            {latestReport
              ? isLegacyReport
                ? `${legacyEvidenceLabel}. The report remains readable for diagnostics, but it has no current server attestation and cannot support a promotion claim.`
                : isServerAttestedDiagnostic
                  ? 'This server-attested E0 report exposes a bounded set of independently reduced diagnostics. Promotion remains withheld until native benchmark and execution receipts qualify the claim.'
                  : 'Review required blockers and measured outcomes before changing the production recipe or model pool.'
              : 'Create a bounded replay or live run. The plane keeps missing evidence explicit and never promotes an unmeasured gate.'}
          </p>
        </div>
        <div className={styles.readinessActions}>
          {latestVerdict ? (
            <GateVerdictBadge verdict={latestVerdict} disposition="required" />
          ) : null}
          <button type="button" className={styles.primaryButton} onClick={() => onNavigate('new')}>
            New experiment
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onNavigate('runs')}
          >
            Inspect runs
          </button>
        </div>
      </section>

      <dl className={styles.statusStrip} aria-label="Evaluation plane status">
        <div>
          <dt>{runLedgerComplete ? 'Runs' : 'Visible runs'}</dt>
          <dd>{runs.length}</dd>
          <span>{runLedgerComplete ? `${running} active` : 'Ledger incomplete'}</span>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{completed}</dd>
          <span>{latestRun ? formatDateTime(latestRun.created_at) : 'No history yet'}</span>
        </div>
        <div>
          <dt>Failures</dt>
          <dd>{failed}</dd>
          <span>Execution failures only</span>
        </div>
        <div>
          <dt>Required blockers</dt>
          <dd>{latestReport ? requiredBlockers : '—'}</dd>
          <span>Failed or needs evidence</span>
        </div>
      </dl>

      <section className={styles.surface} aria-labelledby="latest-evidence-title">
        <header className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>
              {runLedgerComplete ? 'Latest completed evidence' : 'Latest readable evidence'}
            </span>
            <h2 id="latest-evidence-title">{latestReportName || 'No completed report yet'}</h2>
            <p>
              {isLegacyReport
                ? `${legacyEvidenceLabel}. Headline elevation is withheld; the complete metric set remains in the report explorer.`
                : serverAttested
                  ? 'Only metrics reduced by the current server attestation are elevated here; the complete worker-derived metric set remains in the report explorer.'
                  : 'Headline elevation is withheld until the report carries a current server attestation.'}
            </p>
          </div>
          {latestReport ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => onNavigate('reports')}
            >
              Open full report
            </button>
          ) : null}
        </header>
        {reportLoading ? <p className={styles.emptyCopy}>Loading report summary…</p> : null}
        {reportError ? (
          <div className={styles.inlineError} role="alert">
            <div>
              <strong>Latest report could not be refreshed.</strong>
              <span>{reportError}</span>
            </div>
            <button type="button" onClick={onRetryReport}>
              Retry
            </button>
          </div>
        ) : null}
        {!reportLoading && !reportError && latestReport ? (
          headlines.length ? (
            <dl className={styles.headlineStrip}>
              {headlines.map((metric) => (
                <div key={`${metric.track_id || 'system'}-${metric.id}`}>
                  <dt>{metric.name}</dt>
                  <dd>{formatMetric(metric)}</dd>
                  <span>
                    {serverAttested ? `Server-reduced ${latestReport.run.evidence_level} · ` : ''}
                    {metric.track_id ? TRACK_PRESENTATION[metric.track_id].label : 'System'}
                  </span>
                </div>
              ))}
            </dl>
          ) : (
            <div className={styles.scopeNotice}>
              <strong>
                {isLegacyReport
                  ? legacyEvidenceLabel
                  : isDiagnostic
                    ? 'Promotion summary withheld — server-attested diagnostic E0'
                    : 'No measured headline applies to this run'}
              </strong>
              <span>
                {isLegacyReport
                  ? 'No metric is elevated from this legacy report. Inspect the complete metric explorer and gates as diagnostic evidence only.'
                  : isDiagnostic
                    ? 'No independently reduced diagnostic headline matches this run scope. Inspect the metric explorer and gates for the complete E0 observations and exact evidence gap.'
                    : 'Inspect the full report for the measured outcomes and exact evidence scope.'}
              </span>
            </div>
          )
        ) : null}
        {!reportLoading && !reportError && !latestReport ? (
          <div className={styles.emptyState}>
            <p>Complete a run to establish a report.</p>
            {latestRun ? <RunStatusBadge status={latestRun.status} /> : null}
          </div>
        ) : null}
      </section>

      <section className={styles.surface} aria-labelledby="track-readiness-title">
        <header className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>Coverage and qualification</span>
            <h2 id="track-readiness-title">Track readiness</h2>
            <p>
              Contract presence, current observation, and scientific claim level are separate
              states.
            </p>
          </div>
          <div className={styles.chips}>
            <span className={styles.schemaBadge}>Schema {catalog.schema_version}</span>
            <span className={styles.schemaBadge}>{catalog.gate_contract_version}</span>
          </div>
        </header>
        <div className={styles.tableScroll}>
          <table className={styles.readinessTable}>
            <caption>Evaluation track contract and latest evidence readiness</caption>
            <thead>
              <tr>
                <th scope="col">Track</th>
                <th scope="col">Contract</th>
                <th scope="col">Latest observation</th>
                <th scope="col">Claim ceiling</th>
              </tr>
            </thead>
            <tbody>
              {EVALUATION_TRACK_IDS.map((trackID) => {
                const contract = catalog.tracks.find((track) => track.id === trackID)
                const observation = latestReport?.tracks.find((track) => track.track_id === trackID)
                return (
                  <tr key={trackID}>
                    <th scope="row">
                      <strong>{TRACK_PRESENTATION[trackID].label}</strong>
                      <span>
                        {contract?.description || TRACK_PRESENTATION[trackID].description}
                      </span>
                    </th>
                    <td>
                      {contract ? `${contract.metrics.length} declared metrics` : 'Not declared'}
                    </td>
                    <td>
                      {observation ? (
                        <span className={styles.inlineStatus}>
                          <RunStatusBadge status={observation.status} />
                          {Math.round(observation.coverage.fraction * 100)}% observed
                          {serverAttested
                            ? ' · server-attested'
                            : isLegacyReport
                              ? ' · integrity-only'
                              : ''}
                        </span>
                      ) : (
                        'No observation in latest run'
                      )}
                    </td>
                    <td>
                      {observation?.evidence_level ||
                        contract?.evidence_levels?.[0] ||
                        'E0 contract'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <EvaluationMethodCoverage catalog={catalog} />
    </div>
  )
}
