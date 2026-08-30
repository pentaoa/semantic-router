import { useMemo, useState } from 'react'

import type { EvaluationCatalog, EvaluationTrackId } from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import styles from './EvaluationMethodReadiness.module.css'
import planeStyles from './EvaluationPlane.module.css'
import tableStyles from './EvaluationTable.module.css'

const METHOD_STATUS_LABELS = {
  configured: 'Ready to collect',
  data_required: 'Data required',
} as const

const EVIDENCE_SOURCE_LABELS = {
  diagnostic_fixture: 'Diagnostic fixture',
  live_runtime: 'Live runtime',
  normalized_import: 'Normalized import · native run unattested',
  server_brokered_live: 'Server-brokered live · G4',
  live_production: 'Production ledger',
} as const

type MethodStatus = keyof typeof METHOD_STATUS_LABELS

export default function EvaluationMethodReadiness({ catalog }: { catalog: EvaluationCatalog }) {
  const [query, setQuery] = useState('')
  const [track, setTrack] = useState<EvaluationTrackId | 'all'>('all')
  const [status, setStatus] = useState<MethodStatus | 'all'>('all')
  const methods = useMemo(
    () =>
      catalog.suites.flatMap((suite) =>
        suite.methods.map((method) => ({ method, suiteID: suite.id, suiteName: suite.name })),
      ),
    [catalog.suites],
  )
  const visibleMethods = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return methods.filter(
      ({ method, suiteID, suiteName }) =>
        (track === 'all' || method.track_id === track) &&
        (status === 'all' || method.status === status) &&
        (!normalizedQuery ||
          [
            method.id,
            suiteID,
            suiteName,
            method.track_id,
            method.evidence_source,
            method.reason || '',
            ...method.qualified_gate_ids,
          ]
            .join(' ')
            .toLowerCase()
            .includes(normalizedQuery)),
    )
  }, [methods, query, status, track])
  const counts = useMemo(
    () =>
      methods.reduce(
        (result, { method }) => ({ ...result, [method.status]: result[method.status] + 1 }),
        { configured: 0, data_required: 0 } satisfies Record<MethodStatus, number>,
      ),
    [methods],
  )

  return (
    <section
      className={`${planeStyles.surface} ${planeStyles.workspaceSurface}`}
      aria-labelledby="evaluation-methods-title"
    >
      <header className={planeStyles.surfaceHeader}>
        <div>
          <span className={planeStyles.eyebrow}>Evaluation method inventory</span>
          <h2 id="evaluation-methods-title">Method readiness</h2>
          <p>
            Each row declares a server capability and the gates it can supply. Qualification happens
            only on a sealed run receipt after the required evidence and reducer checks pass. A
            normalized import may be parser-verified, but remains E0 until a server-owned receipt
            proves the upstream native benchmark run.
          </p>
        </div>
        <div className={styles.methodSummary} aria-label="Method readiness summary">
          <span>
            <strong>{counts.configured}</strong> ready to collect
          </span>
          <span>
            <strong>{counts.data_required}</strong> need evidence
          </span>
        </div>
      </header>

      <div className={styles.methodFilters}>
        <label className={styles.methodSearch}>
          <span>Search catalog</span>
          <input
            type="search"
            aria-label="Search evaluation methods"
            value={query}
            placeholder="Method, suite, gate, source…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Track</span>
          <select
            aria-label="Method track filter"
            value={track}
            onChange={(event) => setTrack(event.target.value as EvaluationTrackId | 'all')}
          >
            <option value="all">All tracks</option>
            {EVALUATION_TRACK_IDS.map((trackID) => (
              <option key={trackID} value={trackID}>
                {TRACK_PRESENTATION[trackID].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Readiness</span>
          <select
            aria-label="Method readiness filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as MethodStatus | 'all')}
          >
            <option value="all">All states</option>
            {Object.entries(METHOD_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.resultCount} role="status">
          Showing {visibleMethods.length} of {methods.length} declared methods
        </span>
      </div>

      <div
        className={`${tableStyles.tableScroll} ${styles.methodTableFrame}`}
        role="region"
        tabIndex={0}
        aria-label="Scrollable evaluation method readiness"
      >
        <table className={`${tableStyles.readinessTable} ${styles.methodTable}`}>
          <caption>Server-declared evaluation methods and collection readiness</caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Track</th>
              <th scope="col">Evidence source</th>
              <th scope="col">Gate capability</th>
              <th scope="col">Readiness</th>
            </tr>
          </thead>
          <tbody>
            {visibleMethods.map(({ method, suiteID, suiteName }) => (
              <tr key={`${suiteID}:${method.id}`}>
                <th scope="row">
                  <strong>{method.id}</strong>
                  <span>{suiteName}</span>
                </th>
                <td>{TRACK_PRESENTATION[method.track_id].label}</td>
                <td>{EVIDENCE_SOURCE_LABELS[method.evidence_source]}</td>
                <td>
                  {method.qualified_gate_ids.length > 0
                    ? method.qualified_gate_ids.join(' · ')
                    : 'Exploratory only'}
                </td>
                <td>
                  <span className={styles.methodStatus} data-state={method.status}>
                    {METHOD_STATUS_LABELS[method.status]}
                  </span>
                  {method.reason ? (
                    <small className={styles.methodReason}>{method.reason}</small>
                  ) : null}
                </td>
              </tr>
            ))}
            {visibleMethods.length === 0 ? (
              <tr>
                <td className={styles.methodEmpty} colSpan={5}>
                  No methods match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
