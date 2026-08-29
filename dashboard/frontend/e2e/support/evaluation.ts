import type { Page, Route } from '@playwright/test'

import type {
  CreateEvaluationRunRequest,
  EvaluationCatalog,
  EvaluationChangeProfileId,
  EvaluationComparison,
  EvaluationFailureSummary,
  EvaluationGate,
  EvaluationMetric,
  EvaluationMode,
  EvaluationReport,
  EvaluationRun,
  EvaluationRunLedgerWarning,
  EvaluationTrackId,
  EvidenceLevel,
} from '../../src/types/evaluationPlane'
import { EVALUATION_TRACK_IDS, TRACK_PRESENTATION } from '../../src/types/evaluationPlane'
import {
  gateApplicabilityForProfile,
  SUPPORTED_GATE_CONTRACT_VERSION,
} from '../../src/components/evaluation-plane/evaluationGateContract'

const trackContracts: Record<
  EvaluationTrackId,
  { modes: EvaluationMode[]; metrics: string[]; evidenceLevels: EvidenceLevel[] }
> = {
  routing: {
    modes: ['replay', 'live'],
    metrics: [
      'routing.coverage',
      'routing.accuracy',
      'routing.abstention_rate',
      'routing.fallback_rate',
      'routing.latency_p95_ms',
    ],
    evidenceLevels: ['E0', 'E3'],
  },
  model_pool: {
    modes: ['replay', 'live'],
    metrics: [
      'model_pool.best_single_quality',
      'model_pool.oracle_quality',
      'model_pool.oracle_gain',
      'model_pool.unique_win_rate',
      'model_pool.selection_entropy_bits',
      'model_pool.selection_arm_coverage',
    ],
    evidenceLevels: ['E0', 'E4'],
  },
  joint: {
    modes: ['replay', 'live'],
    metrics: [
      'joint.realized_quality',
      'joint.oracle_regret',
      'joint.normalized_regret',
      'joint.reliability',
    ],
    evidenceLevels: ['E0', 'E5'],
  },
  agentic: {
    modes: ['replay'],
    metrics: ['agentic.success_rate', 'agentic.invalid_tool_rate'],
    evidenceLevels: ['E0'],
  },
  multimodal: {
    modes: ['replay', 'live'],
    metrics: ['multimodal.support_rate', 'multimodal.quality'],
    evidenceLevels: ['E0', 'E5'],
  },
  preference: {
    modes: ['replay'],
    metrics: ['preference.agreement', 'preference.propensity_coverage'],
    evidenceLevels: ['E0'],
  },
  safety: {
    modes: ['replay'],
    metrics: ['safety.violation_rate', 'safety.violation_upper_95', 'safety.block_accuracy'],
    evidenceLevels: ['E0'],
  },
  capacity: {
    modes: ['replay', 'live'],
    metrics: [
      'capacity.throughput_rps',
      'capacity.latency_p95_ms',
      'capacity.success_rate',
      'capacity.cost_per_successful_request',
    ],
    evidenceLevels: ['E0', 'E5'],
  },
}

