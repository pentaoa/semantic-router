import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationRun, EvaluationRunEvent } from '../../types/evaluationPlane'
import EvaluationRunTimeline from './EvaluationRunTimeline'

const run: EvaluationRun = {
  schema_version: 'evaluation.v1',
  id: '11111111-1111-4111-8111-111111111111',
  client_request_id: '11111111-1111-4111-8111-111111111111',
  name: 'Timeline contract',
  description: '',
  status: 'running',
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
  progress: { percent: 50, completed: 0, total: 1 },
  created_at: '2026-08-30T00:00:00Z',
  started_at: '2026-08-30T00:00:01Z',
}

const trackEvent: EvaluationRunEvent = {
  id: '2',
  run_id: run.id,
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
  payload: { record_count: 1_024 },
}

describe('EvaluationRunTimeline', () => {
  it('shows the typed track evidence count without exposing worker-only terminal payloads', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationRunTimeline, {
        run,
        events: [trackEvent],
        connected: true,
        error: null,
        onReconnect: () => undefined,
      }),
    )

    expect(markup).toContain('1,024 evidence records')
    expect(markup).toContain('<strong>Routing</strong>')
  })

  it('presents sealing as an active server evidence phase', () => {
    const markup = renderToStaticMarkup(
      createElement(EvaluationRunTimeline, {
        run: { ...run, status: 'sealing' },
        events: [],
        connected: false,
        error: null,
        onReconnect: () => undefined,
      }),
    )

    expect(markup).toContain('Connecting')
    expect(markup).toContain('Finalizing server-sealed evidence')
  })
})
