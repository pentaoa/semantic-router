import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pageSource = readFileSync(new URL('./EvaluationPage.tsx', import.meta.url), 'utf8')
const typeSource = [
  'evaluationPlane.ts',
  'evaluationReport.ts',
  'evaluationCampaign.ts',
  'evaluationControlledPair.ts',
]
  .map((file) => readFileSync(new URL(`../types/${file}`, import.meta.url), 'utf8'))
  .join('\n')
const formSource = readFileSync(
  new URL('../components/evaluation-plane/EvaluationExperimentForm.tsx', import.meta.url),
  'utf8',
)
const formContractSource = [
  formSource,
  readFileSync(
    new URL('../components/evaluation-plane/EvaluationExperimentIdentity.tsx', import.meta.url),
    'utf8',
  ),
  readFileSync(
    new URL('../components/evaluation-plane/EvaluationExperimentGateScope.tsx', import.meta.url),
    'utf8',
  ),
  readFileSync(
    new URL('../components/evaluation-plane/useEvaluationExperimentForm.ts', import.meta.url),
    'utf8',
  ),
].join('\n')
const reportSource = readFileSync(
  new URL('../components/evaluation-plane/EvaluationReportView.tsx', import.meta.url),
  'utf8',
)
const reportContractSource = [
  reportSource,
  readFileSync(
    new URL('../components/evaluation-plane/EvaluationReportDisclosures.tsx', import.meta.url),
    'utf8',
  ),
].join('\n')
const reportDecisionSource = readFileSync(
  new URL('../components/evaluation-plane/EvaluationReportDecision.tsx', import.meta.url),
  'utf8',
)
const presentationSource = readFileSync(
  new URL('../components/evaluation-plane/evaluationPresentation.ts', import.meta.url),
  'utf8',
)
const navigationSource = readFileSync(
  new URL('../components/evaluation-plane/EvaluationNavigation.tsx', import.meta.url),
  'utf8',
)
const runActionDialogsSource = readFileSync(
  new URL('./EvaluationRunActionDialogs.tsx', import.meta.url),
  'utf8',
)

describe('Evaluation Plane browser contract', () => {
  it('keeps RBAC, server read-only policy, and explicit lifecycle confirmation', () => {
    expect(pageSource).toContain('canWriteEvaluation')
    expect(pageSource).toContain('canRunEvaluation')
    expect(pageSource).toContain('!readonlyLoading && !serverReadonly')
    expect(pageSource).toContain('<EvaluationRunActionDialogs')
    expect(runActionDialogsSource.match(/<ConfirmDialog/g)).toHaveLength(2)
    expect(pageSource).toContain('cancelRun')
    expect(pageSource).toContain('const { autoStart, ...request } = intent')
    expect(pageSource).toContain('plane.createRun(request)')
    expect(pageSource).toContain('plane.startRun(pendingRun.id)')
    expect(`${pageSource}\n${runActionDialogsSource}`).not.toMatch(/\b(?:window\.)?confirm\s*\(/)
  })

  it('exposes the complete information architecture and server-catalog target seam', () => {
    for (const label of ['Overview', 'New experiment', 'Runs', 'Reports', 'Compare']) {
      expect(navigationSource).toContain(`label: '${label}'`)
    }
    expect(formContractSource).toContain('catalog.targets')
    expect(formContractSource).toContain('.filter((target) => target.modes.includes(form.mode))')
    expect(formContractSource).toContain('target_id: targetID')
    expect(formContractSource).toContain('catalog.change_profiles.map')
    expect(formContractSource).toContain('change_profile: changeProfile')
    expect(formContractSource).not.toMatch(/endpoint|target_url/i)
  })

  it('keeps hidden grading outside the TypeScript browser contract', () => {
    expect(typeSource).not.toMatch(
      /casegrading|hidden[_ ]?(?:label|grading)|answer[_ ]?key|reference[_ ]?answer/i,
    )
    expect(typeSource).toContain("'routing'")
    expect(typeSource).toContain("'capacity'")
  })

  it('models gates, three cost ledgers, provenance, artifacts, and recommendations', () => {
    for (const disposition of ['required', 'advisory', 'not_applicable', 'waived']) {
      expect(typeSource).toContain(`'${disposition}'`)
    }
    for (const verdict of ['pass', 'fail', 'unavailable', 'waived', 'not_applicable']) {
      expect(typeSource).toContain(`'${verdict}'`)
    }
    expect(typeSource).toContain('runtime: EvaluationCostAmount')
    expect(typeSource).toContain('evaluation_overhead: EvaluationCostAmount')
    expect(typeSource).toContain('capacity_tco: EvaluationCostAmount')
    expect(typeSource).toContain('gate_contract_version: EvaluationGateContractVersion')
    expect(typeSource).toContain('change_profile: EvaluationChangeProfileId')
    expect(typeSource).toContain('evidence_refs: string[]')
    expect(typeSource).toContain('contract_version: EvaluationGateContractVersion')
    expect(typeSource).toContain('coverage?: EvaluationCoverage')
    expect(reportContractSource).toContain('report.provenance')
    expect(reportContractSource).toContain('workload_snapshot_digest')
    expect(reportContractSource).toContain('report.artifacts')
    expect(reportContractSource).toContain('getEvaluationArtifactURL')
    expect(reportContractSource).toContain('report.recommendations')
    expect(reportDecisionSource).toContain('requiredUnavailable')
    expect(reportDecisionSource).toContain('evaluationPromotionVerdict')
    expect(presentationSource).toContain('effectiveGateVerdict')
    expect(typeSource).toContain('attestation_revision: EvaluationAttestationRevision')
  })
})