export const evaluationCatalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: SUPPORTED_GATE_CONTRACT_VERSION,
  generated_at: '2026-08-29T00:00:00Z',
  change_profiles: [
    {
      id: 'schema_adapter',
      name: 'Schema / adapter',
      description: 'Strict schema and adapter parity changes.',
    },
    {
      id: 'recipe',
      name: 'Routing recipe',
      description: 'Recipe signal, decision, algorithm, and policy changes.',
    },
    {
      id: 'selector',
      name: 'Selector / binding',
      description: 'Selector, projection, classifier, and binding changes.',
    },
    {
      id: 'model_pool',
      name: 'Model pool',
      description: 'Logical arm composition, capability, quality, and price changes.',
    },
    {
      id: 'runtime_capacity',
      name: 'Runtime / capacity',
      description: 'Serving runtime, placement, capacity, and transport changes.',
    },
    {
      id: 'agent_multimodal',
      name: 'Agent / multimodal',
      description: 'Agent trajectory, tool, state, and multimodal changes.',
    },
    {
      id: 'online_adaptation',
      name: 'Online adaptation',
      description: 'Online assignment, preference, feedback, and adaptive policy changes.',
    },
  ],
  tracks: EVALUATION_TRACK_IDS.map((id) => ({
    id,
    name: TRACK_PRESENTATION[id].label,
    description: TRACK_PRESENTATION[id].description,
    modes: trackContracts[id].modes,
    metrics: trackContracts[id].metrics,
    evidence_levels: trackContracts[id].evidenceLevels,
  })),
  suites: [
    {
      id: 'evaluation-smoke',
      name: 'Evaluation harness smoke',
      description: 'Deterministic plumbing evidence; it is not a live model-quality claim.',
      track_ids: [...EVALUATION_TRACK_IDS],
      modes: ['replay'],
      evidence_level: 'E0',
      case_count: 4,
      revision: 'builtin-v1',
    },
    {
      id: 'live-routing-core',
      name: 'Live routing core',
      description: 'Diagnostic routing smoke using bounded live probes; no promotion claim.',
      track_ids: ['routing'],
      modes: ['live'],
      evidence_level: 'E0',
      revision: 'executor-v1',
    },
    {
      id: 'live-model-pool',
      name: 'Live model pool',
      description: 'Requires an attested direct-arm target unavailable on the generic runtime.',
      track_ids: ['model_pool'],
      modes: ['live'],
      evidence_level: 'E0',
      revision: 'executor-v1',
    },
    {
      id: 'live-joint',
      name: 'Live routing + pool',
      description: 'Requires attested route correlation and direct-arm execution.',
      track_ids: ['routing', 'model_pool', 'joint'],
      modes: ['live'],
      evidence_level: 'E0',
      revision: 'executor-v1',
    },
    {
      id: 'live-multimodal',
      name: 'Live multimodal',
      description: 'Diagnostic single-probe multimodal smoke; no grounding or privacy claim.',
      track_ids: ['multimodal'],
      modes: ['live'],
      evidence_level: 'E0',
      revision: 'executor-v1',
    },
    {
      id: 'live-capacity',
      name: 'Live capacity',
      description: 'Diagnostic bounded concurrency smoke without repeats or a declared SLO.',
      track_ids: ['capacity'],
      modes: ['live'],
      evidence_level: 'E0',
      revision: 'executor-v1',
    },
  ],
  targets: [
    {
      id: 'fixture',
      name: 'Built-in replay fixture',
      description: 'Local deterministic harness validation with no production-quality claim.',
      kind: 'builtin-fixture',
      track_ids: [...EVALUATION_TRACK_IDS],
      modes: ['replay'],
      evidence_level: 'E0',
      healthy: true,
    },
    {
      id: 'runtime',
      name: 'Active vLLM-SR runtime',
      description: 'Server-managed endpoints; the catalog advertises only qualified capabilities.',
      kind: 'runtime',
      track_ids: ['routing', 'multimodal', 'capacity'],
      modes: ['live'],
      healthy: true,
    },
  ],
}

export function evaluationRun(
  id: string,
  name: string,
  status: EvaluationRun['status'],
  createdAt: string,
  changeProfile: EvaluationChangeProfileId = 'recipe',
  overrides: Partial<EvaluationRun> = {},
): EvaluationRun {
  const mode = overrides.mode || (status === 'running' ? 'live' : 'replay')
  const live = mode === 'live'
  const trackIDs: EvaluationTrackId[] = live
    ? ['routing', 'multimodal', 'capacity']
    : [...EVALUATION_TRACK_IDS]
  const suiteIDs = live
    ? ['live-routing-core', 'live-multimodal', 'live-capacity']
    : ['evaluation-smoke']
  const terminal = ['completed', 'failed', 'cancelled'].includes(status)
  const progress = {
    percent: status === 'completed' ? 100 : status === 'running' ? 45 : terminal ? 55 : 0,
    completed: status === 'completed' ? trackIDs.length : status === 'running' || terminal ? 3 : 0,
    total: trackIDs.length,
    message:
      status === 'running'
        ? 'Executing capacity track'
        : status === 'failed'
          ? 'Worker exited before report publication'
          : status === 'cancelled'
            ? 'Execution cancelled'
            : status === 'completed'
              ? 'Evidence complete'
              : 'Awaiting execution',
  }
  const run: EvaluationRun = {
    schema_version: 'evaluation.v1',
    id,
    name,
    description: `${name} description`,
    status,
    mode,
    evidence_level: 'E0',
    target_id: live ? 'runtime' : 'fixture',
    change_profile: changeProfile,
    suite_ids: suiteIDs,
    track_ids: trackIDs,
    sample_limit: 4,
    concurrency: 4,
    seed: 42,
    progress,
    created_at: createdAt,
    started_at: status === 'pending' ? undefined : createdAt,
    completed_at: terminal ? '2026-08-29T00:10:00Z' : undefined,
    error: status === 'failed' ? 'Evaluation worker exited before a report was sealed.' : undefined,
  }
  return {
    ...run,
    ...overrides,
    progress: { ...progress, ...overrides.progress },
  }
}

