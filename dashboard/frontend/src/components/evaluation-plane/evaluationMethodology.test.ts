import { describe, expect, it } from 'vitest'

import { EVALUATION_METHOD_FAMILIES, REGISTERED_BENCHMARK_COUNT } from './evaluationMethodology'

describe('evaluation methodology inventory', () => {
  it('keeps the nine method families and thirteen registered benchmarks explicit', () => {
    expect(EVALUATION_METHOD_FAMILIES).toHaveLength(9)
    expect(REGISTERED_BENCHMARK_COUNT).toBe(13)
  })

  it('never presents registry-only methods as retained evidence', () => {
    for (const id of ['fault-session', 'fusion-graph', 'model-budget']) {
      const family = EVALUATION_METHOD_FAMILIES.find((candidate) => candidate.id === id)
      expect(family?.currentImplementation).toMatch(/Registry-only/i)
      expect(family?.missingForQualification.length).toBeGreaterThan(20)
    }
  })

  it('keeps CodeRouterBench visible in the agentic method filter', () => {
    const denseOutcomes = EVALUATION_METHOD_FAMILIES.find(
      (candidate) => candidate.id === 'dense-outcome',
    )
    expect(denseOutcomes?.benchmarks).toContain('CodeRouterBench')
    expect(denseOutcomes?.trackIDs).toContain('agentic')
  })
})
