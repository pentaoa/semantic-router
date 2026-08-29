# TD050: Benchmark Adapter Execution Attestation Gap

## Status

Open

## Owner Plan

[PL-0039: Evaluation Plane](../plans/pl-0039-evaluation-plane.md)

## Release Relevance

The exact-pin registry, source verifier, normalized suite contract, private
store, and data-only replay executor can ship. Imported suites remain E0 and
cannot substantiate an upstream or promotion claim until this gap is closed.

## Scope

- native-to-normalized adapters for the registered benchmark repositories
- adapter binary and configuration provenance
- native metric/grader parity
- redistribution and hidden-label handling

## Summary

The Evaluation Plane verifies all registered source and dataset revisions and
validates an operator-supplied normalized bundle. It does not yet execute a
repository-owned normalizer or cryptographically bind every normalized row to
the verified checkout. A caller could supply a schema-valid bundle unrelated to
that checkout, so source verification alone is not adapter attestation.

## Evidence

- `suite-install` reruns the system source verifier and ignores a caller-supplied
  receipt.
- The suite store validates content hashes, strict schemas, case joins,
  permissions, and immutable IDs.
- No adapter executable digest, transformation receipt, native grader parity
  result, or source-to-row derivation is currently required.

## Why It Matters

Without transformation attestation, an imported suite can prove contract
plumbing but not that RouterArena, ORBIT, CodeRouterBench, or another registered
benchmark was faithfully reproduced. Raising its evidence level would turn a
clean Git pin into a false scientific claim.

## Desired End State

Each benchmark has a maintained, sandboxed adapter that reads only its exact
pinned checkout, emits the normalized IR and a transformation receipt, and
passes parity tests against the benchmark's native splits, graders, and metric
reducers. Licensing and hidden labels remain separate from public artifacts.

The implementation has three explicit layers. They must not be collapsed into
one generic reducer:

1. **Native extraction adapter.** Reads an exact source/data pin in a
   no-network sandbox and emits native action, outcome, grouping, grader,
   price, media, fault, and exposure objects plus a transformation receipt.
2. **Common Evaluation IR and executor.** Carries the evidence shared across
   benchmarks: cases, dense arm outcomes, preferences, trajectories,
   perturbations, faults, compound actions, cost ledgers, and immutable
   lineage. This layer supplies cross-benchmark routing/pool/joint diagnostics.
3. **Native reducer and qualifier.** Reproduces the upstream split, action
   semantics, grader, missing-data policy, and metric reducer on golden subsets.
   It emits typed parity and qualification receipts. Only this layer can raise
   the affected claim above E0.

### Current loss map

The registry describes all thirteen benchmark methods, and the normalized
bundle can preserve many of their inputs. The current generic replay path does
not yet execute the following native semantics:

| Benchmark | Common IR available now | Native semantics still missing |
|-----------|-------------------------|--------------------------------|
| RouterArena | query decisions, arm outcomes, costs, perturbation pairs | official blind prediction export, task graders and price snapshot, arena/optimality/robustness reducers, latency accounting parity |
| RouteJudge / ORBIT | response pairs, votes, budgets, optional exposure fields | anonymous assignment/tie/missing-vote policy, exposure and propensity enforcement, effective sample size, Elo/head-to-head and cost-preference frontier parity |
| CodeRouterBench | ordered cases, dense arm outcomes, optional history state | prequential verified-history updates, no-future-leakage proof, cumulative regret, coding sandbox and agentic OOD parity |
| LLMRouterBench | dense query-by-arm outcomes and prices | official splits, graders and freshness snapshot, budget gain, oracle gap, cost save and Pareto-distance reducer parity |
| RouterEval | pool members, dense outcomes and seed fields | pool-size factorial identity, sampled-pool metadata, relative references, predictive entropy/collapse reducer, deployability separation |
| RouterBench | dense outcomes, model costs and policy labels | cascade and over-generation action execution, budget sweep, no-information convex hull and AIQ parity |
| xRouteBench | scenario/session/media fields, dense outcomes and preferences | session/personalization grouping semantics, media/license lineage, modality graders, and the complete caption/retrieval/judge hidden-call ledger |
| TwinRouterBench | trajectory identifiers, prefixes, step actions and terminal fields | prefix-conditioned downgrade/escalation labels, stateful step execution, live SWE sandbox outcome, multi-seed terminal and billing parity |
| MMR-Bench | typed media references, arm outcomes and costs | enforced modality/capability masks, media lineage/privacy slices, normalized AUC/peak/budget sweep and deployable-cost parity |
| AceBench | agent steps, outcomes, safety and cost fields | isolated workspace/tool execution, egress and side-effect attestation, privacy hard gates, pass-cubed and edge/cloud utility parity |
| continuity-bench | sessions, fault-event fields, recovery outcomes and latency | exact-step real fault injection, retry/stream/state-transfer attestation, conversation-clustered CPR/Wilson reduction and repeated seeds |
| FusionFactory / LLMFusionBench | compound action and per-call ledger fields | subset/topology/synthesis graph execution, complete hidden-call accounting, judge calibration, leakage audit and composite reducer parity |
| R2-Router / R2-Bench | model, budget and quality-curve fields | enforced model-plus-output-budget actions, stop/length accounting, common integration range, area-under-deployment-curve, peak and scalarized reducer parity |

This distinction is visible in the Dashboard methodology view. A configured
registry target is not native-method health, and a populated E0 diagnostic is
not upstream leaderboard parity.

## Exit Criteria

- Implement one versioned adapter package for every registered benchmark and
  dataset pin.
- Run adapters in a no-network, read-only-source sandbox with fixed dependencies,
  seed, and resource limits.
- Bind source, dataset, adapter image/binary, configuration, output objects, and
  row counts in one signed or independently anchored receipt.
- Compare normalized metrics with native benchmark outputs on maintained golden
  subsets and define accepted tolerances for every native reducer above. Golden
  fixtures must include ties, missing outcomes, unavailable arms, repeated
  sessions, compound actions, and zero-event safety slices where applicable.
- Preserve native grouping and action identity through aggregation; a generic
  query-by-model row must not flatten sequence order, pool factorial, budget,
  exposure, fault step, trajectory prefix, or fusion topology.
- Publish a per-run qualification matrix binding each claimed metric and gate to
  adapter, native reducer, grader, dataset, price, media/license, sandbox, and
  execution receipts. Partial qualification raises only the claims it proves.
- Add Dashboard/operator suite discovery only for fully installed, attested
  suites; never execute upstream source from a browser request.
- Raise evidence above E0 only for the claims whose required native artifacts
  and parity checks passed.