export const defaultEvaluationRuns = [
  evaluationRun(
    'candidate-run',
    'Candidate recipe',
    'completed',
    '2026-08-29T00:00:00Z',
    'recipe',
    {
      baseline_run_id: 'baseline-run',
    },
  ),
  evaluationRun('baseline-run', 'Production baseline', 'completed', '2026-08-28T00:00:00Z'),
  evaluationRun('unpaired-run', 'Unpaired diagnostic', 'completed', '2026-08-27T12:00:00Z'),
  evaluationRun(
    'live-run',
    'Live AMD validation',
    'running',
    '2026-08-27T00:00:00Z',
    'runtime_capacity',
  ),
  evaluationRun('failed-run', 'Failed diagnostic', 'failed', '2026-08-26T00:00:00Z'),
  evaluationRun('cancelled-run', 'Cancelled diagnostic', 'cancelled', '2026-08-25T00:00:00Z'),
]

const gateTrackIDs: Partial<Record<`G${number}`, EvaluationGate['track_id']>> = {
  G2: 'safety',
  G3: 'joint',
  G4: 'routing',
  G5: 'joint',
  G6: 'agentic',
  G7: 'capacity',
  G9: 'preference',
}

const gateEvidenceLevels: EvidenceLevel[] = [
  'E0',
  'E0',
  'E3',
  'E4',
  'E4',
  'E5',
  'E5',
  'E5',
  'E5',
  'E5',
]

const gateOwners = [
  'evaluation-platform',
  'evaluation-platform',
  'router-policy',
  'recipe-and-model-pool',
  'evaluation-workload',
  'router-and-serving-runtime',
  'agent-runtime',
  'serving-capacity',
  'release-operations',
  'online-learning',
]

const gateEvidenceRefs = [
  ['run-manifest.json', 'lineage.json', 'provenance.json', 'checksums.sha256'],
  ['run-manifest.json', 'records.jsonl'],
  ['records.jsonl', 'metric:safety.violation_rate'],
  ['metrics.json', 'metric:joint.normalized_regret'],
  ['records.jsonl', 'metric:routing.accuracy'],
  ['records.jsonl', 'provenance.json'],
  ['records.jsonl', 'metric:agentic.success_rate'],
  ['records.jsonl', 'metrics.json'],
  ['run-manifest.json', 'records.jsonl'],
  ['records.jsonl', 'metric:preference.propensity_coverage'],
]

function evaluationGates(run: EvaluationRun): EvaluationGate[] {
  const coverage = {
    evaluated: 4,
    total: 4,
    fraction: 1,
    unavailable: 0,
    confidence_level: 0.95,
    confidence_interval: [0.51, 1] as [number, number],
  }
  return gateApplicabilityForProfile(run.change_profile).map((gate, index) => {
    const foundational = index === 0 || index === 1
    const isNotApplicable = gate.disposition === 'not_applicable'
    return {
      ...gate,
      track_id: gateTrackIDs[gate.id],
      verdict: isNotApplicable
        ? ('not_applicable' as const)
        : foundational
          ? ('pass' as const)
          : ('unavailable' as const),
      change_profile: run.change_profile,
      contract_version: SUPPORTED_GATE_CONTRACT_VERSION,
      evidence_refs: gateEvidenceRefs[index],
      evidence_level: gateEvidenceLevels[index],
      observed: isNotApplicable || !foundational ? null : 1,
      threshold:
        isNotApplicable || !foundational
          ? undefined
          : { operator: '>=', value: 1, unit: index === 0 ? 'fraction' : 'boolean' },
      sample_count: isNotApplicable ? undefined : 4,
      coverage: isNotApplicable ? undefined : coverage,
      owner: gateOwners[index],
      evaluated_at: '2026-08-29T00:10:00Z',
      rationale: foundational
        ? 'The server-validated bundle satisfies this foundational gate.'
        : isNotApplicable
          ? 'This gate is not required by the selected change profile.'
          : 'The E0 run produced diagnostics, but no server-owned qualified attestation exists; this gate cannot pass.',
    }
  })
}

