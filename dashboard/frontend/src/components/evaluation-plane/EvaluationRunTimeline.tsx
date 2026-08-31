import type { EvaluationRun, EvaluationRunEvent } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import { EvaluationActionButton } from './EvaluationPrimitives'
import planeStyles from './EvaluationPlane.module.css'
import styles from './EvaluationRuns.module.css'

interface EvaluationRunTimelineProps {
  run: EvaluationRun
  events: EvaluationRunEvent[]
  connected: boolean
  error: string | null
  onReconnect: () => void
}

export default function EvaluationRunTimeline({
  run,
  events,
  connected,
  error,
  onReconnect,
}: EvaluationRunTimelineProps) {
  const active = run.status === 'running' || run.status === 'sealing'
  const eventMessage = (event: EvaluationRunEvent) => {
    if (event.type !== 'track') return event.message
    const recordLabel = event.payload.record_count === 1 ? 'evidence record' : 'evidence records'
    return `${event.message} · ${event.payload.record_count.toLocaleString()} ${recordLabel}`
  }

  return (
    <>
      <div className={styles.eventHeader}>
        <h4>Execution timeline</h4>
        <span className={connected ? styles.live : styles.offline}>
          {connected
            ? 'Stream connected'
            : error
              ? 'Stream unavailable'
              : active
                ? 'Connecting'
                : 'Durable history'}
        </span>
      </div>
      {error ? (
        <div className={planeStyles.inlineError} role="alert">
          <div>
            <strong>Live stream unavailable</strong>
            <span>{error}</span>
          </div>
          <EvaluationActionButton type="button" compact onClick={onReconnect}>
            Reconnect stream
          </EvaluationActionButton>
        </div>
      ) : null}
      {events.length === 0 ? (
        <p className={planeStyles.emptyCopy}>
          {active
            ? run.status === 'sealing'
              ? 'Finalizing server-sealed evidence…'
              : 'Waiting for the first event…'
            : 'No durable lifecycle events were returned for this run.'}
        </p>
      ) : (
        <ol className={styles.eventList}>
          {events.map((event, index) => (
            <li key={event.id || `${event.timestamp}-${index}`}>
              <time>{formatDateTime(event.timestamp)}</time>
              <div>
                <strong>
                  {event.track_id ? TRACK_PRESENTATION[event.track_id].label : event.type}
                </strong>
                <span>{eventMessage(event)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
