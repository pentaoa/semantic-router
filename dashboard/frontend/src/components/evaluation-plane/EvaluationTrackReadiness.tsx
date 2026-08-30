import type { EvaluationCatalog } from '../../types/evaluationPlane'
import type { EvaluationReport } from '../../types/evaluationReport'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import EvaluationMethodReadiness from './EvaluationMethodReadiness'
import { RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationPlane.module.css'
import tableStyles from './EvaluationTable.module.css'

interface EvaluationTrackReadinessProps {
  catalog: EvaluationCatalog
  latestReport: EvaluationReport | null
}

export default function EvaluationTrackReadiness({
  catalog,
  latestReport,
}: EvaluationTrackReadinessProps) {
  return (
    <>
      <section
        className={`${styles.surface} ${styles.workspaceSurface}`}
        aria-labelledby="track-readiness-title"
      >
        <header className={styles.surfaceHeader}>
          <div>
            <span className={styles.eyebrow}>Coverage and qualification</span>
            <h2 id="track-readiness-title">Track readiness</h2>
            <p>
              Contract-supported evidence classes and the latest sealed observation are separate
              states. The active executor determines which class a run can actually earn.
            </p>
          </div>
          <div className={styles.catalogFacts} aria-label="Catalog contracts">
            <span>Schema {catalog.schema_version}</span>
            <span>{catalog.gate_contract_version}</span>
          </div>
        </header>
        <div
          className={`${tableStyles.tableScroll} ${styles.catalogTableFrame}`}
          role="region"
          tabIndex={0}
          aria-label="Scrollable evaluation track readiness"
        >
          <table className={tableStyles.readinessTable}>
            <caption>Evaluation track contract and latest evidence readiness</caption>
            <thead>
              <tr>
                <th scope="col">Track</th>
                <th scope="col">Contract</th>
                <th scope="col">Latest observation</th>
                <th scope="col">Contract levels</th>
              </tr>
            </thead>
            <tbody>
              {EVALUATION_TRACK_IDS.map((trackID) => {
                const contract = catalog.tracks.find((track) => track.id === trackID)!
                const observation = latestReport?.tracks.find((track) => track.track_id === trackID)
                return (
                  <tr key={trackID}>
                    <th scope="row">
                      <strong>{TRACK_PRESENTATION[trackID].label}</strong>
                      <span>{contract.description}</span>
                    </th>
                    <td>{contract.metrics.length} declared metrics</td>
                    <td>
                      {observation ? (
                        <span className={tableStyles.inlineStatus}>
                          <RunStatusBadge status={observation.status} />
                          {observation.evidence_level} · {observation.coverage.evaluated}/
                          {observation.coverage.total} observations ·{' '}
                          {Math.round(observation.coverage.fraction * 100)}%
                          {observation.coverage.unavailable
                            ? ` · ${observation.coverage.unavailable} not measured`
                            : ''}
                          {' · server-attested'}
                        </span>
                      ) : (
                        'Not collected in latest run · select this track in a new experiment'
                      )}
                    </td>
                    <td>{contract.evidence_levels.join(' · ')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <EvaluationMethodReadiness catalog={catalog} />
    </>
  )
}
