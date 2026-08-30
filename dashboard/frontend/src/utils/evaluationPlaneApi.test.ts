import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CreateEvaluationRunPayload,
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationRun,
  EvaluationRunEvent,
} from '../types/evaluationPlane'
import type { CreateEvaluationCampaignPayload } from '../types/evaluationCampaign'
import type { CreateEvaluationControlledPairPayload } from '../types/evaluationControlledPair'
import {
  buildCreateRunPayload,
  cancelEvaluationRun,
  compareEvaluationRuns,
  createEvaluationCampaign,
  createEvaluationControlledPair,
  createEvaluationRun,
  deleteEvaluationRun,
  getEvaluationCatalog,
  getEvaluationCampaign,
  getEvaluationArtifactURL,
  getEvaluationReport,
  getEvaluationRun,
  isDownloadableEvaluationArtifact,
  listEvaluationRuns,
  startEvaluationRun,
  subscribeToEvaluationRun,
} from './evaluationPlaneApi'

const CREATE_RUN_ID = '4d0b4f2c-1fc5-40b0-b04e-876ad9d4d8e2'
const RUN_ID = '11111111-1111-4111-8111-111111111111'
const BASELINE_RUN_ID = '22222222-2222-4222-8222-222222222222'
const CANDIDATE_RUN_ID = '33333333-3333-4333-8333-333333333333'
const QUARANTINED_EVIDENCE_ID = 'bundle-entry-7f9d2a'
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444'
const CAMPAIGN_LIVE_ID = '55555555-5555-4555-8555-555555555555'
const CAMPAIGN_LIVE_BASELINE_ID = '66666666-6666-4666-8666-666666666666'
const CAMPAIGN_CONFIRMATION_ID = '77777777-7777-4777-8777-777777777777'

const campaignSlots = [
  ['G2', 'run'],
  ['G3', 'controlled_pair'],
  ['G4', 'run'],
  ['G5', 'fidelity_pair'],
  ['G6', 'run'],
  ['G7', 'run'],
  ['G8', 'run'],
  ['G9', 'run'],
].map(([gate_id, binding_kind]) => ({
  gate_id,
  name: `${gate_id} evidence`,
  description: 'Server campaign slot.',
  disposition: 'not_applicable',
  binding_kind,
  minimum_evidence_level: 'E0',
  accepted_executor_ids: [],
})) as EvaluationCatalogCampaignSlot[]

const catalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: 'evaluation-release-gates.v2',
  generated_at: '2026-08-29T00:00:00Z',
  change_profiles: [
    {
      id: 'recipe',
      name: 'Routing recipe',
      description: 'Recipe signal, decision, algorithm, and policy changes.',
      campaign_slots: campaignSlots,
    },
  ],
  tracks: [
    {
      id: 'routing',
      name: 'Routing',
      description: 'Routing quality',
      modes: ['replay'],
      metrics: [],
      evidence_levels: ['E2'],
    },
  ],
  suites: [
    {
      id: 'suite-routing',
      executors: { replay: 'fixture-replay.v1' },
      name: 'Routing suite',
      description: 'Replay suite',
      track_ids: ['routing'],
      modes: ['replay'],
      evidence_level: 'E2',
      campaign_eligible: false,
      campaign_minimum_cases: 0,
      revision: 'suite-routing.v1',
      tags: ['fixture'],
      methods: [
        {
          id: 'fixture.routing.v1',
          track_id: 'routing',
          qualified_gate_ids: [],
          evidence_source: 'diagnostic_fixture',
          status: 'configured',
        },
      ],
    },
  ],
  targets: [
    {
      id: 'target-approved',
      name: 'Approved target',
      description: 'Server target',
      kind: 'replay',
      track_ids: ['routing'],
      modes: ['replay'],
      accepted_executors: { replay: ['fixture-replay.v1'] },
    },
  ],
}

const request: CreateEvaluationRunPayload = {
  client_request_id: CREATE_RUN_ID,
  name: ' Candidate ',
  description: ' Compare recipe ',
  suite_ids: ['suite-routing'],
  track_ids: ['routing'],
  mode: 'replay',
  target_id: 'target-approved',
  change_profile: 'recipe',
  sample_limit: 25,
  concurrency: 2,
  seed: 42,
}

const run: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: RUN_ID,
  client_request_id: RUN_ID,
  name: 'Candidate',
  description: 'Compare recipe',
  status: 'pending',
  mode: 'replay',
  evidence_level: 'E2',
  track_evidence_levels: { routing: 'E2' },
  target_id: 'target-approved',
  change_profile: 'recipe',
  suite_ids: ['suite-routing'],
  track_ids: ['routing'],
  sample_limit: 25,
  concurrency: 2,
  seed: 42,
  progress: { percent: 0, completed: 0, total: 1 },
  created_at: '2026-08-29T00:00:00Z',
}

