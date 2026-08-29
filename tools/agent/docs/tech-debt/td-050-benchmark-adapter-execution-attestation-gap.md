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

### Current worker and promotion trust boundary

The Dashboard starts a worker only when the immutable manifest code revision
matches the running Evaluation Plane revision. At seal time the Go control
plane strictly validates schemas, artifact receipts, lineage, record identity,
case joins, G0/G1 record coverage, and the four generic metrics that can inform
G2/G3/G7 (`safety.violation_rate`, `safety.block_accuracy`,
`joint.normalized_regret`, and `capacity.success_rate`). This establishes a
same-revision execution, integrity, and generic-reduction boundary; it does not
independently attest the observations or reproduce a native benchmark's
scientific result.

That server-owned reduction contract is present only when both the public
report and its private server anchor carry the exact revision
`evaluation-server-attestation.v2`. That revision attests the four reducers
above, summary and per-track coverage, the three cost ledgers, E0 track
presentation, and record-backed capacity profile fields. A report and anchor
with no revision are a readable legacy integrity snapshot only; they do not
attest those derived values. Unknown or mismatched revisions are invalid, and
API clients must fail closed when a promotion, comparison, or trust label would
otherwise depend on a missing or unrecognized revision.

The same records scan also owns the three cost ledgers, per-track and summary
coverage, and the E0 track presentation. Float aggregates use an explicit
record-order binary64 sum in both Python and Go; binomial intervals use the same
Wilson reducer. For sealed Dashboard runs, per-track coverage uses the
server-validated visible case plan (with only non-text cases applicable to the
multimodal track), so a worker cannot turn omitted rows into 100% coverage.
The standalone normalizer derives heterogeneous external-suite denominators
from each track's emitted succeeded, failed, and unavailable plan cells to avoid
a suite-by-track Cartesian product. Generalizing the Dashboard's strong plan to
heterogeneous adapters requires a server-owned suite applicability matrix or a
typed adapter receipt; until then, external adapter applicability remains an
E0 boundary.

Other generic metrics, their confidence intervals, and all G2-G9 qualification
claims remain worker-derived. The Go control plane checks their type, bounds,
internal consistency, and provenance, but does not yet reproduce every metric,
validate the source of each observation, or run a native benchmark reducer.
Consequently they remain E0 diagnostics:

- an E0 report cannot produce a promotion verdict or promotion headline;
- G2-G9 cannot pass or fail without a typed server-owned qualification
  attestation; applicable unqualified gates remain unavailable;
- a server-reduced negative metric remains visible for diagnosis, but does not
  become a gate failure because its underlying observation is not independently
  attested; and
- self-consistent hashes and receipts prove artifact integrity, not benchmark
  parity or metric correctness.

Closing this boundary requires a typed server reducer or independently
qualified native reducer receipt for each promoted metric and gate. Until then,
the public product contract must label these observations diagnostic and avoid
upstream-parity or promotion claims.

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
