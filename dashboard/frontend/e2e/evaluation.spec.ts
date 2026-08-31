import { expect, type Locator, type Page, test } from '@playwright/test'

import { mockAuthenticatedAppShell } from './support/auth'
import {
  defaultEvaluationRuns,
  EVALUATION_BASELINE_MOM_TARGET_ID,
  EVALUATION_MOM,
  EVALUATION_MOM_TARGET_ID,
  EVALUATION_RUN_IDS,
  evaluationCatalog,
  evaluationRun,
  evaluationRunID,
  mockEvaluationPlane,
} from './support/evaluation'

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

async function captureEvaluationFullPage(page: Page, name: string) {
  const directory = process.env.EVALUATION_VISUAL_CAPTURE_DIR
  if (!directory) return
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true })
}

async function captureEvaluationElement(element: Locator, name: string) {
  const directory = process.env.EVALUATION_VISUAL_CAPTURE_DIR
  if (!directory) return
  await element.screenshot({ path: `${directory}/${name}.png` })
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1)
}

async function expectPageBottomReachable(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement
        if (!root) return false
        return (
          root.scrollHeight + 1 >= document.body.scrollHeight &&
          root.scrollHeight + 1 >= (document.getElementById('root')?.scrollHeight || 0)
        )
      }),
    )
    .toBe(true)
  await page.evaluate(() => {
    const root = document.scrollingElement
    if (!root) throw new Error('Document has no scrolling element.')
    root.scrollTop = root.scrollHeight
  })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement
        if (!root) return false
        return Math.ceil(root.scrollTop + root.clientHeight) >= root.scrollHeight - 1
      }),
    )
    .toBe(true)
}

async function expectEvaluationBottomGutter(page: Page) {
  const panel = page.getByRole('tabpanel')
  await expect(panel).toBeVisible()
  const geometry = await panel.evaluate((element) => {
    const panelRect = element.getBoundingClientRect()
    const lastChild = element.lastElementChild
    const lastRect = lastChild?.getBoundingClientRect()
    return {
      paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
      contentGap: lastRect ? panelRect.bottom - lastRect.bottom : 0,
    }
  })
  expect(geometry.paddingBottom).toBeGreaterThanOrEqual(31)
  expect(geometry.contentGap).toBeGreaterThanOrEqual(geometry.paddingBottom - 1)
}

async function expectDialogBottomReachable(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible()
  await expect
    .poll(async () => {
      const [box, viewportHeight] = await Promise.all([
        dialog.boundingBox(),
        page.evaluate(() => window.innerHeight),
      ])
      return Boolean(box && box.y >= -1 && box.y + box.height <= viewportHeight + 1)
    })
    .toBe(true)
  await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() =>
      dialog.evaluate(
        (element) =>
          Math.ceil(element.scrollTop + element.clientHeight) >= element.scrollHeight - 1,
      ),
    )
    .toBe(true)
}

async function expectKeyboardScrollable(region: Locator, axis: 'vertical' | 'horizontal') {
  const scrollProperty = axis === 'vertical' ? 'scrollTop' : 'scrollLeft'
  const sizeProperty = axis === 'vertical' ? 'scrollHeight' : 'scrollWidth'
  const clientProperty = axis === 'vertical' ? 'clientHeight' : 'clientWidth'
  await expect
    .poll(() =>
      region.evaluate(
        (element, properties) =>
          element[properties.sizeProperty as 'scrollHeight'] >
          element[properties.clientProperty as 'clientHeight'],
        { sizeProperty, clientProperty },
      ),
    )
    .toBe(true)
  await region.evaluate((element, property) => {
    element[property as 'scrollTop'] = 0
  }, scrollProperty)
  await region.focus()
  await region.press(axis === 'vertical' ? 'ArrowDown' : 'ArrowRight')
  await expect
    .poll(() =>
      region.evaluate((element, property) => element[property as 'scrollTop'], scrollProperty),
    )
    .toBeGreaterThan(0)
  await region.evaluate((element, property) => {
    element[property as 'scrollTop'] = 0
  }, scrollProperty)
}

async function expectScrollRegionsKeyboardReachable(page: Page) {
  const regions = page.locator('main [role="region"][tabindex="0"]:visible')
  for (let index = 0; index < (await regions.count()); index += 1) {
    const region = regions.nth(index)
    const overflow = await region.evaluate((element) => ({
      horizontal: element.scrollWidth > element.clientWidth,
      vertical: element.scrollHeight > element.clientHeight,
    }))
    if (overflow.horizontal) await expectKeyboardScrollable(region, 'horizontal')
    if (overflow.vertical) await expectKeyboardScrollable(region, 'vertical')
  }
}

async function expectCompactVerticalFlow(container: Locator) {
  const geometry = await container.evaluate((element) => {
    const containerRect = element.getBoundingClientRect()
    const childRects = Array.from(element.children)
      .filter((child) => getComputedStyle(child).display !== 'none')
      .map((child) => child.getBoundingClientRect())
    const gaps = childRects.slice(1).map((rect, index) => rect.top - childRects[index].bottom)
    return {
      childCount: childRects.length,
      topInset: childRects.length ? childRects[0].top - containerRect.top : Infinity,
      bottomInset: childRects.length
        ? containerRect.bottom - childRects[childRects.length - 1].bottom
        : Infinity,
      maximumGap: gaps.length ? Math.max(...gaps) : 0,
    }
  })

  expect(geometry.childCount).toBeGreaterThan(1)
  expect(geometry.topInset).toBeLessThanOrEqual(32)
  expect(geometry.bottomInset).toBeLessThanOrEqual(32)
  expect(geometry.maximumGap).toBeLessThanOrEqual(40)
}

const responsiveEvaluationSurfaces = [
  { tab: 'Overview', route: '/evaluation', visibleText: 'Decision readiness', capture: 'overview' },
  {
    tab: 'New experiment',
    route: '/evaluation?view=new',
    visibleText: 'New evaluation experiment',
    capture: 'new-experiment',
  },
  { tab: 'Runs', route: '/evaluation?view=runs', visibleText: 'Evaluation runs', capture: 'runs' },
  {
    tab: 'Reports',
    route: `/evaluation?view=reports&report=${EVALUATION_RUN_IDS.candidate}`,
    visibleText: 'Reports',
    capture: 'reports',
  },
  {
    tab: 'Compare',
    route: '/evaluation?view=compare',
    visibleText: 'Promotion campaign',
    capture: 'compare',
  },
] as const

