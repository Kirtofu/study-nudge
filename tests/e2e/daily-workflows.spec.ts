import { expect, test, type Page } from '@playwright/test'

async function ready(page: Page) {
  await page.setViewportSize({ width: 1180, height: 760 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
}
async function add(page: Page, title: string) {
  const input = page.getByRole('textbox', { name: '快速添加任务' })
  await input.fill(title)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
}
async function seed(
  page: Page,
  items: Array<{ title: string; scheduledFor?: string; notes?: string }>
) {
  await page.evaluate(async (tasks) => {
    const path = '/src/bridge.ts'
    const { api } = await import(/* @vite-ignore */ path)
    for (const task of tasks) await api.tasks.create(task)
  }, items)
}

test('consecutive entry, autosave, date clearing and global completed search', async ({ page }) => {
  await ready(page)
  await add(page, '第一件 #学习 !高')
  await add(page, '第二件')
  await page.getByRole('button', { name: '打开“第一件”详情' }).click()
  await page
    .getByRole('textbox', { name: '备注', exact: true })
    .fill('查找这个备注 WebDAV\n保留第二行')
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()
  await page.getByLabel('计划日期', { exact: true }).fill('')
  await page.getByRole('button', { name: '关闭任务详情' }).click()
  await expect(page.getByRole('button', { name: '打开“第一件”详情' })).toHaveCount(0)
  await page.keyboard.press('Control+f')
  await page.getByRole('combobox', { name: '搜索全部任务或命令' }).fill('webdav')
  await page.getByRole('combobox', { name: '搜索全部任务或命令' }).press('Enter')
  await expect(page.getByRole('textbox', { name: '任务标题' })).toHaveValue('第一件')
  await expect(page.getByRole('textbox', { name: '备注', exact: true })).toHaveValue(
    '查找这个备注 WebDAV\n保留第二行'
  )
  await page.getByRole('button', { name: '完成任务', exact: true }).click()
  await page.getByRole('button', { name: '关闭任务详情' }).click()
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: '搜索全部任务或命令' }).fill('学习')
  await expect(page.getByRole('option').filter({ hasText: '第一件' })).toContainText('已完成')
})

test('earlier unfinished plans remain visible in their own group', async ({ page }) => {
  await ready(page)
  await seed(page, [{ title: '之前的安排', scheduledFor: '2020-04-03' }])
  const group = page.getByRole('region', { name: '此前未完成' })
  await expect(group.getByRole('button', { name: '打开“之前的安排”详情' })).toBeVisible()
  await expect(group).toContainText('原计划 2020-04-03')
  await page.reload()
  await expect(group).toContainText('之前的安排')
})

test('failed autosave keeps the draft, retry, scroll area and delete action usable', async ({
  page
}) => {
  await ready(page)
  await page.getByRole('button', { name: '打开“把第一件事记下来”详情' }).click()
  const title = page.getByRole('textbox', { name: '任务标题' })
  await title.fill('')
  await title.blur()
  const drawer = page.getByRole('complementary', { name: '任务详情' })
  await expect(drawer.getByRole('button', { name: '重试保存' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '删除任务' })).toBeVisible()
  const scroll = await drawer.locator('.drawer-scroll').boundingBox()
  expect(scroll?.height).toBeGreaterThan(300)
  await drawer.getByRole('button', { name: '重试保存' }).click()
  await title.fill('修正后的标题')
  await expect(drawer.getByRole('status')).toHaveText('已保存')
  await page.reload()
  await expect(page.getByRole('button', { name: '打开“修正后的标题”详情' })).toBeVisible()
})

test('separate undo opportunities survive rapid completion and deletion', async ({ page }) => {
  await ready(page)
  await add(page, '可撤销甲')
  await add(page, '可撤销乙')
  await page.getByRole('button', { name: '完成“可撤销甲”' }).click()
  await page.getByRole('button', { name: '“可撤销乙”更多操作' }).click()
  await page
    .getByRole('dialog', { name: '“可撤销乙”任务操作' })
    .getByRole('button', { name: '删除任务' })
    .click()
  await page
    .locator('.toast')
    .filter({ hasText: '可撤销甲' })
    .getByRole('button', { name: '撤销' })
    .click()
  await page
    .locator('.toast')
    .filter({ hasText: '可撤销乙' })
    .getByRole('button', { name: '撤销' })
    .click()
  await expect(page.getByRole('button', { name: '打开“可撤销甲”详情' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开“可撤销乙”详情' })).toBeVisible()
})

test('keyboard reorder persists after editing and reloading', async ({ page }) => {
  await ready(page)
  const rows = page.locator('.task-row')
  const before = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-task-id'))
  )
  const handle = page.getByRole('button', { name: '拖动“把第一件事记下来”调整顺序' })
  await handle.focus()
  await page.keyboard.press('Space')
  await expect(rows.first()).toHaveClass(/is-dragging/)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('status')).toContainText('demo-2')
  await page.keyboard.press('Space')
  await expect
    .poll(() =>
      rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-task-id'))
      )
    )
    .toEqual([before[1], before[0], before[2]])
  await page.getByRole('button', { name: '打开“把第一件事记下来”详情' }).click()
  await page.getByRole('textbox', { name: '任务标题' }).fill('拖拽后编辑')
  await page.getByRole('button', { name: '关闭任务详情' }).click()
  await page.reload()
  await expect(rows.nth(1)).toContainText('拖拽后编辑')
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-task-id'))
    )
  ).toEqual([before[1], before[0], before[2]])
})

