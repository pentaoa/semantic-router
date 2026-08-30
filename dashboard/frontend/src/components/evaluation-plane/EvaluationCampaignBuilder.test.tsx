import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationCatalog, EvaluationCatalogCampaignSlot } from '../../types/evaluationPlane'
import EvaluationCampaign from './EvaluationCampaign'

const catalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: 'evaluation-release-gates.v2',
  generated_at: '2026-08-30T00:00:00Z',
  change_profiles: [
    {
      id: 'recipe',
      name: 'Routing recipe',
      description: 'A recipe-only promotion boundary.',
      campaign_slots: (
        [
          {
            gate_id: 'G2',
            name: 'Hard policy',
            description: 'Policy evidence.',
            disposition: 'advisory',
            binding_kind: 'run',
            minimum_evidence_level: 'E0',
            accepted_executor_ids: ['live-runtime.v1'],
          },
          {
            gate_id: 'G3',
            name: 'Controlled paired-live value',
            description: 'Controlled paired value evidence.',
            disposition: 'required',
            binding_kind: 'controlled_pair',
            mode: 'live',
            track_id: 'joint',
            minimum_evidence_level: 'E4',
            accepted_executor_ids: ['live-runtime.v1'],
          },
          ...(['G4', 'G6', 'G7', 'G8', 'G9'] as const).map((gate_id) => ({
            gate_id,
            name: `${gate_id} evidence`,
            description: 'Optional evidence.',
            disposition: 'advisory' as const,
            binding_kind: 'run' as const,
            minimum_evidence_level: 'E0' as const,
            accepted_executor_ids: ['live-runtime.v1'],
          })),
          {
            gate_id: 'G5',
            name: 'Live fidelity',
            description: 'Reference and live fidelity evidence.',
            disposition: 'advisory',
            binding_kind: 'fidelity_pair',
            track_id: 'joint',
            mode: 'live',
            minimum_evidence_level: 'E5',
            accepted_executor_ids: ['normalized-suite-live.v1', 'live-runtime.v1'],
          },
        ] as EvaluationCatalogCampaignSlot[]
      ).sort((left, right) => left.gate_id.localeCompare(right.gate_id)),
    },
  ],
  tracks: [],
  suites: [],
  targets: [],
}

describe('EvaluationCampaignBuilder workspace', () => {
  it('renders one compact evidence matrix, progressive context, and one primary submit action', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationCampaign, {
        catalog,
        runs: [],
        totalRuns: 0,
        runLedgerAvailable: true,
        runLedgerComplete: true,
        allRunsLoaded: true,
        loadingAllRuns: false,
        canCreate: true,
        createPending: false,
        createError: null,
        campaign: null,
        campaignLoading: false,
        campaignError: null,
        onLoadAllRuns: () => undefined,
        onRefreshRuns: () => true,
        onCreate: async () => null,
        onClearCreateError: () => undefined,
        onRetryCampaign: () => undefined,
        onClearCampaign: () => undefined,
      }),
    )

    expect(markup).toContain('aria-label="Campaign evidence slots"')
    expect(markup).toContain('<table')
    expect(markup).toContain('<th scope="col">Gate slot</th>')
    expect(markup).toContain('G3 · Controlled paired-live value')
    expect(markup).toContain('Advisory · optional')
    expect(markup).toContain('<details')
    expect(markup).toContain('Optional release rationale')
    expect(markup).toContain(
      'No completed, sealed live Mixture source is available for this G3 slot.',
    )
    expect(markup).not.toContain('Only five UUIDs cross the wire')
    expect(markup.match(/type="submit"/g)).toHaveLength(1)
    expect(markup).toContain('Create promotion decision')
  })
})