const completedRun: EvaluationRun = {
  ...run,
  status: 'completed',
  progress: { percent: 100, completed: 1, total: 1 },
  started_at: '2026-08-29T00:00:01Z',
  completed_at: '2026-08-29T00:00:02Z',
}

function reportFor(reportRun: EvaluationRun) {
  return {
    schema_version: 'evaluation.v1',
    attestation_revision: 'evaluation-server-attestation.v2',
    run: reportRun,
    summary: {
      verdict: 'unavailable',
      quality_score: null,
      latency_p95_ms: null,
      runtime_cost: null,
      capacity_tco: null,
      coverage: { evaluated: 0, total: 0, fraction: 0 },
      passed_gates: 0,
      failed_gates: 0,
      unavailable_gates: 0,
    },
    tracks: [],
    metrics: [],
    gates: [],
    costs: {
      runtime: { amount: null, currency: 'USD' },
      evaluation_overhead: { amount: null, currency: 'USD' },
      capacity_tco: { amount: null, currency: 'USD' },
    },
    recommendations: [],
    provenance: {
      schema_version: 'evaluation.v1',
      generated_at: '2026-08-29T00:00:02Z',
      target_id: reportRun.target_id,
      seed: reportRun.seed,
    },
    artifacts: [],
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Evaluation Plane API', () => {
  it('keeps native SSE reconnect active, deduplicates event ids, and stops at terminal events', () => {
    class FakeEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      static instances: FakeEventSource[] = []

      readonly listeners = new Map<string, EventListener[]>()
      readonly close = vi.fn(() => {
        this.readyState = FakeEventSource.CLOSED
      })
      readyState = FakeEventSource.CONNECTING
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor(readonly url: string) {
        FakeEventSource.instances.push(this)
      }

      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, [...(this.listeners.get(name) || []), listener])
      }

      emit(name: string, event: EvaluationRunEvent) {
        const message = { data: JSON.stringify(event) } as MessageEvent<string>
        this.listeners.get(name)?.forEach((listener) => listener(message))
      }

      fail(readyState: number) {
        this.readyState = readyState
        this.onerror?.({ type: 'error' } as Event)
      }
    }

    vi.stubGlobal('EventSource', FakeEventSource)
    const onEvent = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const unsubscribe = subscribeToEvaluationRun(run, onEvent, onTerminal, onError)
    const source = FakeEventSource.instances[0]

    expect(source?.url).toBe(`/api/evaluation/v1/runs/${RUN_ID}/events`)
    source?.fail(FakeEventSource.CONNECTING)
    expect(source?.close).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    const progress: EvaluationRunEvent = {
      id: '1',
      run_id: RUN_ID,
      type: 'progress',
      timestamp: '2026-08-29T00:00:00Z',
      message: 'Routing track started',
    }
    source?.emit('progress', progress)
    source?.emit('progress', progress)
    expect(onEvent).toHaveBeenCalledTimes(1)

    source?.emit('completed', {
      ...progress,
      id: '2',
      type: 'completed',
      message: 'Evaluation completed',
      progress: {
        percent: 100,
        completed: 1,
        total: 1,
        message: 'Evaluation completed',
      },
    })
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(source?.close).toHaveBeenCalledTimes(1)
    source?.emit('progress', { ...progress, id: '3' })
    expect(onEvent).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('terminates a server-closed SSE stream instead of retrying it', () => {
    class ClosedEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      static instance: ClosedEventSource | null = null

      readonly close = vi.fn()
      readyState = ClosedEventSource.CONNECTING
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor(readonly url: string) {
        ClosedEventSource.instance = this
      }

      addEventListener() {}
    }

    vi.stubGlobal('EventSource', ClosedEventSource)
    const onError = vi.fn()
    subscribeToEvaluationRun(run, vi.fn(), vi.fn(), onError)
    const source = ClosedEventSource.instance
    if (!source) throw new Error('Expected the EventSource test double to be constructed.')

    source.readyState = ClosedEventSource.CLOSED
    source.onerror?.({ type: 'error' } as Event)

    expect(source.close).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      new Error('Evaluation event stream was closed by the server.'),
    )
  })

  it('rejects non-contract create fields and catalog identities', () => {
    const untrusted = {
      ...request,
      endpoint: 'https://arbitrary.invalid/v1',
      url: 'https://arbitrary.invalid',
      hidden_label: 'must never cross the browser contract',
    } as CreateEvaluationRunPayload
    expect(() => buildCreateRunPayload(untrusted, catalog)).toThrow(/non-contract fields/i)
    expect(() =>
      buildCreateRunPayload({ ...request, target_id: 'https://arbitrary.invalid' }, catalog),
    ).toThrow(/server evaluation catalog/i)
    expect(() =>
      buildCreateRunPayload({ ...request, change_profile: 'selector' }, catalog),
    ).toThrow(/change profile.*server evaluation catalog/i)
    expect(() =>
      buildCreateRunPayload({ ...request, client_request_id: 'retry-me' }, catalog),
    ).toThrow(/canonical UUID/i)
    expect(() =>
      buildCreateRunPayload({ ...request, suite_ids: ['suite-routing', 'suite-routing'] }, catalog),
    ).toThrow(/duplicate identities/i)
    expect(() => buildCreateRunPayload({ ...request, concurrency: 1.5 }, catalog)).toThrow(
      /concurrency must be an integer/i,
    )
  })

  it('preserves the client idempotency token in the create payload', () => {
    const payload = buildCreateRunPayload(
      { ...request, client_request_id: '4d0b4f2c-1fc5-40b0-b04e-876ad9d4d8e2' },
      catalog,
    )
    expect(payload.client_request_id).toBe('4d0b4f2c-1fc5-40b0-b04e-876ad9d4d8e2')
  })

  it('uses only the current campaign endpoints and canonical create body', async () => {
    const campaignRequest: CreateEvaluationCampaignPayload = {
      client_request_id: CAMPAIGN_ID,
      name: '  Recipe decision  ',
      description: '  Exact evidence roles.  ',
      change_profile: 'recipe',
      gate_bindings: {
        g2_run_id: CANDIDATE_RUN_ID,
        g3_controlled_pair: {
          baseline_run_id: CAMPAIGN_LIVE_BASELINE_ID,
          candidate_run_id: CAMPAIGN_LIVE_ID,
        },
        g5_fidelity: {
          reference_run_id: BASELINE_RUN_ID,
          live_run_id: CAMPAIGN_CONFIRMATION_ID,
        },
      },
    }
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, 201))
    vi.stubGlobal('fetch', fetch)

    await expect(createEvaluationCampaign(campaignRequest)).rejects.toThrow(
      /campaign response is incomplete/i,
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/evaluation/v1/campaigns',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ...campaignRequest,
          name: 'Recipe decision',
          description: 'Exact evidence roles.',
        }),
      }),
    )

    fetch.mockResolvedValueOnce(jsonResponse({}))
    await expect(getEvaluationCampaign(CAMPAIGN_ID)).rejects.toThrow(
      /campaign response is incomplete/i,
    )
    expect(fetch).toHaveBeenLastCalledWith(`/api/evaluation/v1/campaigns/${CAMPAIGN_ID}`, {
      signal: undefined,
    })
  })

  it('posts only the five controlled-pair UUIDs to the server-owned execution endpoint', async () => {
    const controlledPairRequest: CreateEvaluationControlledPairPayload = {
      client_request_id: '88888888-8888-4888-8888-888888888888',
      baseline_source_run_id: CAMPAIGN_LIVE_BASELINE_ID,
      candidate_source_run_id: CAMPAIGN_LIVE_ID,
      baseline_run_id: '99999999-9999-4999-8999-999999999999',
      candidate_run_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, 201))
    vi.stubGlobal('fetch', fetch)

    await expect(createEvaluationControlledPair(controlledPairRequest)).rejects.toThrow(
      /controlled pair response/i,
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/evaluation/v1/controlled-pairs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(controlledPairRequest),
      }),
    )
    expect(Object.keys(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).sort()).toEqual([
      'baseline_run_id',
      'baseline_source_run_id',
      'candidate_run_id',
      'candidate_source_run_id',
      'client_request_id',
    ])
  })

  it('rejects partially supported suites and tracks before creating a run', () => {
    const expandedCatalog: EvaluationCatalog = {
      ...catalog,
      tracks: [
        ...catalog.tracks,
        {
          id: 'agentic',
          name: 'Agentic',
          description: 'Trajectory evidence',
          modes: ['replay'],
          metrics: [],
          evidence_levels: ['E2'],
        },
      ],
      suites: [
        ...catalog.suites,
        {
          id: 'suite-partial',
          executors: { replay: 'fixture-replay.v1' },
          name: 'Partially supported suite',
          description: 'Requires routing and agentic evidence',
          track_ids: ['routing', 'agentic'],
          modes: ['replay'],
          evidence_level: 'E2',
          campaign_eligible: false,
          campaign_minimum_cases: 0,
          revision: 'suite-partial.v1',
          tags: ['fixture'],
          methods: [
            {
              id: 'fixture.partial-routing.v1',
              track_id: 'routing',
              qualified_gate_ids: [],
              evidence_source: 'diagnostic_fixture',
              status: 'configured',
            },
            {
              id: 'fixture.partial-agentic.v1',
              track_id: 'agentic',
              qualified_gate_ids: [],
              evidence_source: 'diagnostic_fixture',
              status: 'configured',
            },
          ],
        },
      ],
    }

    expect(() =>
      buildCreateRunPayload(
        {
          ...request,
          suite_ids: ['suite-partial'],
          track_ids: ['routing'],
        },
        expandedCatalog,
      ),
    ).toThrow(/fully supported/i)
    expect(() =>
      buildCreateRunPayload(
        {
          ...request,
          track_ids: ['agentic'],
        },
        expandedCatalog,
      ),
    ).toThrow(/selected track/i)
  })

  it('links only backend-allowlisted report artifacts and never the run manifest', () => {
    for (const name of [
      'routing-traces.jsonl',
      'capacity-profile.json',
      'metrics.json',
      'gates.json',
      'failure-summary.json',
      'provenance.json',
      'checksums.sha256',
    ]) {
      expect(isDownloadableEvaluationArtifact({ id: name, name, kind: 'evidence' })).toBe(true)
    }
    expect(
      isDownloadableEvaluationArtifact({ id: 'comparison', name: 'comparison.json', kind: 'json' }),
    ).toBe(false)
    expect(
      isDownloadableEvaluationArtifact({
        id: 'records.jsonl',
        name: 'Case records',
        kind: 'records',
      }),
    ).toBe(false)
    expect(
      isDownloadableEvaluationArtifact({
        id: 'failure-summary-json',
        name: 'failure-summary.json',
        kind: 'json',
      }),
    ).toBe(true)
    expect(
      isDownloadableEvaluationArtifact({
        id: 'report-html',
        name: 'Rendered report',
        kind: 'html',
      }),
    ).toBe(false)
    expect(
      isDownloadableEvaluationArtifact({
        id: 'run-manifest.json',
        name: 'Run manifest',
        kind: 'manifest',
      }),
    ).toBe(false)
    expect(getEvaluationArtifactURL(RUN_ID, 'records/visible.jsonl')).toBe(
      `/api/evaluation/v1/runs/${RUN_ID}/artifacts/records%2Fvisible.jsonl`,
    )
  })

  it('uses only the versioned catalog and run lifecycle endpoints', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(catalog))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          runs: [run],
          total_runs: 1,
          ledger_complete: true,
          warning_count: 0,
          warnings: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(
        jsonResponse({ ...run, id: CREATE_RUN_ID, client_request_id: CREATE_RUN_ID }, 201),
      )
      .mockResolvedValueOnce(jsonResponse({ ...run, status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ ...run, status: 'cancelled' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(reportFor(completedRun)))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          attestation_revision: 'evaluation-server-attestation.v2',
          baseline_run_id: BASELINE_RUN_ID,
          candidate_run_id: CANDIDATE_RUN_ID,
          verdict: 'unavailable',
          summary: 'No paired evidence is available.',
          metrics: [],
          statistics: [],
          gates: Array.from({ length: 10 }, (_, index) => ({
            id: `G${index}`,
            name: `Gate ${index}`,
            disposition: 'required',
            verdict: index === 3 ? 'unavailable' : 'pass',
            change_profile: 'recipe',
            contract_version: 'evaluation-release-gates.v2',
            evidence_refs:
              index === 3
                ? [
                    'server-reduction:comparative-g3.v1',
                    `run:baseline:${BASELINE_RUN_ID}`,
                    `run:candidate:${CANDIDATE_RUN_ID}`,
                    'comparison-statistic:joint.normalized_regret',
                  ]
                : [`gate:G${index}`],
            evidence_level: index === 3 ? 'E4' : 'E5',
            ...(index === 3 ? { owner: 'recipe-and-model-pool' } : {}),
          })),
          recommendations: [],
          created_at: '2026-08-29T00:00:02Z',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await getEvaluationCatalog()
    await expect(listEvaluationRuns()).resolves.toEqual({
      schema_version: 'evaluation.v1',
      runs: [run],
      total_runs: 1,
      ledger_complete: true,
      warning_count: 0,
      warnings: [],
    })
    await getEvaluationRun(RUN_ID)
    await createEvaluationRun(request, catalog)
    await startEvaluationRun(RUN_ID)
    await cancelEvaluationRun(RUN_ID)
    await deleteEvaluationRun(RUN_ID)
    await getEvaluationReport(RUN_ID)
    await compareEvaluationRuns(BASELINE_RUN_ID, CANDIDATE_RUN_ID)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/evaluation/v1/catalog',
      '/api/evaluation/v1/runs',
      `/api/evaluation/v1/runs/${RUN_ID}`,
      '/api/evaluation/v1/runs',
      `/api/evaluation/v1/runs/${RUN_ID}/start`,
      `/api/evaluation/v1/runs/${RUN_ID}/cancel`,
      `/api/evaluation/v1/runs/${RUN_ID}`,
      `/api/evaluation/v1/runs/${RUN_ID}/report`,
      `/api/evaluation/v1/compare?baseline_run_id=${BASELINE_RUN_ID}&candidate_run_id=${CANDIDATE_RUN_ID}`,
    ])
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'POST' })
    const createBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    expect(createBody).toMatchObject({ change_profile: 'recipe' })
    expect(createBody).not.toHaveProperty('auto_start')
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[6]?.[1]).toMatchObject({ method: 'DELETE' })
  })

  it('requires explicit and internally consistent ledger integrity metadata', async () => {
    const warning = {
      code: 'corrupt_run_bundle',
      evidence_id: QUARANTINED_EVIDENCE_ID,
      evidence_file: 'status.json',
      message: 'Durable run status evidence is unreadable or invalid and has been quarantined.',
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          runs: [run],
          total_runs: 1,
          ledger_complete: false,
          warning_count: 1,
          warnings: [warning],
        }),
      )
      .mockResolvedValueOnce(jsonResponse([run]))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          runs: [run],
          total_runs: 1,
          ledger_complete: true,
          warning_count: 1,
          warnings: [warning],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          runs: [],
          next_cursor: 'cursor-1',
          total_runs: 1,
          ledger_complete: true,
          warning_count: 0,
          warnings: [],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listEvaluationRuns()).resolves.toMatchObject({
      ledger_complete: false,
      warning_count: 1,
      warnings: [warning],
    })
    await expect(listEvaluationRuns()).rejects.toThrow(/ledger response is invalid or incomplete/i)
    await expect(listEvaluationRuns()).rejects.toThrow(/ledger response is invalid or incomplete/i)
    await expect(listEvaluationRuns({ cursor: 'cursor-1' })).rejects.toThrow(
      /ledger response is invalid or incomplete/i,
    )
  })

  it('rejects unknown fields and contract revisions in otherwise current resources', async () => {
    const comparison = {
      schema_version: 'evaluation.v1',
      attestation_revision: 'evaluation-server-attestation.v2',
      baseline_run_id: BASELINE_RUN_ID,
      candidate_run_id: CANDIDATE_RUN_ID,
      verdict: 'unavailable',
      summary: 'No paired evidence is available.',
      metrics: [],
      gates: [],
      recommendations: [],
      created_at: '2026-08-29T00:00:02Z',
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...catalog, retired_contract: true }))
      .mockResolvedValueOnce(jsonResponse({ ...run, retired_status: 'ready' }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...reportFor(completedRun),
          summary: { ...reportFor(completedRun).summary, retired_score: 1 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ...comparison, retired_verdict: 'pass' }))
      .mockResolvedValueOnce(
        jsonResponse({ ...catalog, gate_contract_version: 'evaluation-release-gates.v3' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getEvaluationCatalog()).rejects.toThrow(/catalog response is incomplete/i)
    await expect(getEvaluationRun(RUN_ID)).rejects.toThrow(/run response is incomplete/i)
    await expect(getEvaluationReport(RUN_ID)).rejects.toThrow(/report response is incomplete/i)
    await expect(compareEvaluationRuns(BASELINE_RUN_ID, CANDIDATE_RUN_ID)).rejects.toThrow(
      /requested pair/i,
    )
    await expect(getEvaluationCatalog()).rejects.toThrow(/catalog response is incomplete/i)
  })

  it('rejects responses outside the current run and attestation contracts', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 'evaluation.v1',
          run,
          metrics: [],
          gates: [],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getEvaluationRun(RUN_ID)).rejects.toThrow(/evaluation\.v1 contract/i)
    await expect(getEvaluationReport(RUN_ID)).rejects.toThrow(/current server contract/i)
  })
})
