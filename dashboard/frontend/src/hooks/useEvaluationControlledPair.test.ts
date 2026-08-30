import { describe, expect, it, vi } from 'vitest'

import type { EvaluationControlledPairExecution } from '../types/evaluationControlledPair'
import { handoffEvaluationControlledPair } from './useEvaluationControlledPair'

describe('controlled pair readiness handoff', () => {
  it('awaits assignment and returns a retryable rationale when durable-ledger refresh fails', async () => {
    const execution = {
      id: '11111111-1111-4111-8111-111111111111',
    } as EvaluationControlledPairExecution
    const onReady = vi
      .fn<(value: EvaluationControlledPairExecution) => Promise<void>>()
      .mockRejectedValue(new Error('Durable run ledger refresh failed.'))

    await expect(handoffEvaluationControlledPair(execution, onReady)).resolves.toBe(
      'Durable run ledger refresh failed.',
    )
    expect(onReady).toHaveBeenCalledOnce()
    expect(onReady).toHaveBeenCalledWith(execution)
  })

  it('does not report ready until asynchronous assignment resolves', async () => {
    const execution = {
      id: '22222222-2222-4222-8222-222222222222',
    } as EvaluationControlledPairExecution
    let resolveAssignment: (() => void) | undefined
    const assignment = new Promise<void>((resolve) => {
      resolveAssignment = resolve
    })
    let settled = false
    const handoff = handoffEvaluationControlledPair(execution, () => assignment).then((error) => {
      settled = true
      return error
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    resolveAssignment?.()
    await expect(handoff).resolves.toBeNull()
  })
})
