import type { EvaluationRunLedgerWarning } from '../types/evaluationPlane'
import styles from './EvaluationPage.module.css'

interface EvaluationPageStatusProps {
  readonlyLoading: boolean
  serverReadonly: boolean
  hasCatalog: boolean
  catalogError: string | null
  runsError: string | null
  runsLoaded: boolean
  refreshing: boolean
  runLedgerComplete: boolean
  runLedgerWarningCount: number
  runLedgerWarnings: EvaluationRunLedgerWarning[]
  mutationError: string | null
  onRefresh: () => void
  onClearMutationError: () => void
}

export default function EvaluationPageStatus({
  readonlyLoading,
  serverReadonly,
  hasCatalog,
  catalogError,
  runsError,
  runsLoaded,
  refreshing,
  runLedgerComplete,
  runLedgerWarningCount,
  runLedgerWarnings,
  mutationError,
  onRefresh,
  onClearMutationError,
}: EvaluationPageStatusProps) {
  const refreshIssue = [
    catalogError
      ? `Catalog refresh failed; showing the last loaded catalog. ${catalogError}`
      : null,
    runsError
      ? runsLoaded
        ? `Run refresh failed; showing the last loaded run state. ${runsError}`
        : `The run ledger could not be loaded. ${runsError}`
      : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      {!readonlyLoading && serverReadonly ? (
        <div className={styles.readonlyBanner} role="status">
          Evaluation evidence remains readable. Server read-only policy disables creation,
          execution, cancellation, and deletion.
        </div>
      ) : null}
      {hasCatalog && (catalogError || runsError) ? (
        <div className={styles.staleBanner} role="status">
          <span>{refreshIssue}</span>
          <button type="button" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Retrying…' : 'Retry refresh'}
          </button>
        </div>
      ) : null}
      {runsLoaded && !runLedgerComplete && runLedgerWarningCount > 0 ? (
        <div className={styles.ledgerBanner} role="alert">
          <div>
            <strong>Run ledger incomplete</strong>
            <span>
              {runLedgerWarningCount} durable run bundle
              {runLedgerWarningCount === 1 ? ' is' : 's are'} quarantined. Visible runs remain
              inspectable, but baseline selection and comparison conclusions are blocked.
            </span>
            {runLedgerWarnings.length < runLedgerWarningCount ? (
              <small>
                Showing {runLedgerWarnings.length} of {runLedgerWarningCount} warning details
                returned by the ledger.
              </small>
            ) : null}
          </div>
          {runLedgerWarnings.length ? (
            <ul aria-label="Quarantined run evidence">
              {runLedgerWarnings.map((warning) => (
                <li key={`${warning.code}-${warning.evidence_id}-${warning.evidence_file}`}>
                  <span className={styles.evidenceIdentity}>
                    <small>Evidence ID</small>
                    <code>{warning.evidence_id}</code>
                  </span>
                  <span>
                    {warning.evidence_file}: {warning.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {mutationError ? (
        <div className={styles.errorBanner} role="alert">
          <span>{mutationError}</span>
          <button type="button" onClick={onClearMutationError}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  )
}
