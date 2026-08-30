import { describe, expect, it } from 'vitest'

import type { EvaluationCatalogCampaignSlot, EvaluationRun } from '../types/evaluationPlane'
import { decodeEvaluationCatalog } from './evaluationCatalogContract'
import {
  decodeEvaluationRun,
  decodeEvaluationRunEvent,
  decodeEvaluationRunLedger,
  isCanonicalEvaluationRunID,
} from './evaluationRunContract'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
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
  description: '',
  disposition: 'not_applicable',
  binding_kind,
  minimum_evidence_level: 'E0',
  accepted_executor_ids: [],
})) as EvaluationCatalogCampaignSlot[]

const run: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: RUN_ID,
  client_request_id: RUN_ID,
  name: 'Strict contract run',
  description: '',
  status: 'completed',
  mode: 'replay',
  evidence_level: 'E0',
  track_evidence_levels: { routing: 'E0' },
  target_id: 'fixture',
  change_profile: 'recipe',
  suite_ids: ['evaluation-smoke'],
  track_ids: ['routing'],
  sample_limit: 4,
  concurrency: 1,
  seed: 42,
  progress: { percent: 100, completed: 1, total: 1 },
  created_at: '2026-08-30T00:00:00Z',
  completed_at: '2026-08-30T00:01:00Z',
}

