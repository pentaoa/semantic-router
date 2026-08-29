import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationCatalog, EvaluationRun } from '../../types/evaluationPlane'
import EvaluationExperimentForm from './EvaluationExperimentForm'
import {
  baselineCohortIssue,
  compatibleEvaluationSuites,
  exactCohortFromRun,
  minimumEvidenceClaimCeiling,
  newEvaluationClientRequestID,
  selectedSuiteTracks,
  toggleEvaluationSuite,
  validateEvaluationDraft,
} from './evaluationExperiment'

const catalog: EvaluationCatalog = {
  schema_version: 'evaluation.v1',
  gate_contract_version: 'evaluation-gates.v1',
  change_profiles: [{ id: 'recipe', name: 'Recipe', description: 'Recipe change' }],
  tracks: [
    {
      id: 'routing',
      name: 'Routing',
      description: 'Routing evidence',
      modes: ['replay'],
      metrics: ['routing.accuracy'],
    },
    {
      id: 'joint',
      name: 'Joint',
      description: 'Joint evidence',
      modes: ['replay'],
      metrics: ['joint.quality'],
    },
    {
      id: 'model_pool',
      name: 'Model pool',
      description: 'Pool evidence',
      modes: ['replay'],
      metrics: ['model_pool.oracle_gain'],
    },
  ],
  suites: [
    {
      id: 'routing-suite',
      name: 'Routing suite',
      description: 'Routing and joint cases',
      track_ids: ['routing', 'joint'],
      modes: ['replay'],
      evidence_level: 'E4',
    },
    {
      id: 'pool-suite',
      name: 'Pool suite',
      description: 'Joint and pool cases',
      track_ids: ['joint', 'model_pool'],
      modes: ['replay'],
      evidence_level: 'E2',
    },
    {
      id: 'live-suite',
      name: 'Live suite',
      description: 'Not compatible with the replay target',
      track_ids: ['routing'],
      modes: ['live'],
      evidence_level: 'E5',
    },
  ],
  targets: [
    {
      id: 'fixture',
      name: 'Fixture',
      description: 'Replay fixture',
      kind: 'fixture',
      track_ids: ['routing', 'joint', 'model_pool'],
      modes: ['replay'],
      healthy: true,
    },
  ],
}

const baseline: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: 'baseline-1',
  name: 'Baseline',
  description: 'Reference cohort',
  status: 'completed',
  mode: 'replay',
  evidence_level: 'E2',
  target_id: 'fixture',
  change_profile: 'recipe',
  suite_ids: ['routing-suite', 'pool-suite'],
  track_ids: ['routing', 'joint', 'model_pool'],
  sample_limit: 100,
  concurrency: 4,
  seed: 42,
  progress: { percent: 100, completed: 3, total: 3 },
  created_at: '2026-08-30T00:00:00Z',
  completed_at: '2026-08-30T00:01:00Z',
}