function diagnosticMetric(trackID: EvaluationTrackId): EvaluationMetric {
  const metrics: Record<EvaluationTrackId, EvaluationMetric> = {
    routing: {
      id: 'routing.accuracy',
      name: 'Routing accuracy',
      track_id: 'routing',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    model_pool: {
      id: 'model_pool.oracle_gain',
      name: 'Pool oracle gain',
      track_id: 'model_pool',
      value: 0.08,
      unit: 'score',
      direction: 'higher_is_better',
    },
    joint: {
      id: 'joint.realized_quality',
      name: 'System quality',
      track_id: 'joint',
      value: 0.91,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    agentic: {
      id: 'agentic.success_rate',
      name: 'Agent success rate',
      track_id: 'agentic',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    multimodal: {
      id: 'multimodal.support_rate',
      name: 'Multimodal support rate',
      track_id: 'multimodal',
      value: 0.75,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    preference: {
      id: 'preference.agreement',
      name: 'Preference agreement',
      track_id: 'preference',
      value: 0.8,
      unit: 'fraction',
      direction: 'higher_is_better',
    },
    safety: {
      id: 'safety.violation_rate',
      name: 'Safety violation rate',
      track_id: 'safety',
      value: 0,
      unit: 'violations/case',
      direction: 'lower_is_better',
    },
    capacity: {
      id: 'capacity.latency_p95_ms',
      name: 'P95 latency',
      track_id: 'capacity',
      value: 342,
      unit: 'ms',
      direction: 'lower_is_better',
    },
  }
  return {
    ...metrics[trackID],
    baseline_value: null,
    delta: null,
    confidence_interval:
      metrics[trackID].unit === 'fraction' ? ([0.51, 1] as [number, number]) : undefined,
    sample_count: 4,
  }
}

export function evaluationReport(run = defaultEvaluationRuns[0]): EvaluationReport {
  const totalRecords = run.track_ids.length * 4
  const coverage = {
    evaluated: totalRecords,
    total: totalRecords,
    fraction: 1,
    unavailable: 0,
  }
  const gates = evaluationGates(run)
  const metrics = run.track_ids.map(diagnosticMetric)
  const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  return {
    schema_version: 'evaluation.v1',
    attestation_revision: 'evaluation-server-attestation.v2',
    run,
    summary: {
      verdict: gates.some(
        (gate) => gate.disposition === 'required' && gate.verdict === 'unavailable',
      )
        ? 'unavailable'
        : 'pass',
      quality_score: null,
      latency_p95_ms: null,
      runtime_cost: null,
      capacity_tco: null,
      coverage,
      passed_gates: gates.filter((gate) => gate.verdict === 'pass').length,
      failed_gates: gates.filter((gate) => gate.verdict === 'fail').length,
      unavailable_gates: gates.filter((gate) => gate.verdict === 'unavailable').length,
    },
    tracks: run.track_ids.map((trackID) => ({
      track_id: trackID,
      status: 'completed' as const,
      evidence_level: run.evidence_level,
      summary: `${TRACK_PRESENTATION[trackID].label} diagnostic observation completed.`,
      coverage: { evaluated: 4, total: 4, fraction: 1, unavailable: 0 },
      metrics: [diagnosticMetric(trackID)],
      gates: gates.filter((gate) => gate.track_id === trackID),
    })),
    metrics,
    gates,
    costs: {
      runtime: {
        amount: 0.03195,
        currency: 'USD',
        input_tokens: 12000,
        output_tokens: 6000,
        gpu_seconds: 0.39,
      },
      evaluation_overhead: { amount: 0.00165, currency: 'USD' },
      capacity_tco: { amount: 0.039, currency: 'USD', gpu_seconds: 0.39, energy_kwh: 0.0018 },
    },
    recommendations: [
      'Treat these E0 observations as diagnostics, not a promotion claim.',
      'Collect benchmark-native receipts and qualified robustness evidence before promotion.',
    ],
    provenance: {
      schema_version: 'evaluation.v1',
      generated_at: '2026-08-29T00:10:00Z',
      code_revision: '0123456789abcdef0123456789abcdef01234567',
      benchmark_revisions: Object.fromEntries(
        run.suite_ids.map((id) => [id, id === 'evaluation-smoke' ? 'builtin-v1' : 'executor-v1']),
      ),
      workload_snapshot_digest: digest,
      policy_snapshot_digest: run.baseline_run_id
        ? 'sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        : digest,
      binding_snapshot_digest: run.baseline_run_id
        ? 'sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        : digest,
      pool_snapshot_digest: digest,
      environment_snapshot_digest: digest,
      target_id: run.target_id,
      seed: 42,
      redaction_policy: 'public-safe-v1',
    },
    artifacts: [
      {
        id: 'metrics-json',
        name: 'metrics.json',
        kind: 'json',
        uri: 'metrics.json',
        digest,
        media_type: 'application/json',
        size_bytes: 1024,
      },
      {
        id: 'gates-json',
        name: 'gates.json',
        kind: 'json',
        uri: 'gates.json',
        digest,
        media_type: 'application/json',
        size_bytes: 1024,
      },
      {
        id: 'provenance-json',
        name: 'provenance.json',
        kind: 'json',
        uri: 'provenance.json',
        digest,
        media_type: 'application/json',
        size_bytes: 512,
      },
      {
        id: 'failure-summary-json',
        name: 'failure-summary.json',
        kind: 'json',
        uri: 'failure-summary.json',
        digest,
        media_type: 'application/json',
        size_bytes: 512,
      },
      {
        id: 'checksums-sha256',
        name: 'checksums.sha256',
        kind: 'sha256',
        uri: 'checksums.sha256',
        digest,
        media_type: 'text/plain',
        size_bytes: 325,
      },
    ],
  }
}

export const evaluationComparison: EvaluationComparison = {
  schema_version: 'evaluation.v1',
  attestation_revision: 'evaluation-server-attestation.v2',
  baseline_run_id: 'baseline-run',
  candidate_run_id: 'candidate-run',
  verdict: 'unavailable',
  summary: 'Diagnostic deltas are favorable, but E0 evidence cannot support promotion.',
  metrics: [
    {
      id: 'joint.realized_quality',
      name: 'System quality',
      track_id: 'joint',
      value: 0.91,
      unit: 'fraction',
      direction: 'higher_is_better',
      baseline_value: 0.88,
      delta: 0.03,
      sample_count: 4,
    },
    {
      id: 'capacity.latency_p95_ms',
      name: 'P95 latency',
      track_id: 'capacity',
      value: 342,
      unit: 'ms',
      direction: 'lower_is_better',
      baseline_value: 370,
      delta: -28,
      sample_count: 4,
    },
  ],
  gates: evaluationReport().gates.filter((gate) => gate.id === 'G4'),
  recommendations: ['Collect qualified robustness evidence before a guarded live trial.'],
}

interface MockEvaluationPlaneOptions {
  mutationDelayMs?: number
  catalogDelayMs?: number
  ledgerDelayMs?: number
  ledgerWarnings?: EvaluationRunLedgerWarning[]
  legacyReportRunIdentity?: boolean
  unattestedPromotionClaim?: boolean
  eventStreamCloseOnce?: boolean
  reportFailureIDs?: string[]
  reportFailureStatus?: number
  diagnosticArtifactBodies?: {
    failureSummary?: string
    capacityProfile?: string
  }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function exactCohortMatches(left: EvaluationRun, right: EvaluationRun): boolean {
  return (
    left.mode === right.mode &&
    left.target_id === right.target_id &&
    left.change_profile === right.change_profile &&
    left.sample_limit === right.sample_limit &&
    left.concurrency === right.concurrency &&
    left.seed === right.seed &&
    sameMembers(left.suite_ids, right.suite_ids) &&
    sameMembers(left.track_ids, right.track_ids)
  )
}

function createRequestMatchesRun(request: CreateEvaluationRunRequest, run: EvaluationRun): boolean {
  return (
    request.name.trim() === run.name &&
    request.description.trim() === run.description &&
    request.mode === run.mode &&
    request.target_id === run.target_id &&
    request.change_profile === run.change_profile &&
    request.sample_limit === run.sample_limit &&
    request.concurrency === run.concurrency &&
    request.seed === run.seed &&
    (request.baseline_run_id || '') === (run.baseline_run_id || '') &&
    sameMembers(request.suite_ids, run.suite_ids) &&
    sameMembers(request.track_ids, run.track_ids)
  )
}

function failureSummary(run: EvaluationRun): EvaluationFailureSummary {
  return {
    schema_version: 'evaluation.v1',
    total_records: run.track_ids.length * 4,
    failed: 0,
    unavailable: 0,
    by_track: [...run.track_ids].sort().map((track_id) => ({
      track_id,
      succeeded: 4,
      failed: 0,
      unavailable: 0,
    })),
  }
}

async function fulfillJSON(route: Route, status: number, payload: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

async function fulfillError(route: Route, status: number, message: string): Promise<void> {
  await fulfillJSON(route, status, { error: { message } })
}

export async function mockEvaluationPlane(
  page: Page,
  initialRuns = defaultEvaluationRuns,
  options: MockEvaluationPlaneOptions = {},
) {
  let runs = [...initialRuns]
  const createAttempts: CreateEvaluationRunRequest[] = []
  const createdRequests: CreateEvaluationRunRequest[] = []
  const reportRequests: string[] = []
  const comparisonRequests: Array<{ baselineRunID: string; candidateRunID: string }> = []
  let cancelCount = 0
  let deleteCount = 0
  let startCount = 0
  let eventStreamCount = 0
  const ledgerWarnings = options.ledgerWarnings || []
  const mutationDelay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, options.mutationDelayMs || 0))

  await page.route('**/api/evaluation/v1/catalog', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, options.catalogDelayMs || 0))
    await fulfillJSON(route, 200, evaluationCatalog)
  })
  await page.route('**/api/evaluation/v1/run-ledger', async (route) => {
    if (route.request().method() !== 'GET') {
      await fulfillError(route, 405, 'method not allowed')
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.ledgerDelayMs || 0))
    await fulfillJSON(route, 200, {
      schema_version: 'evaluation.v1',
      runs,
      ledger_complete: ledgerWarnings.length === 0,
      warnings: ledgerWarnings,
    })
  })
  await page.route('**/api/evaluation/v1/compare?*', async (route) => {
    if (ledgerWarnings.length) {
      await fulfillError(
        route,
        409,
        'conflict: evaluation run ledger is incomplete; repair quarantined evidence before comparing runs',
      )
      return
    }
    const url = new URL(route.request().url())
    const baselineRunID = url.searchParams.get('baseline_run_id') || ''
    const candidateRunID = url.searchParams.get('candidate_run_id') || ''
    comparisonRequests.push({ baselineRunID, candidateRunID })
    const baseline = runs.find((run) => run.id === baselineRunID)
    const candidate = runs.find((run) => run.id === candidateRunID)
    if (!baseline || !candidate) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (baseline.status !== 'completed' || candidate.status !== 'completed') {
      await fulfillError(route, 409, 'conflict: comparison requires completed reports')
      return
    }
    if (candidate.baseline_run_id !== baseline.id) {
      await fulfillError(
        route,
        400,
        'invalid evaluation request: candidate baseline_run_id must identify the compared baseline',
      )
      return
    }
    if (!exactCohortMatches(baseline, candidate)) {
      await fulfillError(
        route,
        400,
        'invalid evaluation request: baseline and candidate report cohorts do not match',
      )
      return
    }
    await fulfillJSON(route, 200, {
      ...evaluationComparison,
      baseline_run_id: baseline.id,
      candidate_run_id: candidate.id,
      gates: evaluationReport(candidate).gates.filter((gate) => gate.id === 'G4'),
    })
  })
  await page.route('**/api/evaluation/v1/runs/*/events', async (route) => {
    eventStreamCount += 1
    if (options.eventStreamCloseOnce && eventStreamCount === 1) {
      await route.fulfill({ status: 204 })
      return
    }
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    const event = {
      id: 'sse-event-1',
      run_id: id,
      type: 'progress',
      timestamp: '2026-08-29T00:05:00Z',
      message: 'Executing routing track from SSE',
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: `id: sse-event-1\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`,
    })
  })
  await page.route('**/api/evaluation/v1/runs/*/report', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    reportRequests.push(id)
    if (options.reportFailureIDs?.includes(id)) {
      await fulfillError(
        route,
        options.reportFailureStatus || 503,
        options.reportFailureStatus === 404
          ? 'not found: evaluation report'
          : 'report storage is temporarily unavailable',
      )
      return
    }
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (run.status !== 'completed') {
      await fulfillError(
        route,
        409,
        'conflict: evaluation report is available only for completed runs',
      )
      return
    }
    const report = evaluationReport(run)
    if (options.legacyReportRunIdentity) {
      delete report.attestation_revision
      report.run = {
        ...report.run,
        name: report.run.id,
        description: `Evaluation suites: ${report.run.suite_ids.join(', ')}`,
      }
    }
    if (options.unattestedPromotionClaim) {
      delete report.attestation_revision
      report.summary = {
        ...report.summary,
        verdict: 'pass',
        passed_gates: report.gates.filter((gate) => gate.disposition === 'required').length,
        failed_gates: 0,
        unavailable_gates: 0,
      }
      report.gates = report.gates.map((gate) =>
        gate.disposition === 'required' ? { ...gate, verdict: 'pass' as const } : gate,
      )
    }
    if (typeof options.diagnosticArtifactBodies?.capacityProfile === 'string') {
      report.artifacts = [
        ...report.artifacts,
        {
          id: 'capacity-profile-json',
          name: 'capacity-profile.json',
          kind: 'json',
          uri: 'capacity-profile.json',
          digest: report.artifacts[0]?.digest,
          media_type: 'application/json',
          size_bytes: options.diagnosticArtifactBodies.capacityProfile.length,
        },
      ]
    }
    await fulfillJSON(route, 200, report)
  })
  await page.route('**/api/evaluation/v1/runs/*/artifacts/*', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const artifactID = decodeURIComponent(parts[parts.length - 1] || '')
    const id = decodeURIComponent(parts[parts.length - 3] || '')
    const run = runs.find((candidate) => candidate.id === id)
    if (!run) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (run.status !== 'completed') {
      await fulfillError(route, 409, 'conflict: evaluation evidence is not sealed')
      return
    }
    if (artifactID === 'failure-summary-json') {
      if (typeof options.diagnosticArtifactBodies?.failureSummary === 'string') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: options.diagnosticArtifactBodies.failureSummary,
        })
        return
      }
      await fulfillJSON(route, 200, failureSummary(run))
      return
    }
    if (
      artifactID === 'capacity-profile-json' &&
      typeof options.diagnosticArtifactBodies?.capacityProfile === 'string'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: options.diagnosticArtifactBodies.capacityProfile,
      })
      return
    }
    if (['metrics-json', 'gates-json', 'provenance-json'].includes(artifactID)) {
      await fulfillJSON(route, 200, { schema_version: 'evaluation.v1' })
      return
    }
    if (artifactID === 'checksums-sha256') {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: '0123456789abcdef  metrics.json\n',
      })
      return
    }
    await fulfillError(route, 404, 'not found: evaluation artifact')
  })
  await page.route('**/api/evaluation/v1/runs/*/cancel', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    await mutationDelay()
    const cancelled = {
      ...current,
      status: 'cancelled' as const,
      completed_at: '2026-08-29T00:11:00Z',
      progress: { ...current.progress, message: 'Run cancelled' },
    }
    runs = runs.map((run) => (run.id === id ? cancelled : run))
    cancelCount += 1
    await fulfillJSON(route, 200, cancelled)
  })
  await page.route('**/api/evaluation/v1/runs/*/start', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 2] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (current.status !== 'pending') {
      await fulfillError(route, 409, `conflict: run cannot be started from ${current.status}`)
      return
    }
    await mutationDelay()
    const started = {
      ...current,
      status: 'running' as const,
      started_at: '2026-08-29T01:01:00Z',
      progress: { ...current.progress, message: 'Evaluation worker starting' },
    }
    runs = runs.map((run) => (run.id === id ? started : run))
    startCount += 1
    await fulfillJSON(route, 200, started)
  })
  await page.route(/\/api\/evaluation\/v1\/runs\/[^/?]+(?:\?.*)?$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = decodeURIComponent(parts[parts.length - 1] || '')
    const current = runs.find((run) => run.id === id)
    if (!current) {
      await fulfillError(route, 404, 'not found: evaluation run')
      return
    }
    if (route.request().method() === 'GET') {
      await fulfillJSON(route, 200, current)
      return
    }
    if (route.request().method() !== 'DELETE') {
      await fulfillError(route, 405, 'method not allowed')
      return
    }
    if (current.status === 'running') {
      await fulfillError(route, 409, 'conflict: cancel a running evaluation before deletion')
      return
    }
    await mutationDelay()
    runs = runs.filter((run) => run.id !== id)
    deleteCount += 1
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/evaluation/v1/runs', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as CreateEvaluationRunRequest
      createAttempts.push(request)
      const target = evaluationCatalog.targets.find(
        (candidate) => candidate.id === request.target_id,
      )
      const suites = request.suite_ids.map((id) =>
        evaluationCatalog.suites.find((candidate) => candidate.id === id),
      )
      const suiteTrackIDs = new Set(suites.flatMap((suite) => suite?.track_ids || []))
      const utf8Length = (value: string) => new TextEncoder().encode(value).length
      const invalid =
        !request.name.trim() ||
        utf8Length(request.name.trim()) > 200 ||
        utf8Length(request.description.trim()) > 4000 ||
        !Number.isInteger(request.sample_limit) ||
        request.sample_limit < 1 ||
        request.sample_limit > 100000 ||
        !Number.isInteger(request.concurrency) ||
        request.concurrency < 1 ||
        request.concurrency > 128 ||
        !Number.isInteger(request.seed) ||
        request.seed < 0 ||
        request.seed > 4294967295 ||
        (Boolean(request.client_request_id) &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            request.client_request_id || '',
          )) ||
        request.auto_start !== false ||
        !evaluationCatalog.change_profiles.some(
          (profile) => profile.id === request.change_profile,
        ) ||
        !target ||
        target.healthy === false ||
        !target.modes.includes(request.mode) ||
        request.suite_ids.length === 0 ||
        request.track_ids.length === 0 ||
        suites.some(
          (suite) =>
            !suite ||
            !suite.modes.includes(request.mode) ||
            suite.track_ids.some((trackID) => !target.track_ids.includes(trackID)),
        ) ||
        request.track_ids.some(
          (trackID) =>
            !suiteTrackIDs.has(trackID) ||
            !target.track_ids.includes(trackID) ||
            !evaluationCatalog.tracks
              .find((track) => track.id === trackID)
              ?.modes.includes(request.mode),
        )
      if (invalid) {
        await fulfillError(route, 400, 'invalid evaluation request: create contract rejected')
        return
      }
      if (request.baseline_run_id && ledgerWarnings.length) {
        await fulfillError(
          route,
          409,
          'conflict: evaluation run ledger is incomplete; repair quarantined evidence before selecting a baseline',
        )
        return
      }
      const baseline = request.baseline_run_id
        ? runs.find((run) => run.id === request.baseline_run_id)
        : null
      if (request.baseline_run_id && (!baseline || baseline.status !== 'completed')) {
        await fulfillError(route, 400, 'invalid evaluation request: baseline run must be completed')
        return
      }
      const requestRun = evaluationRun(
        'request-cohort',
        request.name,
        'pending',
        '2026-08-29T01:00:00Z',
        request.change_profile,
        request,
      )
      if (baseline && !exactCohortMatches(baseline, requestRun)) {
        await fulfillError(
          route,
          400,
          'invalid evaluation request: candidate cohort must match the baseline',
        )
        return
      }
      const idempotentRun = request.client_request_id
        ? runs.find((run) => run.client_request_id === request.client_request_id)
        : null
      if (idempotentRun) {
        if (!createRequestMatchesRun(request, idempotentRun)) {
          await fulfillError(
            route,
            409,
            'conflict: client_request_id was already used for a different evaluation run',
          )
          return
        }
        await mutationDelay()
        await fulfillJSON(route, 201, idempotentRun)
        return
      }
      createdRequests.push(request)
      const created = evaluationRun(
        `created-run-${createdRequests.length}`,
        request.name.trim(),
        'pending',
        '2026-08-29T01:00:00Z',
        request.change_profile,
        {
          client_request_id: request.client_request_id,
          description: request.description.trim(),
          mode: request.mode,
          target_id: request.target_id,
          suite_ids: request.suite_ids,
          track_ids: request.track_ids,
          sample_limit: request.sample_limit,
          concurrency: request.concurrency,
          seed: request.seed,
          baseline_run_id: request.baseline_run_id,
          evidence_level: 'E0',
        },
      )
      runs = [created, ...runs]
      await mutationDelay()
      await fulfillJSON(route, 201, created)
      return
    }
    await fulfillJSON(route, 200, runs)
  })

  return {
    createAttempts,
    createdRequests,
    comparisonRequests,
    reportRequests,
    getCancelCount: () => cancelCount,
    getDeleteCount: () => deleteCount,
    getStartCount: () => startCount,
    getEventStreamCount: () => eventStreamCount,
    getRuns: () => [...runs],
  }
}
