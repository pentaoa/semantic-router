import { afterEach, describe, expect, it, vi } from 'vitest'

import { type EvaluationRequestError, getEvaluationReport } from './evaluationPlaneApi'

afterEach(() => vi.unstubAllGlobals())

describe('Evaluation Plane request errors', () => {
  it('retains the HTTP status needed for bounded recovery decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'report missing' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(getEvaluationReport('missing')).rejects.toMatchObject({
      name: 'EvaluationRequestError',
      message: 'report missing',
      status: 404,
    } satisfies Partial<EvaluationRequestError>)
  })
})