describe('evaluation experiment cohort helpers', () => {
  it('uses the least-qualified selected suite as the evidence claim ceiling', () => {
    expect(minimumEvidenceClaimCeiling(catalog, ['routing-suite', 'pool-suite'])).toBe('E2')
    expect(minimumEvidenceClaimCeiling(catalog, ['routing-suite'])).toBe('E4')
    expect(minimumEvidenceClaimCeiling(catalog, ['missing-suite'])).toBeNull()
  })

  it('creates backend-valid, collision-resistant idempotency tokens', () => {
    const first = newEvaluationClientRequestID()
    const second = newEvaluationClientRequestID()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
  })

  it('prunes tracks orphaned by removing a suite while preserving shared tracks', () => {
    const next = toggleEvaluationSuite(
      catalog,
      'fixture',
      'replay',
      ['routing-suite', 'pool-suite'],
      ['routing', 'joint', 'model_pool'],
      'routing-suite',
    )
    expect(next).toEqual({
      suiteIDs: ['pool-suite'],
      trackIDs: ['joint', 'model_pool'],
    })
    expect(selectedSuiteTracks(catalog, 'fixture', 'replay', next.suiteIDs)).toEqual([
      'joint',
      'model_pool',
    ])
  })

  it('does not add a suite that the target and mode cannot execute', () => {
    expect(
      compatibleEvaluationSuites(catalog, 'fixture', 'replay').map((suite) => suite.id),
    ).toEqual(['routing-suite', 'pool-suite'])
    expect(toggleEvaluationSuite(catalog, 'fixture', 'replay', [], [], 'live-suite')).toEqual({
      suiteIDs: [],
      trackIDs: [],
    })
  })

  it('copies all eight exact cohort dimensions and rejects unavailable baselines', () => {
    expect(exactCohortFromRun(baseline)).toEqual({
      mode: 'replay',
      targetID: 'fixture',
      changeProfile: 'recipe',
      suiteIDs: ['routing-suite', 'pool-suite'],
      trackIDs: ['routing', 'joint', 'model_pool'],
      sampleLimit: 100,
      concurrency: 4,
      seed: 42,
    })
    expect(baselineCohortIssue(catalog, baseline)).toBeNull()
    expect(baselineCohortIssue(catalog, { ...baseline, concurrency: 129 })).toContain('concurrency')
    expect(baselineCohortIssue(catalog, { ...baseline, suite_ids: ['removed-suite'] })).toContain(
      'no longer exactly reproducible',
    )
  })

  it('validates backend byte and numeric bounds and exact baseline matching', () => {
    const validDraft = {
      name: 'Candidate',
      description: 'Comparable change',
      ...exactCohortFromRun(baseline),
      baselineRunID: baseline.id,
    }
    const unpairedDraft = { ...validDraft, baselineRunID: '' }
    expect(validateEvaluationDraft(catalog, [baseline], validDraft)).toBeNull()
    expect(
      validateEvaluationDraft(catalog, [baseline], {
        ...unpairedDraft,
        name: 'x'.repeat(200),
        description: 'x'.repeat(4000),
        concurrency: 128,
        seed: 4294967295,
      }),
    ).toBeNull()
    expect(
      validateEvaluationDraft(catalog, [baseline], {
        ...unpairedDraft,
        description: 'x'.repeat(4001),
      }),
    ).toBe('Description must be at most 4000 bytes.')
    expect(
      validateEvaluationDraft(catalog, [baseline], { ...unpairedDraft, concurrency: 129 }),
    ).toBe('Concurrency must be an integer between 1 and 128.')
    expect(
      validateEvaluationDraft(catalog, [baseline], { ...unpairedDraft, seed: 4294967296 }),
    ).toBe('Seed must be an integer between 0 and 4294967295.')
    expect(
      validateEvaluationDraft(catalog, [baseline], {
        ...unpairedDraft,
        suiteIDs: ['routing-suite'],
        trackIDs: ['model_pool'],
      }),
    ).toBe('The selected suites and tracks are no longer compatible with the target and mode.')
    expect(validateEvaluationDraft(catalog, [baseline], { ...validDraft, seed: 43 })).toBe(
      'The candidate cohort must exactly match the selected baseline.',
    )
    expect(
      validateEvaluationDraft(catalog, [baseline], { ...unpairedDraft, name: '界'.repeat(67) }),
    ).toBe('Experiment name must be at most 200 bytes.')
  })
})

describe('EvaluationExperimentForm contract', () => {
  it('locks the complete form while pending and exposes backend-aligned input bounds', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationExperimentForm, {
        catalog,
        runs: [baseline],
        canCreate: true,
        canAutoStart: true,
        runLedgerComplete: true,
        pending: true,
        onSubmit: async () => true,
      }),
    )
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('<fieldset disabled=""')
    expect(markup).toContain('maxLength="200"')
    expect(markup).toContain('maxLength="4000"')
    expect(markup).toContain('max="128"')
    expect(markup).toContain('max="4294967295"')
    expect(markup).toContain('Claim ceiling E4')
  })

  it('explains when the selected target has no compatible suites or tracks', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationExperimentForm, {
        catalog: {
          ...catalog,
          targets: [
            {
              ...catalog.targets[0],
              modes: ['live'],
            },
          ],
        },
        runs: [],
        canCreate: true,
        canAutoStart: false,
        runLedgerComplete: true,
        pending: false,
        onSubmit: async () => true,
      }),
    )
    expect(markup).toContain(
      'Select a healthy catalog target that supports replay, or choose another mode.',
    )
    expect(markup).toContain('Select a compatible benchmark suite to make its tracks available.')
    expect(markup).toContain('Evidence pending')
  })
})