async function expectResponsiveEvaluationSurface(
  page: Page,
  surface: (typeof responsiveEvaluationSurfaces)[number],
  viewportName: string,
) {
  const mobileViewport = viewportName.startsWith('mobile')
  await page.goto(surface.route)
  await expect(page.getByText(surface.visibleText, { exact: true }).first()).toBeVisible()
  const brand = page.getByRole('link', { name: 'vLLM Semantic Router home' })
  await expect(brand).toBeVisible()
  await expect
    .poll(async () => (await brand.boundingBox())?.y ?? -Infinity)
    .toBeGreaterThanOrEqual(0)
  const hero = page
    .getByRole('heading', { name: 'Evaluation', exact: true })
    .locator('xpath=ancestor::header[1]')
  await expect(hero).toBeVisible()
  await expect.poll(async () => (await hero.boundingBox())?.y ?? Infinity).toBeLessThan(100)
  if (mobileViewport) {
    await expect.poll(async () => (await hero.boundingBox())?.height ?? Infinity).toBeLessThan(190)
  }
  await expect(page.getByRole('tablist', { name: 'Evaluation plane views' })).toBeVisible()
  await expect
    .poll(async () => {
      const [tab, tablist] = await Promise.all([
        page.getByRole('tab', { name: surface.tab, exact: true }).boundingBox(),
        page.getByRole('tablist', { name: 'Evaluation plane views' }).boundingBox(),
      ])
      return Boolean(
        tab &&
          tablist &&
          tab.x >= tablist.x - 1 &&
          tab.x + tab.width <= tablist.x + tablist.width + 1,
      )
    })
    .toBe(true)
  if (mobileViewport) {
    const hasLeftOverflow = surface.tab !== 'Overview'
    const hasRightOverflow = surface.tab !== 'Compare'
    if (hasLeftOverflow) {
      await expect(page.getByTestId('evaluation-navigation-overflow-left')).toBeVisible()
    } else {
      await expect(page.getByTestId('evaluation-navigation-overflow-left')).toHaveCount(0)
    }
    if (hasRightOverflow) {
      await expect(page.getByTestId('evaluation-navigation-overflow-right')).toBeVisible()
    } else {
      await expect(page.getByTestId('evaluation-navigation-overflow-right')).toHaveCount(0)
    }
  }
  await expect(page.getByRole('button', { name: /product guide/i })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop),
      ),
    )
    .toBeLessThanOrEqual(1)
  await expectNoHorizontalOverflow(page)
  await captureEvaluationSurface(page, `${surface.capture}-${viewportName}`)
  if (viewportName === 'desktop') {
    await captureEvaluationFullPage(page, `${surface.capture}-${viewportName}-full`)
  }
  await expectScrollRegionsKeyboardReachable(page)
  await expectPageBottomReachable(page)
  await expectEvaluationBottomGutter(page)
  await captureEvaluationSurface(page, `${surface.capture}-${viewportName}-bottom`)
}

