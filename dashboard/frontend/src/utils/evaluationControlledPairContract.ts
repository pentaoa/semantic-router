import type {
  CreateEvaluationControlledPairPayload,
  EvaluationControlledPairExecution,
} from '../types/evaluationControlledPair'
import {
  EVALUATION_CONTROLLED_PAIR_CONTRACT_VERSION,
  EVALUATION_CONTROLLED_PAIR_PROTOCOL,
} from '../types/evaluationControlledPair'
import { newEvaluationClientRequestID } from './evaluationIdentity'
import {
  assertCurrentEvaluationContract,
  hasOnlyEvaluationFields,
} from './evaluationContractValidation'
import {
  decodeEvaluationRun,
  isCanonicalEvaluationRunID,
  requireCanonicalEvaluationRunID,
} from './evaluationRunContract'

const CONTROLLED_PAIR_FIELDS = [
  'schema_version',
  'contract_version',
  'id',
  'protocol',
  'baseline_source_run_id',
  'candidate_source_run_id',
  'baseline_run',
  'candidate_run',
] as const

export function buildCreateEvaluationControlledPairPayload(
  baselineSourceRunID: string,
  candidateSourceRunID: string,
): CreateEvaluationControlledPairPayload {
  requireCanonicalEvaluationRunID(baselineSourceRunID)
  requireCanonicalEvaluationRunID(candidateSourceRunID)
  const payload = {
    client_request_id: newEvaluationClientRequestID(),
    baseline_source_run_id: baselineSourceRunID,
    candidate_source_run_id: candidateSourceRunID,
    baseline_run_id: newEvaluationClientRequestID(),
    candidate_run_id: newEvaluationClientRequestID(),
  }
  if (new Set(Object.values(payload)).size !== 5) {
    throw new Error('Controlled pair identities must be distinct canonical UUIDs.')
  }
  return payload
}

export function decodeEvaluationControlledPairExecution(
  payload: unknown,
  request: CreateEvaluationControlledPairPayload,
): EvaluationControlledPairExecution {
  assertCurrentEvaluationContract(payload, 'Controlled pair response')
  if (
    !hasOnlyEvaluationFields(payload, CONTROLLED_PAIR_FIELDS) ||
    payload.contract_version !== EVALUATION_CONTROLLED_PAIR_CONTRACT_VERSION ||
    payload.protocol !== EVALUATION_CONTROLLED_PAIR_PROTOCOL ||
    !isCanonicalEvaluationRunID(payload.id) ||
    !isCanonicalEvaluationRunID(payload.baseline_source_run_id) ||
    !isCanonicalEvaluationRunID(payload.candidate_source_run_id)
  ) {
    throw new Error('Controlled pair response is incomplete.')
  }

  const baselineRun = decodeEvaluationRun(payload.baseline_run, request.baseline_run_id)
  const candidateRun = decodeEvaluationRun(payload.candidate_run, request.candidate_run_id)
  if (
    payload.id !== request.client_request_id ||
    payload.baseline_source_run_id !== request.baseline_source_run_id ||
    payload.candidate_source_run_id !== request.candidate_source_run_id ||
    baselineRun.mode !== 'live' ||
    candidateRun.mode !== 'live' ||
    baselineRun.baseline_run_id !== undefined ||
    candidateRun.baseline_run_id !== baselineRun.id
  ) {
    throw new Error('Controlled pair response does not match the requested AB/BA execution.')
  }
  return {
    ...(payload as unknown as EvaluationControlledPairExecution),
    baseline_run: baselineRun,
    candidate_run: candidateRun,
  }
}
