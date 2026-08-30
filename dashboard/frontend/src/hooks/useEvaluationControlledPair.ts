import { useCallback, useEffect, useRef, useState } from 'react'

import type { EvaluationControlledPairExecution } from '../types/evaluationControlledPair'
import { createEvaluationControlledPair, getEvaluationRun } from '../utils/evaluationPlaneApi'
import { buildCreateEvaluationControlledPairPayload } from '../utils/evaluationControlledPairContract'

type ControlledPairStatus = 'idle' | 'creating' | 'running' | 'assigning' | 'ready' | 'error'

interface ControlledPairState {
  status: ControlledPairStatus
  execution: EvaluationControlledPairExecution | null
  error: string | null
  sourceIDs: { baseline: string; candidate: string } | null
}

const INITIAL_STATE: ControlledPairState = {
  status: 'idle',
  execution: null,
  error: null,
  sourceIDs: null,
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export async function handoffEvaluationControlledPair(
  execution: EvaluationControlledPairExecution,
  onReady: (execution: EvaluationControlledPairExecution) => void | Promise<void>,
): Promise<string | null> {
  try {
    await onReady(execution)
    return null
  } catch (error) {
    return message(
      error,
      'Controlled pair completed, but its fresh runs could not be assigned to the campaign.',
    )
  }
}

function terminalFailure(execution: EvaluationControlledPairExecution): string | null {
  for (const [label, run] of [
    ['Baseline', execution.baseline_run],
    ['Candidate', execution.candidate_run],
  ] as const) {
    if (run.status === 'failed')
      return `${label} controlled run failed: ${run.error || 'no server rationale was returned.'}`
    if (run.status === 'cancelled') return `${label} controlled run was cancelled.`
  }
  return null
}

function isReady(execution: EvaluationControlledPairExecution): boolean {
  return (
    execution.baseline_run.status === 'completed' && execution.candidate_run.status === 'completed'
  )
}

export function useEvaluationControlledPair(
  onReady: (execution: EvaluationControlledPairExecution) => void | Promise<void>,
) {
  const [state, setState] = useState<ControlledPairState>(INITIAL_STATE)
  const requestVersion = useRef(0)
  const onReadyRef = useRef(onReady)
  const executionRef = useRef<EvaluationControlledPairExecution | null>(null)
  const deliveredExecutionID = useRef<string | null>(null)
  onReadyRef.current = onReady
  executionRef.current = state.execution

  const deliverReady = useCallback(async (execution: EvaluationControlledPairExecution) => {
    if (deliveredExecutionID.current === execution.id) return
    setState((current) => ({ ...current, status: 'assigning', execution, error: null }))
    const handoffError = await handoffEvaluationControlledPair(execution, onReadyRef.current)
    if (handoffError) {
      setState((current) => ({
        ...current,
        status: 'error',
        execution,
        error: handoffError,
      }))
      return
    }
    deliveredExecutionID.current = execution.id
    setState((current) => ({ ...current, status: 'ready', execution, error: null }))
  }, [])

  const create = useCallback(
    async (baselineSourceRunID: string, candidateSourceRunID: string) => {
      const version = ++requestVersion.current
      deliveredExecutionID.current = null
      setState({
        status: 'creating',
        execution: null,
        error: null,
        sourceIDs: { baseline: baselineSourceRunID, candidate: candidateSourceRunID },
      })
      try {
        const request = buildCreateEvaluationControlledPairPayload(
          baselineSourceRunID,
          candidateSourceRunID,
        )
        const execution = await createEvaluationControlledPair(request)
        if (version !== requestVersion.current) return null
        const failure = terminalFailure(execution)
        if (failure) {
          setState({
            status: 'error',
            execution,
            error: failure,
            sourceIDs: { baseline: baselineSourceRunID, candidate: candidateSourceRunID },
          })
          return null
        }
        if (isReady(execution)) {
          setState({
            status: 'assigning',
            execution,
            error: null,
            sourceIDs: { baseline: baselineSourceRunID, candidate: candidateSourceRunID },
          })
          await deliverReady(execution)
        } else {
          setState({
            status: 'running',
            execution,
            error: null,
            sourceIDs: { baseline: baselineSourceRunID, candidate: candidateSourceRunID },
          })
        }
        return execution
      } catch (error) {
        if (version !== requestVersion.current) return null
        setState({
          status: 'error',
          execution: null,
          error: message(error, 'Controlled AB/BA execution could not be created.'),
          sourceIDs: { baseline: baselineSourceRunID, candidate: candidateSourceRunID },
        })
        return null
      }
    },
    [deliverReady],
  )

  const baselineRunID = state.execution?.baseline_run.id
  const candidateRunID = state.execution?.candidate_run.id

  useEffect(() => {
    const currentExecution = executionRef.current
    if (state.status !== 'running' || !currentExecution) return
    const version = requestVersion.current
    const execution = currentExecution
    let stopped = false
    let timer: number | undefined
    let controller: AbortController | null = null

    const poll = async () => {
      controller?.abort()
      controller = new AbortController()
      try {
        const [baselineRun, candidateRun] = await Promise.all([
          getEvaluationRun(execution.baseline_run.id, controller.signal),
          getEvaluationRun(execution.candidate_run.id, controller.signal),
        ])
        if (stopped || version !== requestVersion.current) return
        const next = { ...execution, baseline_run: baselineRun, candidate_run: candidateRun }
        const failure = terminalFailure(next)
        if (failure) {
          setState((current) => ({ ...current, status: 'error', execution: next, error: failure }))
          return
        }
        if (isReady(next)) {
          await deliverReady(next)
          return
        }
        setState((current) => ({ ...current, execution: next, error: null }))
        timer = window.setTimeout(() => void poll(), 2_000)
      } catch (error) {
        if (stopped || controller.signal.aborted || version !== requestVersion.current) return
        setState((current) => ({
          ...current,
          status: 'error',
          error: message(error, 'Controlled pair progress is temporarily unreachable.'),
        }))
      }
    }

    timer = window.setTimeout(() => void poll(), 500)
    return () => {
      stopped = true
      controller?.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [baselineRunID, candidateRunID, deliverReady, state.status])

  const retry = useCallback(() => {
    if (!state.sourceIDs) return
    const terminal = state.execution ? terminalFailure(state.execution) : null
    if (state.execution && isReady(state.execution) && !terminal) {
      void deliverReady(state.execution)
      return
    }
    if (!state.execution || terminal) {
      void create(state.sourceIDs.baseline, state.sourceIDs.candidate)
      return
    }
    requestVersion.current += 1
    setState((current) => ({ ...current, status: 'running', error: null }))
  }, [create, deliverReady, state.execution, state.sourceIDs])

  const reset = useCallback(() => {
    requestVersion.current += 1
    deliveredExecutionID.current = null
    setState(INITIAL_STATE)
  }, [])

  return {
    ...state,
    create,
    retry,
    reset,
  }
}
