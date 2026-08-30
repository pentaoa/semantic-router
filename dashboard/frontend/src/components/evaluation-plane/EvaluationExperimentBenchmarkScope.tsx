import type { EvaluationCatalog } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { compatibleSuiteEmptyReason } from './evaluationExperiment'
import type { EvaluationExperimentFormModel } from './useEvaluationExperimentForm'
import EvaluationExperimentSectionHeading from './EvaluationExperimentSectionHeading'
import styles from './EvaluationExperimentBenchmarkScope.module.css'
import noticeStyles from './EvaluationExperimentNotice.module.css'
import sectionStyles from './EvaluationExperimentSection.module.css'

interface EvaluationExperimentBenchmarkScopeProps {
  catalog: EvaluationCatalog
  form: EvaluationExperimentFormModel
}

export default function EvaluationExperimentBenchmarkScope({
  catalog,
  form,
}: EvaluationExperimentBenchmarkScopeProps) {
  return (
    <>
      <section className={sectionStyles.formSection}>
        <EvaluationExperimentSectionHeading
          index="03"
          title="Benchmark suites"
          description="Select versioned workloads, then refine the tracks executed by this run."
        />
        {form.compatibleSuites.length ? (
          <div className={styles.catalogGrid}>
            {form.compatibleSuites.map((suite) => (
              <label
                key={suite.id}
                className={`${styles.catalogCard} ${form.suiteIDs.includes(suite.id) ? styles.active : ''}`}
              >
                <input
                  type="checkbox"
                  checked={form.suiteIDs.includes(suite.id)}
                  disabled={form.baselineLocked}
                  onChange={() => form.toggleSuite(suite.id)}
                />
                <span>
                  <strong>{suite.name}</strong>
                  <small>{suite.description}</small>
                  <em>
                    Catalog class {suite.evidence_level} · sealed per track after execution
                    {suite.case_count ? ` · ${suite.case_count} cases` : ''}
                    {suite.revision ? ` · ${suite.revision}` : ''}
                  </em>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className={noticeStyles.contractWarning} role="status">
            {compatibleSuiteEmptyReason(catalog, form.targetID, form.mode)}
          </div>
        )}
      </section>

      <section className={sectionStyles.formSection}>
        <EvaluationExperimentSectionHeading
          index="04"
          title="Evaluation tracks"
          description="Each track reports its own status, metrics, evidence, and gates."
        />
        {form.selectableTrackIDs.length === 0 ? (
          <div className={noticeStyles.contractWarning} role="status">
            {form.suiteIDs.length === 0
              ? 'Select a compatible benchmark suite to make its tracks available.'
              : 'The selected suites do not expose any executable tracks for this target and mode.'}
          </div>
        ) : null}
        <div className={styles.trackGrid}>
          {catalog.tracks.map((track) => {
            const targetSupportsTrack = form.availableTrackIDs.includes(track.id)
            const available = form.selectableTrackIDs.includes(track.id)
            return (
              <label
                key={track.id}
                className={`${styles.trackCard} ${form.trackIDs.includes(track.id) ? styles.active : ''} ${!available ? styles.disabled : ''}`}
              >
                <input
                  type="checkbox"
                  checked={form.trackIDs.includes(track.id)}
                  disabled={form.baselineLocked || !available}
                  onChange={() => form.toggleTrack(track.id)}
                />
                <span>
                  <strong>{TRACK_PRESENTATION[track.id].label}</strong>
                  <small>{track.description}</small>
                  <em>
                    {available
                      ? `${track.metrics.length} metrics`
                      : !targetSupportsTrack
                        ? `Not supported for ${form.mode} on this target`
                        : 'Not included by the selected suites'}
                  </em>
                </span>
              </label>
            )
          })}
        </div>
      </section>
    </>
  )
}
