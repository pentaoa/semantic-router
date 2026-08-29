import type { EvaluationTrackId } from '../../types/evaluationPlane'

export interface EvaluationMethodFamily {
  id: string
  name: string
  benchmarks: string[]
  method: string
  currentImplementation: string
  missingForQualification: string
  trackIDs: EvaluationTrackId[]
}

export const EVALUATION_METHOD_FAMILIES: EvaluationMethodFamily[] = [
  {
    id: 'prediction-file',
    name: 'Blind routing predictions',
    benchmarks: ['RouterArena'],
    method:
      'Freeze query-to-model decisions before grading; sweep quality, price, and perturbations.',
    currentImplementation:
      'Diagnostic E0 decision/outcome rows and common routing aggregates. Perturbation pairs, arena score, price parity, and native robustness reducers are not executed.',
    missingForQualification:
      'Native prediction export, grader and price parity, optimality, robustness, and cost-frontier receipts.',
    trackIDs: ['routing', 'model_pool', 'joint'],
  },
  {
    id: 'pairwise-preference',
    name: 'Pairwise preference and online exposure',
    benchmarks: ['RouteJudge / ORBIT'],
    method: 'Compare anonymous response pairs under an explicit budget and assignment policy.',
    currentImplementation:
      'Offline pair rows can produce diagnostic rewards. Tie/skip, assignment, exposure, participation, and effective-sample-size semantics are not preserved end to end.',
    missingForQualification:
      'Native tie policy, head-to-head/Elo reducer, propensity and exposure ledger, ESS, and causal assignment attestation.',
    trackIDs: ['routing', 'joint', 'preference'],
  },
  {
    id: 'dense-outcome',
    name: 'Dense query × model outcomes',
    benchmarks: ['CodeRouterBench', 'LLMRouterBench', 'RouterEval', 'RouterBench', 'MMR-Bench'],
    method:
      'Hold a dense arm-outcome matrix fixed and evaluate pool composition plus router realization.',
    currentImplementation:
      'Normalized arm outcomes feed common E0 quality/oracle diagnostics. Stream order, split identity, budget and pool-size factors, grader revisions, and native Pareto reducers are not retained.',
    missingForQualification:
      'Native dense matrix and split parity, prequential ordering, grader/price receipts, pool factorials, budget curves, regret, and Pareto metrics.',
    trackIDs: ['routing', 'model_pool', 'joint', 'multimodal'],
  },
  {
    id: 'scenario-session',
    name: 'Scenario, session, and personalization',
    benchmarks: ['xRouteBench'],
    method:
      'Evaluate single turns and grouped sessions with modality and preference state kept intact.',
    currentImplementation:
      'Single-row modality and preference diagnostics are available at E0. Session order/state, personalization context, media lineage, and hidden-call accounting are not retained.',
    missingForQualification:
      'Session grouping, turn order, personalization state, modality-native graders, media/license receipts, and complete hidden-call cost.',
    trackIDs: ['routing', 'model_pool', 'joint', 'multimodal', 'preference'],
  },
  {
    id: 'trajectory-prefix',
    name: 'Agent trajectory decisions',
    benchmarks: ['TwinRouterBench'],
    method:
      'Route at a frozen trajectory prefix, then evaluate both the step decision and terminal task result.',
    currentImplementation:
      'Terminal success and aggregate tool counts can be replayed diagnostically. Prefix state, step routing, side-effect identity, execution seeds, and resolved-per-cost reducers are discarded.',
    missingForQualification:
      'Frozen prefix/step pairing, reproducible sandbox trajectories, state and side-effect receipts, multi-seed variance, and resolved-per-cost.',
    trackIDs: ['routing', 'joint', 'agentic'],
  },
  {
    id: 'executable-agent',
    name: 'Executable utility and privacy',
    benchmarks: ['AceBench'],
    method:
      'Run isolated agent tasks while recording workspace effects, egress, tools, utility, and cost.',
    currentImplementation:
      'Terminal labels plus aggregate tool/privacy counts are diagnostic only. No isolated executable sandbox, egress ledger, side-effect log, pass³, or full cloud-cost accounting is active.',
    missingForQualification:
      'Isolated execution, repeated trials, egress and side-effect attestation, full cloud costs, and privacy hard-gate receipts.',
    trackIDs: ['routing', 'joint', 'agentic', 'safety'],
  },
  {
    id: 'fault-session',
    name: 'Fault injection and continuity',
    benchmarks: ['continuity-bench'],
    method:
      'Inject a provider failure at an exact session step and measure recovery without losing state.',
    currentImplementation:
      'Registry-only contract. Fault rows and perturbations are not loaded by the current executor, so continuity and recovery claims are not measured.',
    missingForQualification:
      'Fault injection, session clustering, history/state transfer, retry amplification, recovery metrics, repeated seeds, and clustered intervals.',
    trackIDs: ['joint', 'agentic', 'capacity'],
  },
  {
    id: 'fusion-graph',
    name: 'Compound routing and synthesis',
    benchmarks: ['FusionFactory / LLMFusionBench'],
    method: 'Treat subset, topology, and synthesis as one compound action graph.',
    currentImplementation:
      'Registry-only compound-action metadata; the common reducer collapses topology and synthesis into an arm label and cannot execute native fusion graphs.',
    missingForQualification:
      'Topology graph normalization, synthesis execution, calibrated composite grading, all-call latency/cost, and native parity receipts.',
    trackIDs: ['model_pool', 'joint', 'agentic'],
  },
  {
    id: 'model-budget',
    name: 'Model × output-budget actions',
    benchmarks: ['R2-Router / R2-Bench'],
    method: 'Choose both a model and an enforced output budget over frozen quality curves.',
    currentImplementation:
      'Registry-only budget metadata; budget tokens are dropped and repeated model outcomes become ambiguous in the current common reducer.',
    missingForQualification:
      'Model×budget tensor, enforced budgets, common integration range, curve/AUC reducers, length-bias calibration, and parity receipts.',
    trackIDs: ['routing', 'model_pool', 'joint', 'capacity'],
  },
]

export const REGISTERED_BENCHMARK_COUNT = 13
