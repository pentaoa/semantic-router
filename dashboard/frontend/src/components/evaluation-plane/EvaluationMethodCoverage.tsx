import { useMemo, useState } from 'react'

import type { EvaluationCatalog, EvaluationTrackId } from '../../types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../types/evaluationPlane'
import ProductIcon from '../ProductIcon'
import { EVALUATION_METHOD_FAMILIES, REGISTERED_BENCHMARK_COUNT } from './evaluationMethodology'
import styles from './EvaluationPlane.module.css'

export default function EvaluationMethodCoverage({ catalog }: { catalog: EvaluationCatalog }) {
  const [track, setTrack] = useState<EvaluationTrackId | 'all'>('all')
  const families = useMemo(
    () =>
      track === 'all'
        ? EVALUATION_METHOD_FAMILIES
        : EVALUATION_METHOD_FAMILIES.filter((family) => family.trackIDs.includes(track)),
    [track],
  )

  return (
    <section className={styles.surface} aria-labelledby="evaluation-methods-title">
      <header className={styles.surfaceHeader}>
        <div>
          <span className={styles.eyebrow}>Benchmark method coverage</span>
          <h2 id="evaluation-methods-title">What the plane knows how to measure</h2>
          <p>
            Nine method families preserve the distinct ideas from {REGISTERED_BENCHMARK_COUNT}{' '}
            pinned benchmark contracts. Registration describes the contract; only an installed,
            attested suite can raise a scientific claim above E0.
          </p>
        </div>
        <label className={styles.compactSelect}>
          <span>Filter by track</span>
          <select
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
      </header>

      <div className={styles.methodList}>
        {families.map((family) => (
          <details key={family.id} className={styles.methodRow}>
            <summary>
              <div className={styles.methodIdentity}>
                <strong>{family.name}</strong>
                <span>{family.benchmarks.join(' · ')}</span>
              </div>
              <div className={styles.methodTracks} aria-label="Covered evaluation tracks">
                {family.trackIDs.map((trackID) => (
                  <span key={trackID}>{TRACK_PRESENTATION[trackID].label}</span>
                ))}
              </div>
              <ProductIcon name="chevron-down" />
            </summary>
            <dl className={styles.methodDetails}>
              <div>
                <dt>Native benchmark method</dt>
                <dd>{family.method}</dd>
              </div>
              <div>
                <dt>Current implementation</dt>
                <dd>{family.currentImplementation}</dd>
              </div>
              <div>
                <dt>Missing for qualification</dt>
                <dd>{family.missingForQualification}</dd>
              </div>
            </dl>
          </details>
        ))}
      </div>

      <footer className={styles.methodFooter}>
        <span>{catalog.suites.length} suites are currently exposed by this Dashboard.</span>
        <span>
          {catalog.targets.filter((target) => target.healthy !== false).length} configured execution
          targets; live health is verified only by a run.
        </span>
      </footer>
    </section>
  )
}
