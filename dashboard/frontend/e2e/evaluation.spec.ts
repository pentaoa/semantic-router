import { expect, type Page, test } from '@playwright/test'

import { mockAuthenticatedAppShell } from './support/auth'
import { defaultEvaluationRuns, evaluationCatalog, mockEvaluationPlane } from './support/evaluation'

const evalUser = {
  id: 'user-eval-1',
  email: 'eval@example.com',
  name: 'Eval User',
  role: 'read',
  permissions: [
    'config.read',
    'evaluation.read',
    'evaluation.run',
    'evaluation.write',
    'logs.read',
    'topology.read',
  ],
}

async function captureEvaluationSurface(page: Page, name: string) {
  const directory = process.env.EVALUATION_VISUAL_CAPTURE_DIR
  if (!directory) return
  await page.screenshot({ path: `${directory}/${name}.png` })
}

test.describe('Evaluation Plane', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedAppShell(page, {
      user: evalUser,
      settings: { readonlyMode: false, serverReadonly: false },
    })
  })

  test('shows an honest E0 catalog and the complete eight-track contract', async ({ page }) => {
    await mockEvaluationPlane(page)
    await page.goto('/evaluation')

    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible()
    for (const tab of ['Overview', 'New experiment', 'Runs', 'Reports', 'Compare']) {
      await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible()
    }

    const heroMetadata = page.locator('dl').filter({
      has: page.getByText('Current suites', { exact: true }),
    })
    await expect(heroMetadata.getByText('E0', { exact: true })).toBeVisible()
    await expect(
      page.getByText(
        'This is diagnostic evidence. Measured observations remain useful, but the promotion summary is withheld until native benchmark and execution receipts qualify the claim.',
        { exact: true },
      ),
    ).toBeVisible()

    const readiness = page.getByRole('table', {
      name: 'Evaluation track contract and latest evidence readiness',
    })
    await expect(readiness.getByRole('row')).toHaveCount(evaluationCatalog.tracks.length + 1)
    for (const track of evaluationCatalog.tracks) {
      await expect(
        readiness.getByRole('row').filter({
          has: page.getByText(track.name, { exact: true }),
        }),
      ).toBeVisible()
    }
    await expect(page.getByText('Schema evaluation.v1', { exact: true })).toBeVisible()
    await expect(page.getByText('evaluation-release-gates.v1', { exact: true })).toBeVisible()
    await captureEvaluationSurface(page, 'overview-desktop')
  })

  test('supports keyboard navigation across the evaluation tabs', async ({ page }) => {
    await mockEvaluationPlane(page)
    await page.goto('/evaluation')

    const overview = page.getByRole('tab', { name: 'Overview', exact: true })
    await overview.focus()
    await overview.press('End')
    await expect(page.getByRole('tab', { name: 'Compare', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('compare')

    const compare = page.getByRole('tab', { name: 'Compare', exact: true })
    await compare.focus()
    await compare.press('Home')
    await expect(overview).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBeNull()

    await overview.focus()
    await overview.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'New experiment', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('creates and starts an E0 run through separately authorized endpoints', async ({ page }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, { mutationDelayMs: 250 })
    await page.goto('/evaluation?view=new')

    await expect(page.getByText('Claim ceiling E0', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/cannot supply its own execution address/i)).toBeVisible()
    await page.getByLabel('Change profile').selectOption({ label: 'Routing recipe' })
    await page.getByLabel('Experiment name').fill('Recipe v4 candidate')
    await page.getByLabel('Description').fill('Validate the full evaluation surface.')
    await page.getByLabel('Sample limit').fill('64')
    await page.getByLabel('Concurrency').fill('8')
    await page.getByLabel('Seed').fill('7')
    await page.getByRole('heading', { name: 'New evaluation experiment' }).scrollIntoViewIfNeeded()
    await captureEvaluationSurface(page, 'new-experiment-desktop')
    await page.getByRole('button', { name: 'Create and start' }).click()

    const form = page.locator('form[aria-busy]')
    await expect(form).toHaveAttribute('aria-busy', 'true')
    await expect(
      page.locator('fieldset[aria-label="Evaluation experiment fields"]'),
    ).toHaveAttribute('disabled', '')
    await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled()

    await expect.poll(() => state.createdRequests.length).toBe(1)
    expect(state.createdRequests[0]).toMatchObject({
      name: 'Recipe v4 candidate',
      description: 'Validate the full evaluation surface.',
      suite_ids: ['evaluation-smoke'],
      track_ids: [...evaluationCatalog.suites[0].track_ids],
      mode: 'replay',
      target_id: 'fixture',
      change_profile: 'recipe',
      sample_limit: 64,
      concurrency: 8,
      seed: 7,
      auto_start: false,
    })
    expect(state.createdRequests[0].client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    await expect.poll(state.getStartCount).toBe(1)
    expect(state.getRuns()[0].evidence_level).toBe('E0')
    await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')

    const originalRequest = state.createdRequests[0]
    const originalRunID = state
      .getRuns()
      .find((run) => run.client_request_id === originalRequest.client_request_id)?.id
    const retry = await page.evaluate(async (request) => {
      const send = (body: typeof request) =>
        fetch('/api/evaluation/v1/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      const repeated = await send(request)
      const repeatedRun = (await repeated.json()) as { id: string; client_request_id?: string }
      const conflicting = await send({ ...request, name: `${request.name} changed` })
      return {
        repeatedStatus: repeated.status,
        repeatedRun,
        conflictingStatus: conflicting.status,
      }
    }, originalRequest)
    expect(retry.repeatedStatus).toBe(201)
    expect(retry.repeatedRun).toMatchObject({
      id: originalRunID,
      client_request_id: originalRequest.client_request_id,
    })
    expect(retry.conflictingStatus).toBe(409)
    expect(state.createAttempts).toHaveLength(3)
    expect(
      state.getRuns().filter((run) => run.client_request_id === originalRequest.client_request_id),
    ).toHaveLength(1)
  })

  test('copies and locks the exact cohort when creating a candidate from a baseline', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=new')

    await page.getByLabel('Baseline run').selectOption('baseline-run')
    await expect(
      page.getByText(
        'Exact cohort copied and locked: profile, mode, target, suites, tracks, sample limit, concurrency, and seed.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(page.getByLabel('Change profile')).toHaveValue('recipe')
    await expect(page.getByLabel('Change profile')).toBeDisabled()
    await expect(page.getByLabel('Catalog target')).toHaveValue('fixture')
    await expect(page.getByLabel('Catalog target')).toBeDisabled()
    await expect(page.getByRole('spinbutton', { name: 'Sample limit', exact: true })).toHaveValue(
      '4',
    )
    await expect(page.getByRole('spinbutton', { name: 'Sample limit', exact: true })).toBeDisabled()
    await expect(page.getByRole('spinbutton', { name: 'Concurrency', exact: true })).toHaveValue(
      '4',
    )
    await expect(page.getByRole('spinbutton', { name: 'Concurrency', exact: true })).toBeDisabled()
    await expect(page.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('42')
    await expect(page.getByRole('spinbutton', { name: 'Seed', exact: true })).toBeDisabled()

    await page.getByLabel('Experiment name').fill('Paired recipe candidate')
    await page.getByLabel('Description').fill('Exact-cohort candidate for paired comparison.')
    await page.getByRole('checkbox', { name: /Start immediately/ }).uncheck()
    await page.getByRole('button', { name: 'Create draft' }).click()

    await expect.poll(() => state.createdRequests.length).toBe(1)
    expect(state.createdRequests[0]).toMatchObject({
      baseline_run_id: 'baseline-run',
      mode: 'replay',
      target_id: 'fixture',
      change_profile: 'recipe',
      suite_ids: ['evaluation-smoke'],
      track_ids: [...evaluationCatalog.suites[0].track_ids],
      sample_limit: 4,
      concurrency: 4,
      seed: 42,
      auto_start: false,
    })
  })

  test('offers reports only for completed runs and returns 409 for terminal non-reports', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=reports')

    const selector = page.getByLabel('Run')
    await expect(selector).toBeVisible()
    await expect(selector.locator('option')).toHaveCount(4)
    const options = await selector.locator('option').allTextContents()
    expect(options).toEqual([
      'Select a completed run',
      'Candidate recipe · E0',
      'Production baseline · E0',
      'Unpaired diagnostic · E0',
    ])
    expect(options.join(' ')).not.toContain('Live AMD validation')
    expect(options.join(' ')).not.toContain('Failed diagnostic')
    expect(options.join(' ')).not.toContain('Cancelled diagnostic')

    const statuses = await page.evaluate(async () => {
      const [failed, cancelled] = await Promise.all([
        fetch('/api/evaluation/v1/runs/failed-run/report'),
        fetch('/api/evaluation/v1/runs/cancelled-run/report'),
      ])
      return [failed.status, cancelled.status]
    })
    expect(statuses).toEqual([409, 409])
    expect(state.reportRequests).toEqual(
      expect.arrayContaining(['candidate-run', 'failed-run', 'cancelled-run']),
    )
  })

  test('withholds E0 promotion claims while retaining diagnostics and never fakes G2+ pass', async ({
    page,
  }) => {
    await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=reports&report=candidate-run')

    await expect(
      page.getByText('Promotion summary withheld — diagnostic E0', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Promotion needs attention' })).toBeVisible()

    const metrics = page.getByRole('table', { name: 'Evaluation metrics' })
    await expect(
      metrics.getByRole('row').filter({ hasText: 'joint.realized_quality' }),
    ).toContainText('System quality')
    await expect(
      metrics.getByRole('row').filter({ hasText: 'capacity.latency_p95_ms' }),
    ).toContainText('P95 latency')

    const diagnostics = page.locator('section[aria-labelledby="report-diagnostics-title"]')
    await expect(diagnostics.getByRole('heading', { name: 'Execution diagnostics' })).toBeVisible()
    await expect(diagnostics.getByText('Total records').locator('..')).toContainText('32')
    await expect(
      diagnostics.getByText('Succeeded', { exact: true }).first().locator('..'),
    ).toContainText('32')
    await page.getByRole('heading', { name: 'Promotion needs attention' }).scrollIntoViewIfNeeded()
    await captureEvaluationSurface(page, 'report-decision-desktop')

    const allGates = page.locator('details').filter({
      has: page.getByText('All promotion gates', { exact: false }),
    })
    await allGates.locator('summary').click()
    await expect(allGates.getByText('Passed', { exact: true })).toHaveCount(2)
    for (let gateIndex = 2; gateIndex <= 9; gateIndex += 1) {
      const gate = allGates.locator('article').filter({
        has: page.getByText(`G${gateIndex}`, { exact: true }),
      })
      await expect(gate).toHaveCount(1)
      await expect(gate.getByText('Passed', { exact: true })).toHaveCount(0)
    }
    await captureEvaluationSurface(page, 'report-gates-desktop')
  })

  test('isolates an invalid capacity diagnostic artifact without collapsing the report', async ({
    page,
  }) => {
    await mockEvaluationPlane(page, defaultEvaluationRuns, {
      diagnosticArtifactBodies: {
        capacityProfile:
          '{"schema_version":"evaluation.v1","kind":"bounded-concurrency-sweep","levels":null,"slo":null}',
      },
    })
    await page.goto('/evaluation?view=reports&report=candidate-run')

    await expect(
      page.getByText('Promotion summary withheld — diagnostic E0', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('table', { name: 'Evaluation metrics' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Track observations' })).toBeVisible()

    const diagnostics = page.locator('section[aria-labelledby="report-diagnostics-title"]')
    await expect(
      diagnostics.getByRole('alert', { name: 'Capacity profile diagnostic error' }),
    ).toContainText('Invalid diagnostic artifact')
    await expect(
      diagnostics.getByRole('table', { name: 'Outcome accounting by evaluation track' }),
    ).toBeVisible()
    await expect(
      diagnostics.getByRole('table', { name: 'Capacity observations by concurrency' }),
    ).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Report unavailable' })).toHaveCount(0)
  })

  test('pins comparison lineage and colors deltas according to metric direction', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=compare')

    await expect.poll(() => new URL(page.url()).searchParams.get('candidate')).toBe('candidate-run')
    await expect.poll(() => new URL(page.url()).searchParams.get('baseline')).toBe('baseline-run')

    const candidates = page.getByLabel('Candidate')
    expect(await candidates.locator('option').allTextContents()).toEqual([
      'Select a candidate with baseline lineage',
      'Candidate recipe · recipe',
    ])
    const baseline = page.getByLabel('Pinned baseline')
    await expect(baseline).toHaveValue('Production baseline')
    await expect(baseline).toHaveJSProperty('readOnly', true)
    await captureEvaluationSurface(page, 'comparison-setup-desktop')

    await page.getByRole('button', { name: 'Compare paired evidence' }).click()
    await expect.poll(() => state.comparisonRequests.length).toBe(1)
    expect(state.comparisonRequests[0]).toEqual({
      baselineRunID: 'baseline-run',
      candidateRunID: 'candidate-run',
    })

    const table = page.getByRole('table', { name: 'Paired comparison metrics' })
    const quality = table.getByRole('row').filter({ hasText: 'joint.realized_quality' })
    await expect(quality).toContainText('Higher is better')
    await expect(quality.locator('strong[class*="delta_positive"]')).toHaveText('+3.0%')
    const latency = table.getByRole('row').filter({ hasText: 'capacity.latency_p95_ms' })
    await expect(latency).toContainText('Lower is better')
    await expect(latency.locator('strong[class*="delta_positive"]')).toHaveText('−28 ms')
    await expect(page.getByRole('heading', { name: 'Comparison gates' })).toBeVisible()
    await expect(page.getByText('Passed', { exact: true })).toHaveCount(0)
    await table.scrollIntoViewIfNeeded()
    await captureEvaluationSurface(page, 'comparison-results-desktop')
  })

  test('keeps quarantined run evidence visible and blocks partial-ledger decisions', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, {
      ledgerWarnings: [
        {
          code: 'corrupt_run_bundle',
          run_id: 'quarantined-run',
          evidence_file: 'status.json',
          message: 'Durable run status evidence is unreadable or invalid and has been quarantined.',
        },
      ],
    })
    await page.goto('/evaluation?view=compare&baseline=baseline-run&candidate=candidate-run')

    await expect(page.getByText('Run ledger incomplete', { exact: true })).toBeVisible()
    await expect(page.getByText('quarantined-run', { exact: true })).toBeVisible()
    await expect(page.getByText(/status\.json: Durable run status evidence/)).toBeVisible()
    await expect(page.getByLabel('Candidate')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Compare paired evidence' })).toBeDisabled()
    await expect(
      page.getByText(/Baseline selection and comparison conclusions are blocked/),
    ).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('baseline')).toBeNull()
    await expect.poll(() => new URL(page.url()).searchParams.get('candidate')).toBeNull()
    expect(state.comparisonRequests).toHaveLength(0)

    await page.getByRole('tab', { name: 'New experiment', exact: true }).click()
    await expect(page.getByText('Run ledger incomplete', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Baseline run')).toBeDisabled()
    await expect(
      page.getByText(
        'Baseline selection is blocked until quarantined durable run evidence is repaired.',
        { exact: true },
      ),
    ).toBeVisible()
  })

  test('keeps cancellation modal and controls pending until the server responds', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, { mutationDelayMs: 400 })
    await page.goto('/evaluation?view=runs&run=live-run')

    await page.getByRole('button', { name: 'Cancel Live AMD validation' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Execution stops and no completed report is published.')
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await captureEvaluationSurface(page, 'cancel-dialog')
    await dialog.getByRole('button', { name: 'Cancel run' }).click()
    await expect(dialog).toHaveAttribute('aria-busy', 'true')
    await expect(dialog.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Cancel Live AMD validation' })).toBeDisabled()

    await expect.poll(state.getCancelCount).toBe(1)
    await expect(dialog).toHaveCount(0)
    const inspector = page.locator('aside').filter({
      has: page.getByRole('heading', { name: 'Live AMD validation' }),
    })
    await expect(inspector.getByText('Cancelled', { exact: true })).toBeVisible()
  })

  test('requires typed delete confirmation and preserves pending dialog state', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, { mutationDelayMs: 400 })
    await page.goto('/evaluation?view=runs&run=failed-run')

    await page.getByRole('button', { name: 'Delete Failed diagnostic' }).click()
    const dialog = page.getByRole('alertdialog')
    const confirmation = dialog.getByRole('textbox', { name: /Type Failed diagnostic to confirm/ })
    const deleteButton = dialog.getByRole('button', { name: 'Delete run' })
    await expect(confirmation).toBeFocused()
    await captureEvaluationSurface(page, 'delete-dialog')
    await expect(deleteButton).toBeDisabled()
    await confirmation.fill('Failed')
    await expect(deleteButton).toBeDisabled()
    await confirmation.fill('Failed diagnostic')
    await expect(deleteButton).toBeEnabled()
    await deleteButton.click()
    await expect(dialog).toHaveAttribute('aria-busy', 'true')
    await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete Failed diagnostic' })).toBeDisabled()

    await expect.poll(state.getDeleteCount).toBe(1)
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Inspect Failed diagnostic' })).toHaveCount(0)
  })

  test('keeps one SSE subscription and one event across a run refresh', async ({ page }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=runs&run=live-run')

    await expect.poll(state.getEventStreamCount).toBe(1)
    await expect(page.getByText('Executing routing track from SSE')).toHaveCount(1)
    await captureEvaluationSurface(page, 'runs-desktop')
    await page.getByRole('button', { name: 'Refresh evaluation runs' }).click()
    await page.waitForTimeout(250)

    expect(state.getEventStreamCount()).toBe(1)
    await expect(page.getByText('Executing routing track from SSE')).toHaveCount(1)
  })

  test('keeps the primary evaluation workflow usable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockEvaluationPlane(page)
    await page.goto('/evaluation')

    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Evaluation plane views' })).toBeVisible()
    await page.getByRole('tab', { name: 'Runs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Evaluation runs' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Inspect Candidate recipe' })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1)
    await captureEvaluationSurface(page, 'runs-mobile')
  })
})
