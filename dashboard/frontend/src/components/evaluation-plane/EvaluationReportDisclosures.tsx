import type { EvaluationReport } from '../../types/evaluationReport'
import { formatDateTime } from '../../utils/dateTime'
import {
  getEvaluationArtifactURL,
  isDownloadableEvaluationArtifact,
} from '../../utils/evaluationPlaneApi'
import EvaluationGateList from './EvaluationGateList'
import { formatMetric } from './evaluationPresentation'
import reportStyles from './EvaluationReportLayout.module.css'
import styles from './EvaluationReportDisclosures.module.css'

function presentCount(value: number | undefined, suffix: string): string {
  return typeof value === 'number'
    ? `${new Intl.NumberFormat().format(value)} ${suffix}`
    : 'Not recorded'
}

export default function EvaluationReportDisclosures({ report }: { report: EvaluationReport }) {
  const gateContractVersion = report.gates[0]?.contract_version || 'not recorded'

  return (
    <>
      <details className={styles.disclosure}>
        <summary>
          All promotion gates <span>{report.gates.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <EvaluationGateList gates={report.gates} />
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Verified cost ledgers <span>3 ledgers</span>
        </summary>
        <div className={styles.disclosureBody}>
          <p className={reportStyles.scopeCopy}>
            Cost aggregates are bound to the server attestation.
          </p>
          <div className={styles.ledgerGrid}>
            {Object.entries(report.costs).map(([name, ledger]) => (
              <article key={name}>
                <span>{name.replace(/_/g, ' ')}</span>
                <strong>
                  {formatMetric({ value: ledger.amount, unit: ledger.currency.toLowerCase() })}
                </strong>
                <small>
                  {presentCount(ledger.input_tokens, 'input tokens')} ·{' '}
                  {presentCount(ledger.output_tokens, 'output tokens')}
                  {typeof ledger.gpu_seconds === 'number'
                    ? ` · ${ledger.gpu_seconds.toFixed(1)} GPU seconds`
                    : ''}
                  {typeof ledger.energy_kwh === 'number'
                    ? ` · ${ledger.energy_kwh.toFixed(2)} kWh`
                    : ''}
                </small>
              </article>
            ))}
          </div>
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Diagnostic findings <span>{report.recommendations.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <p className={reportStyles.scopeCopy}>
            These are worker-derived rule-based diagnostics, not server-reduced or benchmark-native
            causal conclusions.
          </p>
          {report.recommendations.length ? (
            <ol className={styles.recommendations}>
              {report.recommendations.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          ) : (
            <p className={reportStyles.empty}>No diagnostic findings were generated.</p>
          )}
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Provenance and reproducibility <span>{gateContractVersion}</span>
        </summary>
        <div className={styles.disclosureBody}>
          <dl className={styles.provenance}>
            <div>
              <dt>Generated</dt>
              <dd>{formatDateTime(report.provenance.generated_at)}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>
                <code>{report.provenance.target_id}</code>
              </dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd>{report.provenance.seed}</dd>
            </div>
            <div>
              <dt>Gate contract</dt>
              <dd>
                <code>{gateContractVersion}</code>
              </dd>
            </div>
            <div>
              <dt>Server attestation</dt>
              <dd>
                <code>{report.attestation_revision}</code>
              </dd>
            </div>
            <div>
              <dt>Code revision</dt>
              <dd>
                <code>{report.provenance.code_revision || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Workload snapshot</dt>
              <dd>
                <code>{report.provenance.workload_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Policy snapshot</dt>
              <dd>
                <code>{report.provenance.policy_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Policy binding</dt>
              <dd>
                <code>{report.provenance.binding_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Pool snapshot</dt>
              <dd>
                <code>{report.provenance.pool_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>
                <code>{report.provenance.environment_snapshot_digest || 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Redaction</dt>
              <dd>{report.provenance.redaction_policy || 'Not recorded'}</dd>
            </div>
            <div className={styles.provenanceWide}>
              <dt>Benchmark revisions</dt>
              <dd>
                {Object.entries(report.provenance.benchmark_revisions || {}).length
                  ? Object.entries(report.provenance.benchmark_revisions || {}).map(
                      ([name, revision]) => (
                        <span key={name}>
                          {name}: <code>{revision}</code>
                        </span>
                      ),
                    )
                  : 'Not recorded'}
              </dd>
            </div>
          </dl>
        </div>
      </details>

      <details className={styles.disclosure}>
        <summary>
          Evidence artifacts <span>{report.artifacts.length}</span>
        </summary>
        <div className={styles.disclosureBody}>
          {report.artifacts.length ? (
            <div className={styles.artifactList}>
              {report.artifacts.map((artifact) => (
                <article key={artifact.id}>
                  <div>
                    <strong>{artifact.name}</strong>
                    <span>
                      {artifact.kind} · {artifact.media_type || 'media type not recorded'}
                    </span>
                  </div>
                  {isDownloadableEvaluationArtifact(artifact) ? (
                    <a
                      href={getEvaluationArtifactURL(report.run.id, artifact.id)}
                      aria-label={`Download ${artifact.name}`}
                    >
                      Download
                    </a>
                  ) : (
                    <code>{artifact.digest || artifact.id}</code>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className={reportStyles.empty}>No report artifacts were recorded.</p>
          )}
        </div>
      </details>
    </>
  )
}
