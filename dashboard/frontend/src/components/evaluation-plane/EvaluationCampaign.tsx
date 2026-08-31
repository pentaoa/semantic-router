import type { EvaluationCatalog, EvaluationRun } from '../../types/evaluationPlane'
import type {
  CreateEvaluationCampaignPayload,
  EvaluationCampaign as EvaluationCampaignResource,
} from '../../types/evaluationCampaign'
import { EVALUATION_CAMPAIGN_CONTRACT_VERSION } from '../../types/evaluationPlane'
import EvaluationCampaignBuilder from './EvaluationCampaignBuilder'
import EvaluationCampaignDecision from './EvaluationCampaignDecision'
import { EvaluationActionButton } from './EvaluationPrimitives'
import useEvaluationCampaignBuilder from './useEvaluationCampaignBuilder'
import styles from './EvaluationCampaign.module.css'

interface EvaluationCampaignProps {
  catalog: EvaluationCatalog
  runs: EvaluationRun[]
  totalRuns: number
  runLedgerAvailable: boolean
  runLedgerComplete: boolean
  allRunsLoaded: boolean
  loadingAllRuns: boolean
  canCreate: boolean
  createPending: boolean
  createError: string | null
  campaign: EvaluationCampaignResource | null
  campaignLoading: boolean
  campaignError: string | null
  onLoadAllRuns: () => void
  onRefreshRuns: () => boolean | Promise<boolean>
  onCreate: (request: CreateEvaluationCampaignPayload) => Promise<EvaluationCampaignResource | null>
  onClearCreateError: () => void
  onRetryCampaign: () => void
  onClearCampaign: () => void
}

export default function EvaluationCampaign({
  catalog,
  runs,
  totalRuns,
  runLedgerAvailable,
  runLedgerComplete,
  allRunsLoaded,
  loadingAllRuns,
  canCreate,
  createPending,
  createError,
  campaign,
  campaignLoading,
  campaignError,
  onLoadAllRuns,
  onRefreshRuns,
  onCreate,
  onClearCreateError,
  onRetryCampaign,
  onClearCampaign,
}: EvaluationCampaignProps) {
  const builder = useEvaluationCampaignBuilder({
    catalog,
    runs,
    runLedgerAvailable,
    runLedgerComplete,
    allRunsLoaded,
    onClearCreateError,
  })

  const startAnother = () => {
    builder.reset()
    onClearCreateError()
    onClearCampaign()
  }

  return (
    <div className={styles.campaign} aria-busy={createPending || campaignLoading}>
      <header className={styles.layerHeader}>
        <div>
          <span className={styles.layerIndex}>Decision layer</span>
          <h2>Promotion campaign</h2>
          <p>
            Bind completed evidence to the server catalog&apos;s gate slots, then publish one
            immutable, server-attested release decision. A run comparison below remains diagnostic
            and cannot substitute for this campaign.
          </p>
        </div>
        <span className={styles.contractBadge}>{EVALUATION_CAMPAIGN_CONTRACT_VERSION}</span>
      </header>

      {campaignLoading ? (
        <div className={styles.inlineNotice} role="status">
          <div>
            <strong>Loading promotion decision</strong>
            <span>The server is revalidating every immutable evidence anchor.</span>
          </div>
        </div>
      ) : null}
      {campaignError ? (
        <div className={styles.inlineError} role="alert">
          <span>{campaignError}</span>
          <EvaluationActionButton
            type="button"
            compact
            disabled={campaignLoading}
            onClick={onRetryCampaign}
          >
            {campaignLoading ? 'Retrying decision…' : 'Retry decision'}
          </EvaluationActionButton>
        </div>
      ) : null}
      {campaign ? (
        <EvaluationCampaignDecision campaign={campaign} runs={runs} onStartAnother={startAnother} />
      ) : null}
      {!campaign && !campaignLoading && !campaignError ? (
        <EvaluationCampaignBuilder
          catalog={catalog}
          runs={runs}
          totalRuns={totalRuns}
          runLedgerAvailable={runLedgerAvailable}
          runLedgerComplete={runLedgerComplete}
          allRunsLoaded={allRunsLoaded}
          loadingAllRuns={loadingAllRuns}
          canCreate={canCreate}
          createPending={createPending}
          createError={createError}
          model={builder}
          onLoadAllRuns={onLoadAllRuns}
          onRefreshRuns={onRefreshRuns}
          onCreate={onCreate}
          onClearCreateError={onClearCreateError}
        />
      ) : null}
    </div>
  )
}
