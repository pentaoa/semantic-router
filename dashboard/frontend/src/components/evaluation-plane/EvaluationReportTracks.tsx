import type { EvaluationReport } from '../../types/evaluationReport'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { RunStatusBadge } from './EvaluationPrimitives'
import styles from './EvaluationReportLayout.module.css'
import tableStyles from './EvaluationReportTable.module.css'

export default function EvaluationReportTracks({ report }: { report: EvaluationReport }) {
  return (
    <section className={styles.section} aria-labelledby="report-tracks-title">
      <div className={styles.sectionHeader}>
        <div>
          <span className={styles.eyebrow}>Verified track scope</span>
          <h3 id="report-tracks-title">Track observations</h3>
          <p>Track status and coverage are bound to the server attestation.</p>
        </div>
        <span>{report.tracks.length} selected tracks</span>
      </div>
      <div
        className={tableStyles.tableScroll}
        role="region"
        tabIndex={0}
        aria-label="Scrollable evaluation track observations"
      >
        <table className={tableStyles.table}>
          <caption>Observation state and coverage by selected evaluation track</caption>
          <thead>
            <tr>
              <th scope="col">Track</th>
              <th scope="col">Observation</th>
              <th scope="col">Coverage</th>
              <th scope="col">Evidence</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            {report.tracks.map((track) => (
              <tr key={track.track_id}>
                <th scope="row">{TRACK_PRESENTATION[track.track_id].label}</th>
                <td>
                  <RunStatusBadge status={track.status} />
                </td>
                <td>
                  {track.coverage.evaluated}/{track.coverage.total} ·{' '}
                  {Math.round(track.coverage.fraction * 100)}%
                  {track.coverage.unavailable
                    ? ` · ${track.coverage.unavailable} not measured`
                    : ''}
                </td>
                <td>{track.evidence_level}</td>
                <td>{track.error || track.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
