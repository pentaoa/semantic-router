import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EvaluationCatalog } from '../../types/evaluationPlane'
import EvaluationMethodReadiness from './EvaluationMethodReadiness'

describe('EvaluationMethodReadiness', () => {
  it('labels the declared G4 capability without claiming static qualification', () => {
    const catalog = {
      suites: [
        {
          id: 'declared-shift',
          name: 'Declared shift',
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
    } as EvaluationCatalog

    const markup = renderToStaticMarkup(createElement(EvaluationMethodReadiness, { catalog }))

    expect(markup).toContain('Server-brokered live · G4')
    expect(markup).toContain('G4')
    expect(markup).toContain('Qualification happens only on a sealed run receipt')
    expect(markup).not.toContain('<strong>0</strong> qualified')
  })
})
