import { useMemo, useState } from 'react'

import type {
  EvaluationCatalog,
  EvaluationCatalogCampaignSlot,
  EvaluationCampaignGateID,
  EvaluationChangeProfileId,
  EvaluationRun,
} from '../../types/evaluationPlane'
import {
  campaignRunOptions,
  fidelityLiveOptions,
  fidelityReferenceOptions,
  type EvaluationCampaignDraft,
  newEvaluationCampaignClientRequestID,
  validateEvaluationCampaignDraft,
} from './evaluationCampaignSupport'

const EMPTY_CAMPAIGN_SLOTS: EvaluationCatalogCampaignSlot[] = []

function initialDraft(catalog: EvaluationCatalog): EvaluationCampaignDraft {
  return {
    clientRequestID: newEvaluationCampaignClientRequestID(),
    name: '',
    description: '',
    changeProfile:
      catalog.change_profiles.find((profile) => profile.id === 'recipe')?.id ||
      catalog.change_profiles[0]?.id ||
      'schema_adapter',
    gateBindings: {},
  }
}

interface UseEvaluationCampaignBuilderProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  allRunsLoaded: boolean
  onClearCreateError: () => void
}

export default function useEvaluationCampaignBuilder({
  catalog,
  runs,
  runLedgerAvailable,
  runLedgerComplete,
  allRunsLoaded,
  onClearCreateError,
}: UseEvaluationCampaignBuilderProps) {
  const [draft, setDraft] = useState<EvaluationCampaignDraft>(() => initialDraft(catalog))
  const profile =
    catalog.change_profiles.find((candidate) => candidate.id === draft.changeProfile) ||
    catalog.change_profiles[0]
  const slots = profile?.campaign_slots || EMPTY_CAMPAIGN_SLOTS
  const validation = validateEvaluationCampaignDraft(
    catalog,
    runs,
    draft,
    runLedgerAvailable,
    runLedgerComplete,
    allRunsLoaded,
  )
  const options = useMemo(
    () =>
      new Map(
        slots
          .filter((slot) => slot.binding_kind === 'run')
          .map((slot) => [slot.gate_id, campaignRunOptions(runs, catalog, profile, slot)]),
      ),
    [catalog, profile, runs, slots],
  )
  const fidelitySlot = slots.find((slot) => slot.binding_kind === 'fidelity_pair')
  const fidelityReferences = useMemo(
    () =>
      fidelitySlot && profile ? fidelityReferenceOptions(runs, catalog, profile, fidelitySlot) : [],
    [catalog, fidelitySlot, profile, runs],
  )
  const fidelityLiveRuns = useMemo(
    () =>
      fidelitySlot && profile
        ? fidelityLiveOptions(
            runs,
            catalog,
            profile,
            fidelitySlot,
            draft.gateBindings.g5_fidelity?.reference_run_id || '',
          )
        : [],
    [catalog, draft.gateBindings.g5_fidelity?.reference_run_id, fidelitySlot, profile, runs],
  )

  const revise = (change: (current: EvaluationCampaignDraft) => EvaluationCampaignDraft) => {
    onClearCreateError()
    setDraft((current) => ({
      ...change(current),
      clientRequestID: newEvaluationCampaignClientRequestID(),
    }))
  }

  const changeProfile = (changeProfile: EvaluationChangeProfileId) => {
    revise((current) => ({ ...current, changeProfile, gateBindings: {} }))
  }

  const changeRunBinding = (gateID: EvaluationCampaignGateID, value: string) => {
    const key = `${gateID.toLowerCase()}_run_id` as
      | 'g2_run_id'
      | 'g4_run_id'
      | 'g6_run_id'
      | 'g7_run_id'
      | 'g8_run_id'
      | 'g9_run_id'
    revise((current) => ({
      ...current,
      gateBindings: {
        ...current.gateBindings,
        [key]: value || undefined,
      },
    }))
  }

  const changeFidelityReference = (value: string) => {
    revise((current) => ({
      ...current,
      gateBindings: {
        ...current.gateBindings,
        g5_fidelity: value ? { reference_run_id: value, live_run_id: '' } : undefined,
      },
    }))
  }

  const changeFidelityLive = (value: string) => {
    revise((current) => {
      const referenceRunID = current.gateBindings.g5_fidelity?.reference_run_id
      return {
        ...current,
        gateBindings: {
          ...current.gateBindings,
          g5_fidelity:
            referenceRunID && value
              ? { reference_run_id: referenceRunID, live_run_id: value }
              : referenceRunID
                ? { reference_run_id: referenceRunID, live_run_id: '' }
                : undefined,
        },
      }
    })
  }

  const applyControlledPair = (baselineRunID: string, candidateRunID: string) => {
    revise((current) => ({
      ...current,
      gateBindings: {
        ...current.gateBindings,
        g3_controlled_pair: {
          baseline_run_id: baselineRunID,
          candidate_run_id: candidateRunID,
        },
      },
    }))
  }

  return {
    draft,
    profile,
    slots,
    requiredSlotCount: slots.filter((slot) => slot.disposition === 'required').length,
    advisorySlotCount: slots.filter((slot) => slot.disposition === 'advisory').length,
    validation,
    options,
    fidelityReferences,
    fidelityLiveRuns,
    revise,
    changeProfile,
    changeRunBinding,
    changeFidelityReference,
    changeFidelityLive,
    applyControlledPair,
    reset: () => setDraft(initialDraft(catalog)),
  }
}

export type EvaluationCampaignBuilderModel = ReturnType<typeof useEvaluationCampaignBuilder>
