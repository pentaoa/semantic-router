import ConfirmDialog from '../components/ConfirmDialog'
import type { EvaluationRun } from '../types/evaluationPlane'

interface EvaluationRunActionDialogsProps {
  cancelTarget: EvaluationRun | null
  deleteTarget: EvaluationRun | null
  mutationKey: string | null
  error: string | null
  onCloseCancel: () => void
  onCloseDelete: () => void
  onConfirmCancel: () => void | Promise<void>
  onConfirmDelete: () => void | Promise<void>
}

export default function EvaluationRunActionDialogs({
  cancelTarget,
  deleteTarget,
  mutationKey,
  error,
  onCloseCancel,
  onCloseDelete,
  onConfirmCancel,
  onConfirmDelete,
}: EvaluationRunActionDialogsProps) {
  return (
    <>
      <ConfirmDialog
        isOpen={cancelTarget !== null}
        title={`Cancel ${cancelTarget?.name || 'this run'}?`}
        description="Execution stops and no completed report is published. Durable lifecycle events and terminal status remain available; worker staging is not presented as partial scientific evidence."
        eyebrow="Evaluation execution"
        confirmLabel="Cancel run"
        pendingLabel="Cancelling…"
        tone="warning"
        pending={mutationKey === `cancel:${cancelTarget?.id || ''}`}
        error={error}
        details={cancelTarget ? <code>{cancelTarget.id}</code> : null}
        onCancel={onCloseCancel}
        onConfirm={onConfirmCancel}
      />
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name || 'this run'}?`}
        description="This permanently removes the run bundle and Dashboard history. Download required artifacts before continuing."
        eyebrow="Evaluation evidence"
        confirmLabel="Delete run"
        pendingLabel="Deleting…"
        pending={mutationKey === `delete:${deleteTarget?.id || ''}`}
        error={error}
        confirmationText={deleteTarget?.name}
        details={deleteTarget ? <code>{deleteTarget.id}</code> : null}
        onCancel={onCloseDelete}
        onConfirm={onConfirmDelete}
      />
    </>
  )
}
