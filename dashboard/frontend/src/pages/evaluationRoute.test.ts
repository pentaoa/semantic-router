import { describe, expect, it } from 'vitest'

import {
  parseEvaluationRoute,
  removeEvaluationRun,
  serializeEvaluationRoute,
} from './evaluationRoute'

describe('evaluation route contract', () => {
  it('keeps only state owned by the active workspace', () => {
    expect(
      parseEvaluationRoute(
        new URLSearchParams(
          'view=reports&report=report-1&run=stale&baseline=stale&candidate=stale',
        ),
      ),
    ).toEqual({ view: 'reports', reportRunID: 'report-1' })
    expect(serializeEvaluationRoute({ view: 'reports', reportRunID: 'report-1' }).toString()).toBe(
      'view=reports&report=report-1',
    )
  })

  it('normalizes unknown workspaces to overview', () => {
    expect(parseEvaluationRoute(new URLSearchParams('view=unknown&report=ignored'))).toEqual({
      view: 'overview',
    })
    expect(serializeEvaluationRoute({ view: 'overview' }).toString()).toBe('')
  })

  it('round-trips a public Mixture entrypoint without accepting an execution address', () => {
    const route = parseEvaluationRoute(
      new URLSearchParams('view=new&entrypoint=vllm-sr%2Fauto&target_url=http%3A%2F%2Fprivate'),
    )
    expect(route).toEqual({ view: 'new', entrypoint: 'vllm-sr/auto' })
    expect(serializeEvaluationRoute(route).toString()).toBe('view=new&entrypoint=vllm-sr%2Fauto')
  })

  it('clears a deleted run only from the workspace that owns it', () => {
    expect(
      removeEvaluationRun(
        {
          view: 'compare',
          baselineRunID: 'baseline',
          candidateRunID: 'candidate',
          campaignID: 'campaign',
        },
        'candidate',
      ),
    ).toEqual({
      view: 'compare',
      baselineRunID: null,
      candidateRunID: null,
      campaignID: 'campaign',
    })
  })

  it('round-trips the immutable campaign decision independently from a diagnostic pair', () => {
    const route = parseEvaluationRoute(
      new URLSearchParams('view=compare&campaign=campaign-1&baseline=baseline&candidate=candidate'),
    )
    expect(route).toEqual({
      view: 'compare',
      baselineRunID: 'baseline',
      candidateRunID: 'candidate',
      campaignID: 'campaign-1',
    })
    expect(serializeEvaluationRoute(route).toString()).toBe(
      'view=compare&baseline=baseline&candidate=candidate&campaign=campaign-1',
    )
  })
})
