import type { EvaluationRun, EvaluationRunEvent } from '../../types/evaluationPlane'
import { TRACK_PRESENTATION } from '../../types/evaluationPlane'
import { formatDateTime } from '../../utils/dateTime'
import styles from './EvaluationPlane.module.css'

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
  return (
    <>
      <div className={styles.eventHeader}>
        <h4>Execution timeline</h4>
        <span className={connected ? styles.live : styles.offline}>
          {connected
            ? 'Stream connected'
            : error
              ? 'Stream unavailable'
              : run.status === 'running'
                ? 'Connecting'
                : 'Durable history'}
        </span>
      </div>
      {error ? (
        <div className={styles.inlineError} role="alert">
          <div>
            <strong>Live stream unavailable</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={onReconnect}>
            Reconnect stream
          </button>
        </div>
      ) : null}
      {events.length === 0 ? (
        <p className={styles.emptyCopy}>
          {run.status === 'running'
            ? 'Waiting for the first event…'
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
                <span>{event.message}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
