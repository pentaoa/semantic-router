import type { EvaluationView } from '../components/evaluation-plane/EvaluationNavigation'

export type EvaluationRoute =
  | { view: 'overview' }
  | { view: 'new'; entrypoint: string | null }
  | { view: 'runs'; runID: string | null }
  | { view: 'reports'; reportRunID: string | null }
  | {
      view: 'compare'
      baselineRunID: string | null
      candidateRunID: string | null
      campaignID: string | null
    }

const VIEWS = new Set<EvaluationView>(['overview', 'new', 'runs', 'reports', 'compare'])

function value(params: URLSearchParams, key: string): string | null {
  return params.get(key)?.trim() || null
}

export function parseEvaluationRoute(params: URLSearchParams): EvaluationRoute {
  const requestedView = value(params, 'view')
  const view =
    requestedView && VIEWS.has(requestedView as EvaluationView)
      ? (requestedView as EvaluationView)
      : 'overview'

  switch (view) {
    case 'new':
      return { view, entrypoint: value(params, 'entrypoint') }
    case 'runs':
      return { view, runID: value(params, 'run') }
    case 'reports':
      return { view, reportRunID: value(params, 'report') }
    case 'compare':
      return {
        view,
        baselineRunID: value(params, 'baseline'),
        candidateRunID: value(params, 'candidate'),
        campaignID: value(params, 'campaign'),
      }
    default:
      return { view: 'overview' }
  }
}

export function serializeEvaluationRoute(route: EvaluationRoute): URLSearchParams {
  const params = new URLSearchParams()
  if (route.view === 'overview') return params
  params.set('view', route.view)
  if (route.view === 'new' && route.entrypoint) params.set('entrypoint', route.entrypoint)
  if (route.view === 'runs' && route.runID) params.set('run', route.runID)
  if (route.view === 'reports' && route.reportRunID) params.set('report', route.reportRunID)
  if (route.view === 'compare') {
    if (route.baselineRunID) params.set('baseline', route.baselineRunID)
    if (route.candidateRunID) params.set('candidate', route.candidateRunID)
    if (route.campaignID) params.set('campaign', route.campaignID)
  }
  return params
}

export function removeEvaluationRun(route: EvaluationRoute, runID: string): EvaluationRoute {
  switch (route.view) {
    case 'runs':
      return route.runID === runID ? { view: 'runs', runID: null } : route
    case 'reports':
      return route.reportRunID === runID ? { view: 'reports', reportRunID: null } : route
    case 'compare':
      return route.baselineRunID === runID || route.candidateRunID === runID
        ? {
            view: 'compare',
            baselineRunID: null,
            candidateRunID: null,
            campaignID: route.campaignID,
          }
        : route
    default:
      return route
  }
}
