import { useEffect, useMemo } from 'react'

import EvaluationCampaign from '../components/evaluation-plane/EvaluationCampaign'
import EvaluationCompare from '../components/evaluation-plane/EvaluationCompare'
import { useEvaluationComparison } from '../hooks/useEvaluationComparison'
import { useCreateEvaluationCampaign, useEvaluationCampaign } from '../hooks/useEvaluationCampaign'
import { useEvaluationRun } from '../hooks/useEvaluationRun'
import type { EvaluationCatalog, EvaluationRun } from '../types/evaluationPlane'
import type { EvaluationRoute } from './evaluationRoute'
import styles from './EvaluationPage.module.css'

type CompareRoute = Extract<EvaluationRoute, { view: 'compare' }>

interface ComparisonPair {
  baselineID: string | null
  candidateID: string | null
}

interface EvaluationCompareWorkspaceProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  totalRuns: number
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  hasMoreRuns: boolean
  loadingMoreRuns: boolean
  loadingAllRuns: boolean
  canCreateCampaign: boolean
  route: CompareRoute
  defaultPair: ComparisonPair | null
  onRouteChange: (route: CompareRoute) => void
  onLoadMoreRuns: () => void
  onLoadAllRuns: () => void
  onRefreshRuns: () => boolean | Promise<boolean>
  onCreateRun: () => void
}

export default function EvaluationCompareWorkspace({
  catalog,
  runs,
  totalRuns,
  runLedgerAvailable,
  runLedgerComplete,
  hasMoreRuns,
  loadingMoreRuns,
  loadingAllRuns,
  canCreateCampaign,
  route,
  defaultPair,
  onRouteChange,
  onLoadMoreRuns,
  onLoadAllRuns,
  onRefreshRuns,
  onCreateRun,
}: EvaluationCompareWorkspaceProps) {
  const hasRequestedPair = Boolean(route.baselineRunID || route.candidateRunID)
  const pair = hasRequestedPair
    ? { baselineID: route.baselineRunID, candidateID: route.candidateRunID }
    : defaultPair
  const baselineRunID = pair?.baselineID || ''
  const candidateRunID = pair?.candidateID || ''
  const campaignState = useEvaluationCampaign(route.campaignID)
  const campaignCreateState = useCreateEvaluationCampaign()
  const campaign =
    campaignState.campaign ||
    (campaignCreateState.campaign?.id === route.campaignID ? campaignCreateState.campaign : null)
  const loadedBaseline = runs.find((run) => run.id === baselineRunID) || null
  const loadedCandidate = runs.find((run) => run.id === candidateRunID) || null
  const baselineState = useEvaluationRun(baselineRunID || null, loadedBaseline)
  const candidateState = useEvaluationRun(candidateRunID || null, loadedCandidate)
  const comparisonState = useEvaluationComparison(baselineRunID, candidateRunID, runLedgerComplete)
  const comparisonRuns = useMemo(() => {
    const byID = new Map(runs.map((run) => [run.id, run]))
    if (baselineState.run) byID.set(baselineState.run.id, baselineState.run)
    if (candidateState.run) byID.set(candidateState.run.id, candidateState.run)
    return [...byID.values()]
  }, [baselineState.run, candidateState.run, runs])

  useEffect(() => {
    if (route.campaignID && hasMoreRuns && !loadingAllRuns && !loadingMoreRuns) {
      onLoadAllRuns()
    }
  }, [hasMoreRuns, loadingAllRuns, loadingMoreRuns, onLoadAllRuns, route.campaignID])

  const updateRoute = (
    baselineID: string | null,
    candidateID: string | null,
    campaignID: string | null,
  ) => {
    onRouteChange({
      view: 'compare',
      baselineRunID: baselineID,
      candidateRunID: candidateID,
      campaignID,
    })
  }

  const campaignPanel = (
    <EvaluationCampaign
      catalog={catalog}
      runs={runs}
      totalRuns={totalRuns}
      runLedgerAvailable={runLedgerAvailable}
      runLedgerComplete={runLedgerComplete}
      allRunsLoaded={runLedgerAvailable && !hasMoreRuns && runs.length === totalRuns}
      loadingAllRuns={loadingAllRuns}
      canCreate={canCreateCampaign}
      createPending={campaignCreateState.pending}
      createError={campaignCreateState.error}
      campaign={campaign}
      campaignLoading={campaignState.loading && !campaign}
      campaignError={campaignState.error}
      onLoadAllRuns={() => (hasMoreRuns ? onLoadAllRuns() : onRefreshRuns())}
      onRefreshRuns={onRefreshRuns}
      onCreate={async (request) => {
        const created = await campaignCreateState.create(request)
        if (created) updateRoute(baselineRunID || null, candidateRunID || null, created.id)
        return created
      }}
      onClearCreateError={campaignCreateState.clearError}
      onRetryCampaign={() => void campaignState.refresh()}
      onClearCampaign={() => {
        campaignCreateState.reset()
        updateRoute(baselineRunID || null, candidateRunID || null, null)
      }}
    />
  )
  const comparisonPanel = (
    <EvaluationCompare
      runs={comparisonRuns}
      baselineID={baselineRunID}
      candidateID={candidateRunID}
      comparison={comparisonState.comparison}
      runLedgerAvailable={runLedgerAvailable}
      runLedgerComplete={runLedgerComplete}
      totalRuns={totalRuns}
      hasMoreRuns={hasMoreRuns}
      loadingMoreRuns={loadingMoreRuns}
      resourcesLoading={baselineState.loading || candidateState.loading}
      resourcesError={baselineState.error || candidateState.error}
      loading={comparisonState.loading}
      error={comparisonState.error}
      onPairChange={(candidate, baseline) => updateRoute(baseline, candidate, route.campaignID)}
      onCompare={() => void comparisonState.compare()}
      onLoadMoreRuns={onLoadMoreRuns}
      onRetryResources={() => {
        void baselineState.refresh()
        void candidateState.refresh()
      }}
      onCreateRun={onCreateRun}
    />
  )

  return (
    <div className={styles.compareWorkspace}>
      {route.campaignID ? campaignPanel : comparisonPanel}
      {route.campaignID ? comparisonPanel : campaignPanel}
    </div>
  )
}
