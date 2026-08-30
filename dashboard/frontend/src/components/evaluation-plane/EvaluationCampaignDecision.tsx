import { useEffect, useRef, useState } from 'react'

import type { EvaluationRun } from '../../types/evaluationPlane'
import type { EvaluationCampaign } from '../../types/evaluationCampaign'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import ProductIcon from '../ProductIcon'
import { GateVerdictBadge } from './EvaluationPrimitives'
import commonStyles from './EvaluationCampaign.module.css'
import styles from './EvaluationCampaignDecisionLayout.module.css'
import evidenceStyles from './EvaluationCampaignEvidence.module.css'
import gateStyles from './EvaluationCampaignGateDecision.module.css'
import pairedStyles from './EvaluationCampaignPairedEvidence.module.css'
import fidelityStyles from './EvaluationCampaignFidelityEvidence.module.css'

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function shortDigest(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`
}

function formatStatistic(value: number | undefined, signed = false): string {
  if (value === undefined) return '—'
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 4,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(value)
}

const PAIRED_STATISTIC_LABELS: Record<string, string> = {
  case_mean_quality: 'Quality non-inferiority',
  case_pool_oracle_quality: 'Pool oracle quality',
  pool_worst_arm_reliability: 'Worst-arm reliability',
  case_failure_fraction: 'Failure risk',
  case_all_arm_failure: 'All-arm failure risk',
  case_max_latency_relative_delta: 'Latency risk',
}

const ARM_COHORT_LABELS = {
  paired: 'Paired frozen arm',
  baseline_only: 'Removed arm',
  candidate_only: 'Added arm',
} as const

const PROMOTION_STATISTIC_LABELS: Record<string, string> = {
  'campaign.g3.candidate_normalized_regret': 'Candidate normalized regret',
  'campaign.g3.paired_normalized_regret_delta': 'Paired normalized-regret delta',
  'campaign.g3.no_information_frontier_lift': 'No-information frontier lift',
  'campaign.g3.joint_reliability': 'Joint reliability',
  'campaign.g3.all_arm_failure_rate': 'Pool availability',
}

function CopyableDigest({
  label,
  value,
  displayValue = value,
}: {
  label: string
  value: string
  displayValue?: string
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const actionLabel =
    copyState === 'copying'
      ? `Copying ${label} digest`
      : copyState === 'copied'
        ? `Copied ${label} digest`
        : copyState === 'failed'
          ? `Retry copy ${label} digest`
          : `Copy ${label} digest`

  const copy = async () => {
    setCopyState('copying')
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API is unavailable.')
      await navigator.clipboard.writeText(value)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <dd className={evidenceStyles.copyableDigest} title={value}>
      <span>{displayValue}</span>
      <button
        type="button"
        disabled={copyState === 'copying'}
        onClick={() => void copy()}
        title={actionLabel}
        aria-label={actionLabel}
      >
        <ProductIcon name={copyState === 'copied' ? 'check' : 'copy'} aria-hidden="true" />
      </button>
      <span className={commonStyles.srOnly} aria-live="polite">
        {copyState === 'copied'
          ? `${label} digest copied.`
          : copyState === 'failed'
            ? `${label} digest could not be copied.`
            : ''}
      </span>
    </dd>
  )
}

interface EvaluationCampaignDecisionProps {
  campaign: EvaluationCampaign
  runs: EvaluationRun[]
  onStartAnother: () => void
}

export default function EvaluationCampaignDecision({
  campaign,
  runs,
  onStartAnother,
}: EvaluationCampaignDecisionProps) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const runNames = new Map(runs.map((run) => [run.id, run.name]))
  const decision = campaign.decision
  const requiredGates = decision.gates.filter((gate) => gate.disposition === 'required')
  const passed = requiredGates.filter((gate) => gate.verdict === 'pass').length
  const failed = requiredGates.filter((gate) => gate.verdict === 'fail').length
  const unavailable = requiredGates.filter((gate) => gate.verdict === 'unavailable').length

  useEffect(() => {
    titleRef.current?.focus()
  }, [campaign.id])

  return (
    <article className={styles.decision} aria-labelledby="evaluation-campaign-decision-title">
      <header className={styles.decisionHero}>
        <div>
          <span className={commonStyles.eyebrow}>Server-attested promotion decision</span>
          <h3 id="evaluation-campaign-decision-title" ref={titleRef} tabIndex={-1}>
            {campaign.name}
          </h3>
          <p>{decision.summary}</p>
        </div>
        <div className={styles.decisionHeroActions}>
          <GateVerdictBadge verdict={decision.verdict} disposition="required" />
          <button type="button" className={commonStyles.secondaryButton} onClick={onStartAnother}>
            Build another campaign
          </button>
        </div>
      </header>

      <dl className={styles.decisionMeta} aria-label="Campaign decision identity">
        <div>
          <dt>Required gates</dt>
          <dd>
            {passed} pass · {failed} fail · {unavailable} unavailable
          </dd>
        </div>
        <div>
          <dt>Change profile</dt>
          <dd>{campaign.change_profile}</dd>
        </div>
        <div>
          <dt>Campaign digest</dt>
          <CopyableDigest
            label="campaign"
            value={campaign.manifest_digest}
            displayValue={shortDigest(campaign.manifest_digest)}
          />
        </div>
        <div>
          <dt>Decision digest</dt>
          <CopyableDigest
            label="decision"
            value={decision.decision_digest}
            displayValue={shortDigest(decision.decision_digest)}
          />
        </div>
      </dl>

      {decision.paired_live_evidence ? (
        <section className={styles.decisionSection} aria-labelledby="campaign-paired-live-title">
          <div className={styles.sectionHeader}>
            <div>
              <span className={commonStyles.eyebrow}>Controlled paired execution</span>
              <h4 id="campaign-paired-live-title">Baseline → candidate statistics</h4>
              <p>
                Case-aligned bootstrap intervals are recomputed from server-attested live records;
                shadow-risk rows remain diagnostics until production exposure evidence exists.
              </p>
            </div>
            <dl className={pairedStyles.pairedDigest}>
              <div>
                <dt>Evidence digest</dt>
                <CopyableDigest
                  label="paired live evidence"
                  value={decision.paired_live_evidence.digest}
                  displayValue={shortDigest(decision.paired_live_evidence.digest)}
                />
              </div>
            </dl>
          </div>
          <dl className={pairedStyles.pairedMeta} aria-label="Paired live evidence provenance">
            <div>
              <dt>Deployments</dt>
              <dd
                className={pairedStyles.deploymentPair}
                title={`${decision.paired_live_evidence.baseline_target_id} → ${decision.paired_live_evidence.candidate_target_id}`}
              >
                <span>{decision.paired_live_evidence.baseline_target_id}</span>
                <span className={pairedStyles.deploymentArrow} aria-hidden="true">
                  →
                </span>
                <span>{decision.paired_live_evidence.candidate_target_id}</span>
              </dd>
            </div>
            <div>
              <dt>Mixture</dt>
              <dd>{decision.paired_live_evidence.recipe_name}</dd>
            </div>
            <div>
              <dt>Tracks</dt>
              <dd>
                {decision.paired_live_evidence.track_ids
                  .map((trackID) => TRACK_PRESENTATION[trackID].label)
                  .join(' · ')}
              </dd>
            </div>
            <div>
              <dt>Bootstrap</dt>
              <dd>
                {decision.paired_live_evidence.bootstrap_samples.toLocaleString()} samples ·{' '}
                {Math.round(decision.paired_live_evidence.confidence_level * 100)}% CI
              </dd>
            </div>
            <div>
              <dt>Seed</dt>
              <dd>{decision.paired_live_evidence.seed}</dd>
            </div>
            <div>
              <dt>Pair protocol</dt>
              <dd>{decision.paired_live_evidence.controlled_pair_protocol}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd title={decision.paired_live_evidence.controlled_pair_session_id}>
                {decision.paired_live_evidence.controlled_pair_session_id}
              </dd>
            </div>
          </dl>
          <div className={pairedStyles.promotionBoundary}>
            <div className={pairedStyles.armReliabilityHeader}>
              <div>
                <span className={commonStyles.eyebrow}>Normative G3 boundary</span>
                <h5>Promotion statistics</h5>
              </div>
              <p>
                Absolute candidate quality, paired change, frontier lift, end-to-end reliability,
                and all-arm availability are evaluated together under the frozen server policy.
              </p>
            </div>
            <div
              className={pairedStyles.pairedTableFrame}
              role="region"
              aria-label="G3 promotion statistic matrix"
              tabIndex={0}
            >
              <table className={pairedStyles.pairedTable}>
                <caption className={commonStyles.srOnly}>G3 promotion statistics</caption>
                <thead>
                  <tr>
                    <th scope="col">Promotion measure</th>
                    <th scope="col">Estimate</th>
                    <th scope="col">Confidence interval</th>
                    <th scope="col">Threshold</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {decision.paired_live_evidence.promotion_statistics.map((statistic) => (
                    <tr key={statistic.id} data-verdict={statistic.verdict}>
                      <th scope="row">
                        <strong>{PROMOTION_STATISTIC_LABELS[statistic.id] || statistic.id}</strong>
                        <small title={statistic.id}>{statistic.id}</small>
                      </th>
                      <td>{formatStatistic(statistic.estimate)}</td>
                      <td>
                        {statistic.confidence_interval.length === 2
                          ? `[${formatStatistic(statistic.confidence_interval[0])}, ${formatStatistic(statistic.confidence_interval[1])}]`
                          : 'Inconclusive'}
                      </td>
                      <td>
                        {statistic.threshold.operator} {formatStatistic(statistic.threshold.value)}{' '}
                        {statistic.threshold.unit}
                      </td>
                      <td>
                        {statistic.sample_count}
                        {statistic.missing_cases ? ` · ${statistic.missing_cases} missing` : ''}
                      </td>
                      <td>
                        <GateVerdictBadge verdict={statistic.verdict} disposition="required" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className={pairedStyles.diagnosticBoundary}>
            <div className={pairedStyles.armReliabilityHeader}>
              <div>
                <span className={commonStyles.eyebrow}>Paired diagnostics</span>
                <h5>Track-level deltas</h5>
              </div>
              <p>
                Additional server-reduced statistics remain visible by their declared analysis unit,
                including newly introduced measures unknown to this client build.
              </p>
            </div>
            <div
              className={pairedStyles.pairedTableFrame}
              role="region"
              aria-label="Paired live statistic matrix"
              tabIndex={0}
            >
              <table className={pairedStyles.pairedTable}>
                <caption className={commonStyles.srOnly}>
                  Paired baseline and candidate statistics
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Track / measure</th>
                    <th scope="col">Baseline</th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Delta</th>
                    <th scope="col">Confidence interval</th>
                    <th scope="col">Pairs</th>
                    <th scope="col">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {decision.paired_live_evidence.statistics.map((statistic) => (
                    <tr key={statistic.id} data-verdict={statistic.verdict}>
                      <th scope="row">
                        <span>{TRACK_PRESENTATION[statistic.track_id].label}</span>
                        <strong>
                          {PAIRED_STATISTIC_LABELS[statistic.analysis_unit] ||
                            statistic.analysis_unit}
                        </strong>
                        <small title={statistic.id}>{statistic.id}</small>
                        <small>
                          {statistic.direction === 'higher_is_better' ? '≥' : '≤'} margin{' '}
                          {formatStatistic(statistic.margin)}
                        </small>
                      </th>
                      <td>{formatStatistic(statistic.baseline_value)}</td>
                      <td>{formatStatistic(statistic.candidate_value)}</td>
                      <td>{formatStatistic(statistic.delta, true)}</td>
                      <td>
                        <span>
                          Δ{' '}
                          {statistic.confidence_interval.length === 2
                            ? `[${formatStatistic(statistic.confidence_interval[0], true)}, ${formatStatistic(statistic.confidence_interval[1], true)}]`
                            : 'Inconclusive'}
                        </span>
                        {statistic.candidate_confidence_interval?.length === 2 ? (
                          <small>
                            Candidate [{formatStatistic(statistic.candidate_confidence_interval[0])}
                            , {formatStatistic(statistic.candidate_confidence_interval[1])}]
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {statistic.sample_count}
                        {statistic.missing_pairs ? ` · ${statistic.missing_pairs} missing` : ''}
                      </td>
                      <td>
                        <GateVerdictBadge verdict={statistic.verdict} disposition="required" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {decision.paired_live_evidence.model_pool_arm_reliability.length ? (
            <div className={pairedStyles.armReliabilitySection}>
              <div className={pairedStyles.armReliabilityHeader}>
                <div>
                  <span className={commonStyles.eyebrow}>Frozen model pool</span>
                  <h5>Per-arm failure boundaries</h5>
                </div>
                <p>
                  Every shared arm participates in paired promotion. An added arm's absolute
                  candidate reliability boundary is also normative; its other one-sided measures and
                  every removed-arm row remain diagnostic. The worst-arm row above evaluates the
                  full baseline and candidate pools on the same case cohort.
                </p>
              </div>
              <div
                className={pairedStyles.pairedTableFrame}
                role="region"
                aria-label="Frozen model arm reliability matrix"
                tabIndex={0}
              >
                <table className={pairedStyles.pairedTable}>
                  <caption className={commonStyles.srOnly}>
                    Per-arm baseline and candidate failure rates
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Frozen arm</th>
                      <th scope="col">Baseline failure</th>
                      <th scope="col">Candidate failure</th>
                      <th scope="col">Delta</th>
                      <th scope="col">Confidence interval</th>
                      <th scope="col">Baseline / candidate</th>
                      <th scope="col">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decision.paired_live_evidence.model_pool_arm_reliability.map((statistic) => (
                      <tr key={statistic.arm_id} data-verdict={statistic.verdict}>
                        <th scope="row">
                          <span>{ARM_COHORT_LABELS[statistic.cohort]}</span>
                          <strong>{statistic.arm_id}</strong>
                          <small>Failure-rate margin ≤ {formatStatistic(statistic.margin)}</small>
                        </th>
                        <td>{formatStatistic(statistic.baseline_failure_rate)}</td>
                        <td>{formatStatistic(statistic.candidate_failure_rate)}</td>
                        <td>{formatStatistic(statistic.delta, true)}</td>
                        <td>
                          <span>
                            Δ{' '}
                            {statistic.confidence_interval.length === 2
                              ? `[${formatStatistic(statistic.confidence_interval[0], true)}, ${formatStatistic(statistic.confidence_interval[1], true)}]`
                              : statistic.cohort === 'paired'
                                ? 'Inconclusive'
                                : 'Not pairable'}
                          </span>
                          {statistic.candidate_confidence_interval?.length === 2 ? (
                            <small>
                              Candidate failure [
                              {formatStatistic(statistic.candidate_confidence_interval[0])},{' '}
                              {formatStatistic(statistic.candidate_confidence_interval[1])}]
                            </small>
                          ) : null}
                        </td>
                        <td>
                          {statistic.baseline_sample_count} / {statistic.candidate_sample_count}
                        </td>
                        <td>
                          <GateVerdictBadge
                            verdict={statistic.verdict}
                            disposition={
                              statistic.cohort === 'baseline_only' ? 'advisory' : 'required'
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {decision.fidelity_evidence ? (
        <section className={styles.decisionSection} aria-labelledby="campaign-fidelity-title">
          <div className={styles.sectionHeader}>
            <div>
              <span className={commonStyles.eyebrow}>Reference → fresh live</span>
              <h4 id="campaign-fidelity-title">Live fidelity receipt</h4>
              <p>
                Two independently attested live runs cover the same candidate, suite revision,
                workload, case, and attempt cohort; the fresh run starts after the reference seals.
              </p>
            </div>
            <dl className={pairedStyles.pairedDigest}>
              <div>
                <dt>Evidence digest</dt>
                <CopyableDigest
                  label="fidelity evidence"
                  value={decision.fidelity_evidence.digest}
                  displayValue={shortDigest(decision.fidelity_evidence.digest)}
                />
              </div>
            </dl>
          </div>
          <div className={fidelityStyles.fidelitySummary}>
            <dl className={fidelityStyles.identity} aria-label="Live fidelity run identity">
              <div>
                <dt>Reference</dt>
                <dd>
                  {runNames.get(decision.fidelity_evidence.reference_run_id) ||
                    decision.fidelity_evidence.reference_run_id}
                </dd>
              </div>
              <div>
                <dt>Fresh live</dt>
                <dd>
                  {runNames.get(decision.fidelity_evidence.live_run_id) ||
                    decision.fidelity_evidence.live_run_id}
                </dd>
              </div>
              <div>
                <dt>Candidate subject</dt>
                <dd title={decision.fidelity_evidence.candidate_subject_digest}>
                  {shortDigest(decision.fidelity_evidence.candidate_subject_digest)}
                </dd>
              </div>
              <div>
                <dt>Fidelity track</dt>
                <dd>{TRACK_PRESENTATION[decision.fidelity_evidence.track_id].label}</dd>
              </div>
            </dl>
            <dl className={fidelityStyles.measures} aria-label="Live fidelity decision statistics">
              <div>
                <dt>Matched</dt>
                <dd>{decision.fidelity_evidence.matched_cases}</dd>
              </div>
              <div>
                <dt>Decision drift</dt>
                <dd>{decision.fidelity_evidence.decision_mismatches}</dd>
              </div>
              <div>
                <dt>Outcome drift</dt>
                <dd>{decision.fidelity_evidence.outcome_mismatches}</dd>
              </div>
              <div>
                <dt>Unavailable</dt>
                <dd>{decision.fidelity_evidence.unavailable_cases}</dd>
              </div>
              <div>
                <dt>Agreement</dt>
                <dd>{formatStatistic(decision.fidelity_evidence.point_estimate)}</dd>
              </div>
              <div>
                <dt>One-sided lower bound</dt>
                <dd>{formatStatistic(decision.fidelity_evidence.lower_bound)}</dd>
              </div>
              <div className={fidelityStyles.verdict}>
                <dt>G5 verdict</dt>
                <dd>
                  <GateVerdictBadge
                    verdict={decision.fidelity_evidence.verdict}
                    disposition="required"
                  />
                </dd>
              </div>
            </dl>
          </div>
        </section>
      ) : null}

      <section className={styles.decisionSection} aria-labelledby="campaign-evidence-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={commonStyles.eyebrow}>Immutable evidence</span>
            <h4 id="campaign-evidence-title">Run anchors</h4>
            <p>
              Each catalog slot is bound to the sealed manifest, report, and private execution
              receipt used by this decision.
            </p>
          </div>
          <span className={commonStyles.contractBadge}>
            {decision.evidence.length} anchored runs
          </span>
        </div>
        <div className={evidenceStyles.anchorGrid}>
          {decision.evidence.map((anchor) => (
            <article
              key={`${anchor.slot_id}:${anchor.binding_role}`}
              className={evidenceStyles.anchorCard}
            >
              <div className={evidenceStyles.anchorHeader}>
                <strong>{runNames.get(anchor.run_id) || anchor.run_id}</strong>
                <span className={commonStyles.roleBadge}>
                  {anchor.gate_id} · {anchor.binding_role}
                </span>
              </div>
              <dl className={evidenceStyles.digestList}>
                <div>
                  <dt>Run</dt>
                  <CopyableDigest label="run" value={anchor.run_id} />
                </div>
                <div>
                  <dt>Manifest identity</dt>
                  <CopyableDigest
                    label="manifest semantic identity"
                    value={anchor.manifest_semantic_digest}
                  />
                </div>
                <div>
                  <dt>Manifest artifact</dt>
                  <CopyableDigest
                    label="manifest artifact"
                    value={anchor.manifest_artifact_digest}
                  />
                </div>
                <div>
                  <dt>Report</dt>
                  <CopyableDigest label="report" value={anchor.report_digest} />
                </div>
                <div>
                  <dt>Private receipt</dt>
                  <CopyableDigest label="private receipt" value={anchor.private_receipt_digest} />
                </div>
                {anchor.candidate_subject_digest ? (
                  <div>
                    <dt>Candidate subject</dt>
                    <CopyableDigest
                      label="candidate subject"
                      value={anchor.candidate_subject_digest}
                    />
                  </div>
                ) : null}
                {anchor.execution_attestation_digest ? (
                  <div>
                    <dt>Server execution</dt>
                    <CopyableDigest
                      label="server execution"
                      value={anchor.execution_attestation_digest}
                    />
                  </div>
                ) : null}
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.decisionSection} aria-labelledby="campaign-gates-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={commonStyles.eyebrow}>Release boundary</span>
            <h4 id="campaign-gates-title">Ten-gate decision</h4>
            <p>
              Required, advisory, and not-applicable gates remain visible as one signed decision.
            </p>
          </div>
          <span className={commonStyles.contractBadge}>{decision.gates.length} gates</span>
        </div>
        <div className={gateStyles.gateList}>
          {decision.gates.map((gate) => (
            <article key={gate.id} className={gateStyles.gateRow} data-verdict={gate.verdict}>
              <div className={gateStyles.gateIdentity}>
                <div>
                  <code>{gate.id}</code>
                  <strong>{gate.name}</strong>
                </div>
                <p>{gate.rationale}</p>
              </div>
              <div className={gateStyles.gateEvidence}>
                <div>
                  <span className={commonStyles.sourceBadge}>{gate.source}</span>
                  <span className={commonStyles.evidenceLevel}>{gate.evidence_level}</span>
                </div>
                <span>
                  {gate.observed === undefined
                    ? 'No scalar observation'
                    : `Observed ${gate.observed}`}
                  {gate.sample_count === undefined ? '' : ` · n=${gate.sample_count}`}
                </span>
                {gate.evidence_refs.length ? (
                  <details>
                    <summary>{gate.evidence_refs.length} evidence references</summary>
                    <ul>
                      {gate.evidence_refs.map((reference) => (
                        <li key={reference}>
                          <code title={reference}>{reference}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
              <GateVerdictBadge verdict={gate.verdict} disposition={gate.disposition} />
            </article>
          ))}
        </div>
      </section>

      <section className={styles.decisionSection} aria-labelledby="campaign-actions-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={commonStyles.eyebrow}>Next actions</span>
            <h4 id="campaign-actions-title">Recommendations</h4>
          </div>
          <span className={commonStyles.contractBadge}>{formatCreatedAt(decision.created_at)}</span>
        </div>
        {decision.recommendations.length ? (
          <ol className={gateStyles.recommendations}>
            {decision.recommendations.map((recommendation, index) => (
              <li key={`${index}-${recommendation}`}>{recommendation}</li>
            ))}
          </ol>
        ) : (
          <p className={gateStyles.emptyRecommendations}>No further action was emitted.</p>
        )}
      </section>
    </article>
  )
}