test('learning workspace restores list position and changes to keyboard tabs on a phone', async ({
  page
}) => {
  await ready(page)
  const today = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  await seed(
    page,
    Array.from({ length: 18 }, (_, index) => ({ title: `学习记录 ${index}`, scheduledFor: today }))
  )
  await page
    .getByRole('button', { name: '打开“学习记录 10”学习包', exact: true })
    .scrollIntoViewIfNeeded()
  const top = await page.locator('.task-scroll-region').evaluate((element) => element.scrollTop)
  await page.getByRole('button', { name: '打开“学习记录 10”学习包', exact: true }).click()
  const workspace = page.getByRole('region', { name: '“学习记录 10”学习工作区' })
  await expect(workspace.getByRole('heading', { name: '资料与工具' })).toBeVisible()
  const desktopCanvas = await workspace.locator('.roadmap-canvas').boundingBox()
  expect(desktopCanvas?.height).toBeGreaterThan(180)
  await expect
    .poll(() =>
      workspace
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a)
    )
    .toBeGreaterThanOrEqual(1)
  await expect(page.getByRole('textbox', { name: '快速添加任务' })).toBeHidden()
  await page.getByRole('button', { name: '返回任务列表' }).click()
  await expect
    .poll(() => page.locator('.task-scroll-region').evaluate((element) => element.scrollTop))
    .toBe(top)
  await page.getByRole('button', { name: '打开“学习记录 10”学习包', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: '精选视频' }).click()
  await expect(page.getByRole('heading', { name: '精选视频' })).toBeVisible()
  await page.getByRole('tab', { name: '精选视频' }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: '学习路线' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: '学习路线' })).toBeVisible()
  const mobileCanvas = await workspace.locator('.roadmap-canvas').boundingBox()
  expect(mobileCanvas?.height).toBeGreaterThan(180)
  await page.getByRole('button', { name: '返回任务列表' }).click()
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await expect(page.getByRole('tab', { name: '同步' })).toBeVisible()
})

test('focus uses configured duration, preserves duplicate starts and confirms a switch', async ({
  page
}) => {
  await page.clock.install({ time: new Date('2026-09-13T10:00:00+08:00') })
  await ready(page)
  await page.evaluate(async () => {
    const path = '/src/bridge.ts'
    const { api } = await import(/* @vite-ignore */ path)
    await api.settings.update({ pomodoroFocusMinutes: 40 })
  })
  await expect(page.getByRole('button', { name: '40 分钟专注', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '专注于“把第一件事记下来”' }).click()
  await page.clock.fastForward(10_000)
  await page.getByRole('button', { name: '专注于“把第一件事记下来”' }).click()
  await expect(page.locator('.focus-time')).toHaveText('39:50')
  await page.getByRole('button', { name: '暂停计时' }).click()
  await page.clock.fastForward(30_000)
  await expect(page.locator('.focus-time')).toHaveText('39:50')
  await page.getByRole('button', { name: '继续计时' }).click()
  await page.clock.fastForward(10_000)
  await page.getByRole('button', { name: '专注于“用学习包规划 React 性能优化”' }).click()
  await page.getByRole('button', { name: '继续当前专注' }).click()
  await expect(page.locator('.focus-active-copy')).toContainText('把第一件事记下来')
  await page.getByRole('button', { name: '专注于“用学习包规划 React 性能优化”' }).click()
  await page.getByRole('button', { name: '保存并切换' }).click()
  await page.clock.fastForward(10_000)
  await page.getByRole('button', { name: '结束计时' }).click()
  const durations = await page.evaluate(async () => {
    const path = '/src/bridge.ts'
    const { api } = await import(/* @vite-ignore */ path)
    return (await api.focus.getStats()).sessions.map(
      (session: { durationSeconds: number }) => session.durationSeconds
    )
  })
  expect(durations).toEqual([10, 20])
})