describe('evaluation current-contract codec', () => {
  it('requires one explicit executor per advertised suite mode', () => {
    const catalog = {
      schema_version: 'evaluation.v1',
      gate_contract_version: 'evaluation-release-gates.v2',
      generated_at: '2026-08-30T00:00:00Z',
      change_profiles: [
        { id: 'recipe', name: 'Recipe', description: '', campaign_slots: campaignSlots },
      ],
      tracks: [
        {
          id: 'routing',
          name: 'Routing',
          description: 'Pinned exploratory import; native execution is not attested',
          modes: ['replay', 'live'],
          metrics: [],
          evidence_levels: ['E5'],
        },
      ],
      suites: [
        {
          id: 'installed-routing',
          executors: {
            replay: 'normalized-suite-replay.v1',
            live: 'normalized-suite-live.v1',
          },
          name: 'Installed routing',
          description: '',
          track_ids: ['routing'],
          modes: ['replay', 'live'],
          evidence_level: 'E0',
          campaign_eligible: false,
          campaign_minimum_cases: 0,
          revision: 'sha256:revision',
          tags: [],
          methods: [
            {
              id: 'routing.normalized-replay-live.v1',
              track_id: 'routing',
              qualified_gate_ids: [],
              evidence_source: 'normalized_import',
              status: 'configured',
            },
          ],
        },
      ],
      targets: [
        {
          id: 'benchmark-source',
          name: 'Benchmark source',
          description: '',
          kind: 'benchmark-source',
          track_ids: ['routing'],
          modes: ['replay'],
          accepted_executors: { replay: ['normalized-suite-replay.v1'] },
        },
      ],
    }

    expect(decodeEvaluationCatalog(catalog).suites[0]?.executors).toEqual({
      replay: 'normalized-suite-replay.v1',
      live: 'normalized-suite-live.v1',
    })
    const brokeredCatalog = {
      ...catalog,
      suites: [
        {
          ...catalog.suites[0],
          methods: [
            {
              id: 'routing.declared-shift-live.v1',
              track_id: 'routing',
              qualified_gate_ids: ['G4'],
              evidence_source: 'server_brokered_live',
              status: 'configured',
            },
          ],
        },
      ],
    }
    expect(decodeEvaluationCatalog(brokeredCatalog).suites[0]?.methods[0]).toMatchObject({
      evidence_source: 'server_brokered_live',
      qualified_gate_ids: ['G4'],
    })
    for (const method of [
      { ...brokeredCatalog.suites[0].methods[0], qualified_gate_ids: ['G3'] },
      { ...brokeredCatalog.suites[0].methods[0], status: 'qualified' },
    ]) {
      expect(() =>
        decodeEvaluationCatalog({
          ...brokeredCatalog,
          suites: [{ ...brokeredCatalog.suites[0], methods: [method] }],
        }),
      ).toThrow(/catalog response is incomplete/i)
    }
    expect(() =>
      decodeEvaluationCatalog({
        ...catalog,
        suites: [{ ...catalog.suites[0], executors: { replay: 'normalized-suite-replay.v1' } }],
      }),
    ).toThrow(/catalog response is incomplete/i)
    expect(() =>
      decodeEvaluationCatalog({
        ...catalog,
        suites: [
          {
            ...catalog.suites[0],
            executor_id: 'retired-universal-executor',
          },
        ],
      }),
    ).toThrow(/catalog response is incomplete/i)
  })

  it('requires the clean-break agent campaign contract', () => {
    const agentSlots = campaignSlots.map((slot) => ({ ...slot }))
    agentSlots[1] = { ...agentSlots[1], disposition: 'not_applicable' }
    agentSlots[3] = {
      ...agentSlots[3],
      disposition: 'required',
      track_id: 'multimodal',
      mode: 'live',
      minimum_evidence_level: 'E4',
      accepted_executor_ids: ['normalized-suite-live.v1'],
    }
    const catalog = {
      schema_version: 'evaluation.v1',
      gate_contract_version: 'evaluation-release-gates.v2',
      generated_at: '2026-08-30T00:00:00Z',
      change_profiles: [
        {
          id: 'agent_multimodal',
          name: 'Agent / multimodal',
          description: '',
          campaign_slots: agentSlots,
        },
      ],
      tracks: [],
      suites: [],
      targets: [],
    }
    expect(decodeEvaluationCatalog(catalog).change_profiles[0]?.campaign_slots[3]).toMatchObject({
      track_id: 'multimodal',
      minimum_evidence_level: 'E4',
    })
    for (const slots of [
      agentSlots.map((slot, index) =>
        index === 1 ? { ...slot, disposition: 'required' } : { ...slot },
      ),
      agentSlots.map((slot, index) => (index === 3 ? { ...slot, track_id: 'joint' } : { ...slot })),
    ]) {
      expect(() =>
        decodeEvaluationCatalog({
          ...catalog,
          change_profiles: [{ ...catalog.change_profiles[0], campaign_slots: slots }],
        }),
      ).toThrow(/catalog response is incomplete/i)
    }
  })

  it('accepts only canonical run identities and exact run fields', () => {
    expect(isCanonicalEvaluationRunID(RUN_ID)).toBe(true)
    expect(isCanonicalEvaluationRunID('run-1')).toBe(false)
    expect(decodeEvaluationRun(run, RUN_ID)).toEqual(run)
    expect(
      decodeEvaluationRun(
        {
          ...run,
          status: 'sealing',
          started_at: '2026-08-30T00:00:01Z',
          completed_at: undefined,
          progress: {
            percent: 100,
            completed: 1,
            total: 1,
            message: 'Sealing evaluation evidence',
          },
        },
        RUN_ID,
      ).status,
    ).toBe('sealing')
    expect(() => decodeEvaluationRun({ ...run, retired_status: 'ready' }, RUN_ID)).toThrow(
      /run response is incomplete/i,
    )
  })

  it('keeps ledger warning evidence identities opaque and non-navigable', () => {
    const ledger = {
      schema_version: 'evaluation.v1',
      runs: [run],
      total_runs: 1,
      ledger_complete: false,
      warning_count: 1,
      warnings: [
        {
          code: 'unexpected_entry',
          evidence_id: `sha256:${'a'.repeat(64)}`,
          evidence_file: '',
          message: 'Unexpected durable entry was quarantined.',
        },
      ],
    }

    expect(decodeEvaluationRunLedger(ledger).warnings[0]?.evidence_id).toMatch(/^sha256:/)
    expect(() =>
      decodeEvaluationRunLedger({
        ...ledger,
        warnings: [{ ...ledger.warnings[0], run_id: 'retired-run-identity' }],
      }),
    ).toThrow(/ledger response is invalid or incomplete/i)
  })

  it('preserves the typed record count for track evidence events', () => {
    const event = decodeEvaluationRunEvent(
      {
        id: '2',
        run_id: RUN_ID,
        type: 'track',
        timestamp: '2026-08-30T00:00:30Z',
        message: 'Evaluation track evidence collected',
        track_id: 'routing',
        progress: {
          percent: 100,
          completed: 1,
          total: 1,
          current_track_id: 'routing',
          message: 'Evaluation track evidence collected',
        },
        payload: { record_count: 17 },
      },
      run,
    )

    expect(event.type).toBe('track')
    if (event.type !== 'track') throw new Error('Expected a typed track event.')
    expect(event.payload.record_count).toBe(17)
  })

  it('rejects unknown or event-mismatched durable SSE payloads', () => {
    const base = {
      id: '3',
      run_id: RUN_ID,
      timestamp: '2026-08-30T00:00:45Z',
      message: 'Evaluation progress updated',
    }
    const trackProgress = {
      percent: 100,
      completed: 1,
      total: 1,
      current_track_id: 'routing',
      message: 'Evaluation track evidence collected',
    }

    expect(() =>
      decodeEvaluationRunEvent(
        {
          ...base,
          type: 'track',
          track_id: 'routing',
          progress: trackProgress,
          payload: { record_count: 1, retired_detail: 'not public' },
        },
        run,
      ),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent(
        {
          ...base,
          type: 'track',
          track_id: 'routing',
          progress: trackProgress,
          payload: { record_count: -1 },
        },
        run,
      ),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent(
        {
          ...base,
          type: 'track',
          track_id: 'routing',
          progress: { ...trackProgress, current_track_id: 'capacity' },
          payload: { record_count: 1 },
        },
        run,
      ),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent(
        {
          ...base,
          type: 'track',
          track_id: 'routing',
          progress: trackProgress,
          payload: { verdict: 'pass' },
        },
        run,
      ),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent({ ...base, type: 'progress', payload: { record_count: 1 } }, run),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent({ ...base, type: 'completed', payload: { verdict: 'pass' } }, run),
    ).toThrow(/invalid event/i)
  })

  it('enforces durable event identity, message, and run-bound progress semantics', () => {
    const base = {
      id: '4',
      run_id: RUN_ID,
      type: 'progress' as const,
      timestamp: '2026-08-30T00:00:45Z',
      message: 'Evaluation progress updated',
      progress: { percent: 50, completed: 0, total: 1 },
    }

    expect(decodeEvaluationRunEvent(base, run)).toEqual(base)
    for (const id of ['', '0', '01', 'event-4', '18446744073709551616']) {
      expect(() => decodeEvaluationRunEvent({ ...base, id }, run)).toThrow(/invalid event/i)
    }
    for (const message of ['', ' not trimmed', 'not trimmed ', '界'.repeat(171)]) {
      expect(() => decodeEvaluationRunEvent({ ...base, message }, run)).toThrow(/invalid event/i)
    }
    expect(() =>
      decodeEvaluationRunEvent({ ...base, progress: { ...base.progress, total: 2 } }, run),
    ).toThrow(/invalid event/i)
    expect(() =>
      decodeEvaluationRunEvent(
        {
          ...base,
          progress: { ...base.progress, message: ' malformed ' },
        },
        run,
      ),
    ).toThrow(/invalid event/i)
  })

  it('requires server-owned terminal progress and exact completed semantics', () => {
    const base = {
      id: '5',
      run_id: RUN_ID,
      timestamp: '2026-08-30T00:01:00Z',
      message: 'Evaluation completed',
    }
    const completed = {
      ...base,
      type: 'completed' as const,
      progress: { percent: 100, completed: 1, total: 1, message: 'Evaluation completed' },
    }

    expect(decodeEvaluationRunEvent(completed, run)).toEqual(completed)
    expect(() =>
      decodeEvaluationRunEvent(
        { ...completed, progress: { ...completed.progress, percent: 99 } },
        run,
      ),
    ).toThrow(/invalid event/i)
    expect(() => decodeEvaluationRunEvent({ ...base, type: 'failed' }, run)).toThrow(
      /invalid event/i,
    )
    expect(() => decodeEvaluationRunEvent({ ...base, type: 'cancelled' }, run)).toThrow(
      /invalid event/i,
    )
  })
})