test.describe('Evaluation Plane', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedAppShell(page, {
      user: evalUser,
      settings: { readonlyMode: false, serverReadonly: false },
    })
  })

  test('shows the installed evidence range and complete eight-track contract', async ({ page }) => {
    await mockEvaluationPlane(page)
    await page.goto('/evaluation')

    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible()
    for (const tab of ['Overview', 'New experiment', 'Runs', 'Reports', 'Compare']) {
      await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible()
    }

    const heroMetadata = page.locator('dl').filter({
      has: page.getByText('Current suites', { exact: true }),
    })
    await expect(heroMetadata.getByText('E0 · E5', { exact: true })).toBeVisible()
    await expect(
      page.getByText(
        'This server-attested E0 report exposes a bounded set of independently reduced diagnostics. Promotion remains withheld until native benchmark and execution receipts qualify the claim.',
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
    await expect(
      readiness.getByRole('row').filter({ has: page.getByText('Routing', { exact: true }) }),
    ).toContainText('E0 · E3')
    await expectKeyboardScrollable(
      page.getByRole('region', { name: 'Scrollable evaluation track readiness' }),
      'vertical',
    )
    await expect(page.getByText('Schema evaluation.v1', { exact: true })).toBeVisible()
    await expect(page.getByText('evaluation-release-gates.v2', { exact: true })).toBeVisible()

    const declaredMethodCount = evaluationCatalog.suites.reduce(
      (count, suite) => count + suite.methods.length,
      0,
    )
    const methods = page.locator('section[aria-labelledby="evaluation-methods-title"]')
    const methodTable = methods.getByRole('table', {
      name: 'Server-declared evaluation methods and collection readiness',
    })
    await expect(methodTable.getByRole('row')).toHaveCount(declaredMethodCount + 1)
    await expectKeyboardScrollable(
      methods.getByRole('region', { name: 'Scrollable evaluation method readiness' }),
      'vertical',
    )
    const methodSearch = methods.getByLabel('Search evaluation methods')
    await methodSearch.fill('hard-policy')
    await expect(
      methodTable.getByRole('row').filter({
        has: page.getByText('safety.hard-policy-enforcement.v1', { exact: true }),
      }),
    ).toBeVisible()
    await expect(methods.getByRole('status')).toHaveText(
      `Showing 1 of ${declaredMethodCount} declared methods`,
    )
    await methodSearch.clear()
    await methods.getByLabel('Method track filter').selectOption('safety')
    await methods.getByLabel('Method readiness filter').selectOption('data_required')
    await expect(
      methodTable.getByRole('row').filter({
        has: page.getByText('safety.hard-policy-enforcement.v1', { exact: true }),
      }),
    ).toContainText(
      'Configure a server-owned hard-policy ledger endpoint with static rule proofs and dynamic enforcement observations.',
    )
    await expect(methods.getByRole('status')).toHaveText(
      `Showing 1 of ${declaredMethodCount} declared methods`,
    )
    await captureEvaluationSurface(page, 'overview-desktop')
  })

  test('contains long readiness evidence inside its own scroll region at 320px', async ({
    page,
  }) => {
    const longDescription =
      'Routes exact production request cohorts across a frozen Mixture-of-Models pool while preserving abstention, fallback, selector latency, and per-arm outcome provenance for release review.'
    const longCatalog = {
      ...evaluationCatalog,
      tracks: evaluationCatalog.tracks.map((track) =>
        track.id === 'routing'
          ? {
              ...track,
              description: longDescription,
            }
          : track,
      ),
    }
    await page.setViewportSize({ width: 320, height: 568 })
    await mockEvaluationPlane(page, defaultEvaluationRuns, { catalog: longCatalog })
    await page.goto('/evaluation')

    const readiness = page.getByRole('region', {
      name: 'Scrollable evaluation track readiness',
    })
    await expect(readiness).toBeVisible()
    await expect(readiness).toHaveAttribute('tabindex', '0')
    await expect(readiness.getByText(longDescription, { exact: true })).toBeVisible()
    await expect
      .poll(() => readiness.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0)
    await expectKeyboardScrollable(readiness, 'horizontal')
    await expectNoHorizontalOverflow(page)
  })

  test('keeps the initial loading boundary until catalog and durable ledger both settle', async ({
    page,
  }) => {
    await mockEvaluationPlane(page, defaultEvaluationRuns, { ledgerDelayMs: 750 })
    const catalogResponse = page.waitForResponse('**/api/evaluation/v1/catalog')
    await page.goto('/evaluation')
    await catalogResponse

    await expect(page.getByText('Loading evaluation plane', { exact: true })).toBeVisible()
    await expect(page.getByText('Decision readiness', { exact: true })).toHaveCount(0)

    await expect(page.getByText('Loading evaluation plane', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Decision readiness', { exact: true })).toBeVisible()
  })

  test('keeps evidence navigation available while suppressing run mutations in read-only mode', async ({
    page,
  }) => {
    await mockAuthenticatedAppShell(page, {
      user: evalUser,
      settings: { readonlyMode: true, serverReadonly: true },
    })
    await mockEvaluationPlane(page)
    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.candidate}`)

    await expect(page.getByText(/Server read-only policy disables creation/i)).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Open report for Candidate recipe` }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete Candidate recipe' })).toHaveCount(0)
    await page.getByRole('button', { name: `Open report for Candidate recipe` }).click()
    await expect(page.getByRole('heading', { name: 'Candidate recipe' })).toBeVisible()
  })

  test('exposes advanced promotion evidence with a discoverable touch disclosure at 320px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=compare')

    const disclosure = page.locator('details').filter({
      has: page.getByText('Review / customize evidence', { exact: true }),
    })
    const summary = disclosure.locator('summary')
    await expect(disclosure).not.toHaveAttribute('open', '')
    await expect
      .poll(() => summary.evaluate((element) => getComputedStyle(element, '::after').content))
      .not.toBe('none')
    await summary.click()
    await expect(disclosure).toHaveAttribute('open', '')
    await expect(page.getByRole('region', { name: 'Campaign evidence slots' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await summary.click()
    await expect(disclosure).not.toHaveAttribute('open', '')
  })

  test('keeps native radio and checkbox inline width outside the shared field skin', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=new')

    for (const control of [page.getByRole('radio').first(), page.getByRole('checkbox').first()]) {
      await expect(control).toBeVisible()
      await control.hover()
      await control.focus()
      const width = await control.evaluate((element) => element.getBoundingClientRect().width)
      expect(width).toBeLessThanOrEqual(24)
    }
    await expectNoHorizontalOverflow(page)
  })

  test('loads the run ledger incrementally without hiding the server total', async ({ page }) => {
    const runs = Array.from({ length: 12 }, (_, index) =>
      evaluationRun(
        evaluationRunID(100 + index),
        `Evaluation ${index + 1}`,
        'completed',
        `2026-08-${String(29 - index).padStart(2, '0')}T00:00:00Z`,
      ),
    )
    await mockEvaluationPlane(page, runs, { runPageSize: 5 })
    await page.goto('/evaluation?view=runs')

    await expect(
      page.getByText('5 matching among loaded · 5 of 12 runs loaded', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(
        'Search and filters cover only the 5 loaded runs. Load older records to search and filter the full ledger.',
        { exact: true },
      ),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(
      page.getByText('10 matching among loaded · 10 of 12 runs loaded', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(
      page.getByText('12 matching among loaded · 12 of 12 runs loaded', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0)
    await expect(page.getByText(/Search and filters cover only/)).toHaveCount(0)
  })

  test('resolves paginated run, report, and comparison deep links by exact identity', async ({
    page,
  }) => {
    const recent = Array.from({ length: 50 }, (_, index) =>
      evaluationRun(
        evaluationRunID(200 + index),
        `Recent evaluation ${index + 1}`,
        'completed',
        `2026-08-${String(29 - (index % 20)).padStart(2, '0')}T00:00:00Z`,
      ),
    )
    const olderBaseline = evaluationRun(
      EVALUATION_RUN_IDS.olderBaseline,
      'Older production baseline',
      'completed',
      '2026-07-01T00:00:00Z',
    )
    const olderCandidate = evaluationRun(
      EVALUATION_RUN_IDS.olderCandidate,
      'Older routed candidate',
      'completed',
      '2026-07-02T00:00:00Z',
      'recipe',
      { baseline_run_id: olderBaseline.id },
    )
    const state = await mockEvaluationPlane(page, [...recent, olderCandidate, olderBaseline], {
      runPageSize: 50,
    })

    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.olderCandidate}`)
    await expect(page.getByRole('heading', { name: 'Older routed candidate' })).toBeVisible()
    expect(state.runRequests).toContain(EVALUATION_RUN_IDS.olderCandidate)

    await page.goto(`/evaluation?view=reports&report=${EVALUATION_RUN_IDS.olderCandidate}`)
    await expect(page.getByRole('heading', { name: 'Older routed candidate' })).toBeVisible()
    await expect(page.getByLabel('Run')).toHaveValue(EVALUATION_RUN_IDS.olderCandidate)

    await page.goto(
      `/evaluation?view=compare&baseline=${EVALUATION_RUN_IDS.olderBaseline}&candidate=${EVALUATION_RUN_IDS.olderCandidate}`,
    )
    await expect(page.getByLabel('Comparison candidate')).toHaveValue(
      EVALUATION_RUN_IDS.olderCandidate,
    )
    await expect(page.getByLabel('Pinned baseline')).toHaveValue('Older production baseline')
    await page.getByRole('button', { name: 'Compare paired evidence' }).click()
    await expect.poll(() => state.comparisonRequests.length).toBe(1)
    expect(state.comparisonRequests[0]).toEqual({
      baselineRunID: EVALUATION_RUN_IDS.olderBaseline,
      candidateRunID: EVALUATION_RUN_IDS.olderCandidate,
    })
  })

  test('refreshes an off-page selected run directly when its terminal event arrives', async ({
    page,
  }) => {
    const recent = Array.from({ length: 50 }, (_, index) =>
      evaluationRun(
        evaluationRunID(400 + index),
        `Recent terminal refresh ${index + 1}`,
        'completed',
        `2026-08-${String(29 - (index % 20)).padStart(2, '0')}T00:00:00Z`,
      ),
    )
    const offPageRun = evaluationRun(
      evaluationRunID(499),
      'Off-page live evaluation',
      'running',
      '2026-07-01T00:00:00Z',
    )
    const state = await mockEvaluationPlane(page, [...recent, offPageRun], {
      runPageSize: 50,
      completeRunOnEventStream: offPageRun.id,
    })

    await page.goto(`/evaluation?view=runs&run=${offPageRun.id}`)
    await expect(page.getByRole('heading', { name: offPageRun.name })).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Open report for ${offPageRun.name}` }),
    ).toBeVisible()
    await expect
      .poll(() => state.runRequests.filter((runID) => runID === offPageRun.id).length)
      .toBeGreaterThanOrEqual(2)
    await expect(
      page.getByText('50 matching among loaded · 50 of 51 runs loaded', { exact: true }),
    ).toBeVisible()
  })

  test('resumes first-page polling after a load-more request fails', async ({ page }) => {
    const runs = Array.from({ length: 6 }, (_, index) =>
      evaluationRun(
        evaluationRunID(300 + index),
        `Polling evaluation ${index + 1}`,
        'completed',
        `2026-08-${String(29 - index).padStart(2, '0')}T00:00:00Z`,
      ),
    )
    const state = await mockEvaluationPlane(page, runs, {
      runPageSize: 5,
      failFirstLoadMore: true,
    })
    await page.goto('/evaluation?view=runs')

    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(page.getByText(/temporary ledger page failure/)).toBeVisible()
    const requestCountAfterFailure = state.getLedgerRequestCount()
    await expect
      .poll(() => state.getLedgerRequestCount(), { timeout: 7_000 })
      .toBeGreaterThan(requestCountAfterFailure)
    await expect(page.getByText(/temporary ledger page failure/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(
      page.getByText('6 matching among loaded · 6 of 6 runs loaded', { exact: true }),
    ).toBeVisible()
  })

  test('keeps completed evidence identity honest while the newest report is loading', async ({
    page,
  }) => {
    await mockEvaluationPlane(page, defaultEvaluationRuns, { reportDelayMs: 750 })
    await page.goto('/evaluation')

    await expect(page.getByText('Loading report summary…', { exact: true })).toBeVisible()
    await expect(page.locator('#evaluation-readiness-title')).toHaveText('Candidate recipe')
    await expect(page.locator('#latest-evidence-title')).toHaveText('Candidate recipe')
    await expect(
      page.getByText(
        'Loading the newest completed report and its server attestation. No decision state is inferred while evidence is in flight.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(
      page.getByText('Establish the first evidence baseline', { exact: true }),
    ).toHaveCount(0)
    await expect(page.getByText('No completed report yet', { exact: true })).toHaveCount(0)

    await expect(page.getByText('Loading report summary…', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/server-attested E0 report exposes a bounded set/i)).toBeVisible()
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

    await expect(page.getByText('Catalog evidence class E0', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/cannot supply its own execution address/i)).toBeVisible()
    await page.getByRole('radio', { name: /Replay/ }).check()
    await page.getByLabel('Evidence target').selectOption('fixture')
    await page.getByRole('checkbox', { name: /Evaluation harness smoke/ }).check()
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

  test('freezes the live Capacity SLO and repeated load protocol in the run', async ({ page }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=new')

    await page.getByRole('radio', { name: /Live Execute against/ }).check()
    await page.getByLabel('Mixture to evaluate').selectOption(EVALUATION_MOM_TARGET_ID)
    await expect(page.getByLabel('Mixture to evaluate')).toHaveValue(EVALUATION_MOM_TARGET_ID)
    await page.getByRole('checkbox', { name: /Live Mixture-of-Models core/ }).uncheck()
    await page.getByRole('checkbox', { name: /Live capacity/ }).check()

    const capacity = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Capacity service objective' }),
    })
    const requiredConcurrency = capacity.getByRole('spinbutton', {
      name: /^Required concurrency/,
    })
    await expect(requiredConcurrency).toHaveValue('')
    await capacity.getByRole('button', { name: /Balanced service/ }).click()
    await expect(requiredConcurrency).toHaveValue('4')
    await expect(capacity.getByRole('spinbutton', { name: /^Maximum p95 latency/ })).toHaveValue(
      '750',
    )
    await expect(capacity.getByRole('spinbutton', { name: /^Maximum error rate/ })).toHaveValue(
      '0.02',
    )
    await expect(capacity.getByRole('spinbutton', { name: /^Minimum throughput/ })).toHaveValue(
      '10',
    )
    await expect(
      capacity.getByRole('spinbutton', { name: /^Minimum scaling efficiency/ }),
    ).toHaveValue('0.7')
    await expect(capacity.getByLabel('Frozen capacity load protocol')).toContainText('c1 → c2 → c4')
    await expect(capacity.getByLabel('Frozen capacity load protocol')).toContainText(
      '100 requests × 3 repetitions',
    )

    await page.getByLabel('Experiment name').fill('Live capacity operating point')
    await requiredConcurrency.fill('5')
    await page.getByRole('button', { name: 'Create and start' }).click()
    await expect
      .poll(() => requiredConcurrency.evaluate((input: HTMLInputElement) => input.validity.valid))
      .toBe(false)
    expect(state.createdRequests).toHaveLength(0)

    await requiredConcurrency.fill('4')
    await page.setViewportSize({ width: 390, height: 844 })
    await expectNoHorizontalOverflow(page)
    await page.getByRole('button', { name: 'Create and start' }).click()

    await expect.poll(() => state.createdRequests.length).toBe(1)
    expect(state.createdRequests[0]).toMatchObject({
      name: 'Live capacity operating point',
      mode: 'live',
      target_id: EVALUATION_MOM_TARGET_ID,
      suite_ids: ['live-capacity'],
      track_ids: ['capacity'],
      concurrency: 4,
      capacity_slo: {
        schema_version: 'evaluation.v1',
        required_concurrency: 4,
        max_latency_p95_ms: 750,
        max_error_rate: 0.02,
        min_throughput_rps: 10,
        min_throughput_scaling_efficiency: 0.7,
      },
      capacity_load_protocol: {
        schema_version: 'evaluation.v1',
        kind: 'closed-loop',
        concurrency_levels: [1, 2, 4],
        warmup_request_multiplier: 2,
        measurement_requests_per_repetition: 100,
        repetitions_per_level: 3,
        confidence_level: 0.95,
        max_throughput_cv: 0.2,
        max_latency_p95_cv: 0.2,
      },
    })
    await expect.poll(state.getStartCount).toBe(1)
  })

  test('copies and locks the exact cohort when creating a candidate from a baseline', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page)
    await page.goto('/evaluation?view=new')

    await page.getByLabel('Baseline run').selectOption(EVALUATION_RUN_IDS.baseline)
    await expect(
      page.getByText(
        'Exact cohort copied and locked: profile, mode, target, suites, tracks, sample limit, concurrency, capacity contracts, and seed.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(page.getByLabel('Change profile')).toHaveValue('recipe')
    await expect(page.getByLabel('Change profile')).toBeDisabled()
    await expect(page.getByLabel('Evidence target')).toHaveValue('fixture')
    await expect(page.getByLabel('Evidence target')).toBeDisabled()
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
      baseline_run_id: EVALUATION_RUN_IDS.baseline,
      mode: 'replay',
      target_id: 'fixture',
      change_profile: 'recipe',
      suite_ids: ['evaluation-smoke'],
      track_ids: [...evaluationCatalog.suites[0].track_ids],
      sample_limit: 4,
      concurrency: 4,
      seed: 42,
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

    const statuses = await page.evaluate(
      async ([failedRunID, cancelledRunID]) => {
        const [failed, cancelled] = await Promise.all([
          fetch(`/api/evaluation/v1/runs/${failedRunID}/report`),
          fetch(`/api/evaluation/v1/runs/${cancelledRunID}/report`),
        ])
        return [failed.status, cancelled.status]
      },
      [EVALUATION_RUN_IDS.failed, EVALUATION_RUN_IDS.cancelled],
    )
    expect(statuses).toEqual([409, 409])
    expect(state.reportRequests).toEqual(
      expect.arrayContaining([
        EVALUATION_RUN_IDS.candidate,
        EVALUATION_RUN_IDS.failed,
        EVALUATION_RUN_IDS.cancelled,
      ]),
    )
  })

  test('keeps workspace-owned route state isolated', async ({ page }) => {
    await mockEvaluationPlane(page)
    await page.goto(`/evaluation?report=${EVALUATION_RUN_IDS.unpaired}`)

    await expect(page.locator('#latest-evidence-title')).toHaveText('Candidate recipe')
    await page.getByRole('button', { name: 'Open full report' }).click()

    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('reports')
    await expect
      .poll(() => new URL(page.url()).searchParams.get('report'))
      .toBe(EVALUATION_RUN_IDS.candidate)
    await expect(page.getByRole('heading', { name: 'Candidate recipe' })).toBeVisible()
    await expect(
      page
        .locator('section[aria-labelledby="report-diagnostics-title"]')
        .getByText('Total records')
        .locator('..'),
    ).toContainText('32')
  })

  test('keeps the selected report explicit during a service outage', async ({ page }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, {
      reportFailureIDs: [EVALUATION_RUN_IDS.candidate],
      reportFailureStatus: 503,
    })
    await page.goto('/evaluation')

    await expect(page.getByText('report storage is temporarily unavailable')).toBeVisible()
    expect(state.reportRequests).toEqual([EVALUATION_RUN_IDS.candidate])
  })

  test('changes a comparison candidate and its pinned baseline atomically', async ({ page }) => {
    const secondBaseline = evaluationRun(
      EVALUATION_RUN_IDS.secondBaseline,
      'Second baseline',
      'completed',
      '2026-08-26T00:00:00Z',
    )
    const secondCandidate = evaluationRun(
      EVALUATION_RUN_IDS.secondCandidate,
      'Second candidate',
      'completed',
      '2026-08-29T12:00:00Z',
      'recipe',
      { baseline_run_id: secondBaseline.id },
    )
    await mockEvaluationPlane(page, [secondCandidate, secondBaseline, ...defaultEvaluationRuns])
    await page.goto(
      `/evaluation?view=compare&baseline=${EVALUATION_RUN_IDS.baseline}&candidate=${EVALUATION_RUN_IDS.candidate}`,
    )

    await page.getByRole('button', { name: 'Compare paired evidence' }).click()
    await expect(page.getByRole('table', { name: 'Paired comparison metrics' })).toBeVisible()
    await page.getByLabel('Comparison candidate').selectOption(secondCandidate.id)

    await expect(page.getByRole('table', { name: 'Paired comparison metrics' })).toHaveCount(0)
    await expect(
      page.getByText('Choose a candidate, then calculate its paired comparison.'),
    ).toBeVisible()
    await expect
      .poll(() => new URL(page.url()).searchParams.get('candidate'))
      .toBe(secondCandidate.id)
    await expect
      .poll(() => new URL(page.url()).searchParams.get('baseline'))
      .toBe(secondBaseline.id)
    await expect(page.getByLabel('Pinned baseline')).toHaveValue(secondBaseline.name)
  })

  test('withholds E0 promotion claims while retaining diagnostics and never fakes G2+ pass', async ({
    page,
  }) => {
    await mockEvaluationPlane(page)
    await page.goto(`/evaluation?view=reports&report=${EVALUATION_RUN_IDS.candidate}`)

    await expect(
      page.getByText('Promotion summary withheld — server-attested diagnostic E0', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Diagnostic evidence only' })).toBeVisible()
    await expect(page.getByText(/case-track observations/)).toBeVisible()
    const findings = page.locator('details').filter({ hasText: 'Diagnostic findings' })
    await findings.locator('summary').click()
    await expect(findings.getByText(/worker-derived rule-based diagnostics/i)).toBeVisible()

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
    await page.getByRole('heading', { name: 'Diagnostic evidence only' }).scrollIntoViewIfNeeded()
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

  test('pages dense metric reports and resets the page when filters change', async ({ page }) => {
    await mockEvaluationPlane(page, defaultEvaluationRuns, { reportMetricCount: 45 })
    await page.goto(`/evaluation?view=reports&report=${EVALUATION_RUN_IDS.candidate}`)

    const metrics = page.getByRole('table', { name: 'Evaluation metrics' })
    await expect(metrics.getByRole('row')).toHaveCount(21)
    await expect(page.getByText('1–20 of 45', { exact: true })).toBeVisible()
    await expect(page.getByText('Page 1 of 3', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible()
    await expect(page.getByText('21–40 of 45', { exact: true })).toBeVisible()

    await page.getByLabel('Find a metric').fill('metric 45')
    await expect(page.getByText('1–1 of 1 matching · 45 total', { exact: true })).toBeVisible()
    await expect(page.getByText('Page 2 of 3', { exact: true })).toHaveCount(0)
    await expect(metrics.getByRole('row')).toHaveCount(2)
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
    await page.goto(`/evaluation?view=reports&report=${EVALUATION_RUN_IDS.candidate}`)

    await expect(
      page.getByText('Promotion summary withheld — server-attested diagnostic E0', {
        exact: true,
      }),
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
    await page.goto(
      `/evaluation?view=compare&baseline=${EVALUATION_RUN_IDS.baseline}&candidate=${EVALUATION_RUN_IDS.candidate}`,
    )

    await expect(
      page.getByRole('heading', { name: 'Compare a candidate with its pinned baseline' }),
    ).toBeVisible()
    const candidates = page.getByLabel('Comparison candidate')
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
      baselineRunID: EVALUATION_RUN_IDS.baseline,
      candidateRunID: EVALUATION_RUN_IDS.candidate,
    })

    const table = page.getByRole('table', { name: 'Paired comparison metrics' })
    const quality = table.getByRole('row').filter({ hasText: 'joint.realized_quality' })
    await expect(quality).toContainText('Higher is better')
    await expect(quality.locator('strong[class*="delta_positive"]')).toHaveText('+3.0%')
    const latency = table.getByRole('row').filter({ hasText: 'capacity.latency_p95_ms' })
    await expect(latency).toContainText('Lower is better')
    await expect(latency.locator('strong[class*="delta_positive"]')).toHaveText('−28 ms')
    const statistics = page.getByRole('table', {
      name: 'Server-reduced paired scientific statistics',
    })
    const normalizedRegret = statistics.getByRole('row').filter({
      hasText: 'joint.normalized_regret',
    })
    await expect(normalizedRegret).toContainText('Case normalized regret')
    await expect(normalizedRegret).toContainText('Not estimable')
    await expect(normalizedRegret).toContainText(
      'Needs at least 20 independent case units; observed 4.',
    )
    const comparisonGates = page.locator(
      'section[aria-labelledby="evaluation-comparison-gates-title"]',
    )
    await expect(comparisonGates).toBeVisible()
    const g3 = comparisonGates.locator('article').filter({ hasText: 'G3' })
    await expect(g3.getByText('Evidence needed', { exact: true })).toBeVisible()
    await expect(g3.getByText('Passed', { exact: true })).toHaveCount(0)
    await table.scrollIntoViewIfNeeded()
    await captureEvaluationSurface(page, 'comparison-results-desktop')
  })

  test('builds and reloads a server-attested promotion campaign above diagnostic comparison', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const campaignCoreTracks = ['routing', 'model_pool', 'joint'] as const
    const campaignCoreSuite = ['live-mom-core']
    const baselineLive = evaluationRun(
      EVALUATION_RUN_IDS.baselineLive,
      'Recipe live control',
      'completed',
      '2026-08-29T01:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: campaignCoreSuite,
        track_ids: [...campaignCoreTracks],
        evidence_level: 'E3',
        track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
        sample_limit: 64,
        target_id: EVALUATION_BASELINE_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        completed_at: '2026-08-29T01:10:00Z',
      },
    )
    const candidateLive = evaluationRun(
      EVALUATION_RUN_IDS.candidateLive,
      'Recipe live treatment',
      'completed',
      '2026-08-29T02:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: campaignCoreSuite,
        track_ids: [...campaignCoreTracks],
        evidence_level: 'E3',
        track_evidence_levels: { routing: 'E3', model_pool: 'E4', joint: 'E5' },
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        completed_at: '2026-08-29T02:10:00Z',
      },
    )
    const hardPolicy = evaluationRun(
      EVALUATION_RUN_IDS.campaignG2,
      'Hard-policy qualification',
      'completed',
      '2026-08-29T03:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: ['live-hard-policy'],
        track_ids: ['safety'],
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        evidence_level: 'E4',
        completed_at: '2026-08-29T03:10:00Z',
      },
    )
    const declaredShift = evaluationRun(
      EVALUATION_RUN_IDS.campaignG4,
      'Declared-shift qualification',
      'completed',
      '2026-08-29T04:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: ['normalized-promotion-cohort'],
        track_ids: ['routing'],
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        evidence_level: 'E4',
        completed_at: '2026-08-29T04:10:00Z',
      },
    )
    const fidelityReference = evaluationRun(
      EVALUATION_RUN_IDS.campaignG5Reference,
      'Live fidelity reference',
      'completed',
      '2026-08-29T05:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: ['normalized-promotion-cohort'],
        track_ids: ['joint'],
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        evidence_level: 'E4',
        completed_at: '2026-08-29T05:10:00Z',
      },
    )
    const fidelityLive = evaluationRun(
      EVALUATION_RUN_IDS.campaignG5Live,
      'Fresh live fidelity confirmation',
      'completed',
      '2026-08-29T06:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: ['normalized-promotion-cohort'],
        track_ids: ['joint'],
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        evidence_level: 'E5',
        completed_at: '2026-08-29T06:10:00Z',
      },
    )
    const capacity = evaluationRun(
      EVALUATION_RUN_IDS.campaignG7,
      'Capacity envelope qualification',
      'completed',
      '2026-08-29T07:00:00Z',
      'recipe',
      {
        mode: 'live',
        suite_ids: ['live-capacity'],
        track_ids: ['capacity'],
        sample_limit: 64,
        target_id: EVALUATION_MOM_TARGET_ID,
        mixture: EVALUATION_MOM,
        evidence_level: 'E5',
        completed_at: '2026-08-29T07:10:00Z',
      },
    )
    const state = await mockEvaluationPlane(
      page,
      [
        capacity,
        fidelityLive,
        fidelityReference,
        declaredShift,
        hardPolicy,
        candidateLive,
        baselineLive,
        ...defaultEvaluationRuns,
      ],
      { campaignGetDelayMs: 250, failFirstControlledPair: true },
    )
    await page.goto('/evaluation?view=compare')

    await expect(page.getByRole('heading', { name: 'Promotion campaign' })).toBeVisible()
    await expect(
      page.getByText(/scientific diagnostic does not issue a promotion decision/i),
    ).toBeVisible()
    const evidenceDisclosure = page.locator('details').filter({
      has: page.getByText('Review / customize evidence', { exact: true }),
    })
    await expect(page.getByLabel('Controlled pair baseline source')).not.toBeVisible()
    await evidenceDisclosure.locator('summary').focus()
    await evidenceDisclosure.locator('summary').press('Enter')
    await expect(evidenceDisclosure).toHaveAttribute('open', '')
    await expect(page.getByLabel('Controlled pair baseline source')).toBeVisible()
    await evidenceDisclosure.locator('summary').press('Enter')
    await expect(evidenceDisclosure).not.toHaveAttribute('open', '')
    await evidenceDisclosure.locator('summary').press('Enter')
    await expect(evidenceDisclosure).toHaveAttribute('open', '')
    await page
      .getByLabel('Controlled pair baseline source')
      .selectOption(EVALUATION_RUN_IDS.baselineLive)
    await page
      .getByLabel('Controlled pair candidate source')
      .selectOption(EVALUATION_RUN_IDS.candidateLive)
    await page.getByRole('button', { name: 'Launch controlled pair' }).click()
    await expect(page.getByRole('alert')).toContainText('two worker slots are required')
    await page.getByRole('button', { name: 'Retry controlled pair' }).click()
    await expect.poll(() => state.controlledPairRequests.length).toBe(2)
    const controlledPairRequest = state.controlledPairRequests[1]
    expect(Object.keys(controlledPairRequest).sort()).toEqual([
      'baseline_run_id',
      'baseline_source_run_id',
      'candidate_run_id',
      'candidate_source_run_id',
      'client_request_id',
    ])
    expect(controlledPairRequest).toMatchObject({
      baseline_source_run_id: EVALUATION_RUN_IDS.baselineLive,
      candidate_source_run_id: EVALUATION_RUN_IDS.candidateLive,
    })
    await expect(
      page.getByText('Fresh baseline and candidate runs completed and were bound to G3.'),
    ).toBeVisible()
    await expect(page.getByLabel('G3 controlled pair evidence')).toContainText(
      'Controlled baseline AB/BA → Controlled candidate AB/BA',
    )
    await page.getByLabel('G2 Hard policy evidence').selectOption(EVALUATION_RUN_IDS.campaignG2)
    await page
      .getByLabel('G4 Declared-shift robustness evidence')
      .selectOption(EVALUATION_RUN_IDS.campaignG4)
    await page
      .getByLabel('G5 fidelity reference')
      .selectOption(EVALUATION_RUN_IDS.campaignG5Reference)
    await page
      .getByLabel('G5 fidelity live evidence')
      .selectOption(EVALUATION_RUN_IDS.campaignG5Live)
    await page
      .getByLabel('G7 Cost / latency / capacity evidence')
      .selectOption(EVALUATION_RUN_IDS.campaignG7)
    await page.getByLabel('Campaign name').fill('Recipe v4 guarded promotion')
    await page
      .locator('details')
      .filter({ has: page.getByText('Decision context', { exact: true }) })
      .locator('summary')
      .click()
    await page
      .getByLabel('Decision context')
      .fill('Promote the exact replay treatment after paired target and confirmation evidence.')
    await captureEvaluationSurface(page, 'campaign-builder-desktop')
    await page.getByRole('button', { name: 'Create promotion decision' }).click()

    await expect.poll(() => state.campaignRequests.length).toBe(1)
    const request = state.campaignRequests[0]
    expect(request).toMatchObject({
      name: 'Recipe v4 guarded promotion',
      change_profile: 'recipe',
      gate_bindings: {
        g2_run_id: EVALUATION_RUN_IDS.campaignG2,
        g3_controlled_pair: {
          baseline_run_id: controlledPairRequest.baseline_run_id,
          candidate_run_id: controlledPairRequest.candidate_run_id,
        },
        g4_run_id: EVALUATION_RUN_IDS.campaignG4,
        g5_fidelity: {
          reference_run_id: EVALUATION_RUN_IDS.campaignG5Reference,
          live_run_id: EVALUATION_RUN_IDS.campaignG5Live,
        },
        g7_run_id: EVALUATION_RUN_IDS.campaignG7,
      },
    })
    await expect
      .poll(() => new URL(page.url()).searchParams.get('campaign'))
      .toBe(request.client_request_id)
    await expect(page.getByRole('heading', { name: 'Recipe v4 guarded promotion' })).toBeVisible()
    await expect(page.getByText('All required promotion campaign gates passed.')).toBeVisible()
    await expect(page.getByText('Decision digest', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Copy decision digest' }).click()
    await expect(page.getByRole('button', { name: 'Copied decision digest' })).toBeVisible()
    await captureEvaluationSurface(page, 'campaign-decision-desktop')
    const pairedLive = page.locator('section[aria-labelledby="campaign-paired-live-title"]')
    const pairedTableRegion = pairedLive.getByRole('region', {
      name: 'Paired live statistic matrix',
    })
    const pairedTable = pairedLive.getByRole('table', {
      name: 'Paired baseline and candidate statistics',
    })
    await expect(pairedLive.getByText('1,000 samples · 95% CI', { exact: true })).toBeVisible()
    await expect(pairedTable.getByRole('row')).toHaveCount(11)
    await expect(
      pairedTable.getByRole('row', { name: /routing Quality non-inferiority/i }),
    ).toContainText('+0.01')
    await expect(pairedTable.getByRole('row', { name: /routing Failure risk/i })).toContainText(
      'Passed',
    )
    await expect(
      pairedTable.getByRole('row', { name: /model pool All-arm failure risk/i }),
    ).toContainText('Passed')
    const promotionTable = pairedLive.getByRole('table', { name: 'G3 promotion statistics' })
    await expect(promotionTable.getByRole('row')).toHaveCount(6)
    await expect(promotionTable.getByRole('row', { name: /Pool availability/i })).toContainText(
      '<= 0.2 fraction',
    )
    const fidelity = page.locator('section[aria-labelledby="campaign-fidelity-title"]')
    await expect(fidelity.getByRole('heading', { name: 'Live fidelity receipt' })).toBeVisible()
    await expect(fidelity.getByText('59', { exact: true }).first()).toBeVisible()
    await expect(fidelity.getByText('Passed', { exact: true })).toBeVisible()
    const copyPairedDigest = pairedLive.getByRole('button', {
      name: 'Copy paired live evidence digest',
    })
    await copyPairedDigest.focus()
    await page.keyboard.press('Enter')
    await expect(
      pairedLive.getByRole('button', { name: 'Copied paired live evidence digest' }),
    ).toBeVisible()
    await pairedTableRegion.focus()
    await expect(pairedTableRegion).toBeFocused()
    await expectCompactVerticalFlow(pairedLive)
    await expectNoHorizontalOverflow(page)
    await captureEvaluationElement(pairedLive, 'campaign-paired-live-desktop')
    await captureEvaluationFullPage(page, 'campaign-decision-desktop-full')
    await expectPageBottomReachable(page)
    await captureEvaluationSurface(page, 'campaign-decision-desktop-bottom')
    await page.evaluate(() => {
      const root = document.scrollingElement
      if (root) root.scrollTop = 0
    })
    const gates = page.locator('section[aria-labelledby="campaign-gates-title"]')
    await expect(gates.locator('article')).toHaveCount(10)
    const anchors = page.locator('section[aria-labelledby="campaign-evidence-title"]')
    await expect(anchors.locator('article')).toHaveCount(7)
    await expect(anchors.getByText('Server execution', { exact: true })).toHaveCount(7)
    const copyExecution = anchors
      .getByRole('button', { name: 'Copy server execution digest' })
      .first()
    await copyExecution.click()
    await expect(
      anchors.getByRole('button', { name: 'Copied server execution digest' }).first(),
    ).toBeVisible()
    await expect(gates.getByText('gate_binding', { exact: true }).first()).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Compare a candidate with its pinned baseline' }),
    ).toBeVisible()

    await expect
      .poll(
        () =>
          state.campaignGetRequests.filter((campaignID) => campaignID === request.client_request_id)
            .length,
      )
      .toBeGreaterThan(0)
    await page.waitForTimeout(300)
    state.rejectCampaignGets()
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('temporary campaign read failure')
    const retryDecision = page.getByRole('button', { name: 'Retry decision' })
    state.allowCampaignGets()
    await retryDecision.click()
    await expect(page.getByRole('button', { name: 'Retrying decision…' })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'Recipe v4 guarded promotion' })).toBeVisible()
    expect(state.campaignGetRequests).toContain(request.client_request_id)

    await page.setViewportSize({ width: 1024, height: 768 })
    await page.evaluate(() => {
      const root = document.scrollingElement
      if (root) root.scrollTop = 0
    })
    await expectNoHorizontalOverflow(page)
    await expectCompactVerticalFlow(pairedLive)
    await captureEvaluationSurface(page, 'campaign-decision-tablet')
    await captureEvaluationElement(pairedLive, 'campaign-paired-live-tablet')
    await expectPageBottomReachable(page)
    await captureEvaluationSurface(page, 'campaign-decision-tablet-bottom')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      const root = document.scrollingElement
      if (root) root.scrollTop = 0
    })
    await expect(page.getByRole('button', { name: 'Build another campaign' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectCompactVerticalFlow(pairedLive)
    await captureEvaluationSurface(page, 'campaign-decision-mobile')
    await expectKeyboardScrollable(pairedTableRegion, 'horizontal')
    await captureEvaluationElement(pairedLive, 'campaign-paired-live-mobile')
    await expectPageBottomReachable(page)
    await captureEvaluationSurface(page, 'campaign-decision-mobile-bottom')
    await page.evaluate(() => {
      const root = document.scrollingElement
      if (root) root.scrollTop = 0
    })

    await page.getByRole('button', { name: 'Build another campaign' }).click()
    await expect(page.getByText('Promotion readiness', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Campaign name')).toHaveValue('')
    await expect.poll(() => new URL(page.url()).searchParams.get('campaign')).toBeNull()
    await expectNoHorizontalOverflow(page)
  })

  test('keeps quarantined run evidence visible and blocks partial-ledger decisions', async ({
    page,
  }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, {
      ledgerWarningCount: 3,
      ledgerWarnings: [
        {
          code: 'corrupt_run_bundle',
          evidence_id: 'bundle-entry-7f9d2a',
          evidence_file: 'status.json',
          message: 'Durable run status evidence is unreadable or invalid and has been quarantined.',
        },
      ],
    })
    await page.goto(
      `/evaluation?view=compare&baseline=${EVALUATION_RUN_IDS.baseline}&candidate=${EVALUATION_RUN_IDS.candidate}`,
    )

    await expect(page.getByText('Run ledger incomplete', { exact: true })).toBeVisible()
    await expect(page.getByText(/3 durable run bundles are quarantined/)).toBeVisible()
    await expect(
      page.getByText('Showing 1 of 3 warning details returned by the ledger.', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('bundle-entry-7f9d2a', { exact: true })).toBeVisible()
    await expect(page.getByText(/status\.json: Durable run status evidence/)).toBeVisible()
    await expect(page.getByLabel('Comparison candidate')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Compare paired evidence' })).toBeDisabled()
    await expect(
      page.getByText(/Baseline selection and comparison conclusions are blocked/),
    ).toBeVisible()
    await expect(page.getByLabel('Comparison candidate')).toHaveValue('')
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
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, {
      mutationDelayMs: 400,
      failFirstCancel: true,
    })
    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.live}`)

    await page.getByRole('button', { name: 'Cancel Live AMD validation' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Execution stops and no completed report is published.')
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await expectDialogBottomReachable(page, dialog)
    await captureEvaluationSurface(page, 'cancel-dialog')
    await dialog.getByRole('button', { name: 'Cancel run' }).click()
    await expect(dialog.getByRole('alert')).toContainText('temporary cancellation failure')
    await expect(dialog.getByRole('button', { name: 'Cancel run' })).toBeEnabled()

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
    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.failed}`)

    await page.getByRole('button', { name: 'Delete Failed diagnostic' }).click()
    const dialog = page.getByRole('alertdialog')
    const confirmation = dialog.getByRole('textbox', { name: /Type Failed diagnostic to confirm/ })
    const deleteButton = dialog.getByRole('button', { name: 'Delete run' })
    await expect(confirmation).toBeFocused()
    await captureEvaluationSurface(page, 'delete-dialog')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(dialog).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectDialogBottomReachable(page, dialog)
    await captureEvaluationSurface(page, 'delete-dialog-mobile')
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
    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.live}`)

    await expect.poll(state.getEventStreamCount).toBe(1)
    await expect(page.getByText('Executing routing track from SSE')).toHaveCount(1)
    await captureEvaluationSurface(page, 'runs-desktop')
    await page.getByRole('button', { name: 'Refresh evaluation runs' }).click()
    await page.waitForTimeout(250)

    expect(state.getEventStreamCount()).toBe(1)
    await expect(page.getByText('Executing routing track from SSE')).toHaveCount(1)
  })

  test('requires an explicit retry after a server-closed event stream', async ({ page }) => {
    const state = await mockEvaluationPlane(page, defaultEvaluationRuns, {
      eventStreamCloseOnce: true,
    })
    await page.goto(`/evaluation?view=runs&run=${EVALUATION_RUN_IDS.live}`)

    await expect.poll(state.getEventStreamCount).toBe(1)
    await expect(page.getByText('Stream unavailable', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Reconnect stream' }).click()
    await expect.poll(state.getEventStreamCount).toBe(2)
    await expect(page.getByText('Executing routing track from SSE')).toHaveCount(1)
    await expect(
      page.getByText('Evaluation event stream was closed by the server.', { exact: true }),
    ).toHaveCount(0)
  })

  const responsiveViewports = [
    { name: 'mobile-compact', width: 320, height: 568 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'desktop', width: 1440, height: 900 },
  ] as const

  for (const viewport of responsiveViewports) {
    for (const surface of responsiveEvaluationSurfaces) {
      test(`keeps ${surface.capture} coherent at ${viewport.name} width`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await mockEvaluationPlane(page)
        await expectResponsiveEvaluationSurface(page, surface, viewport.name)
      })
    }
  }
})
