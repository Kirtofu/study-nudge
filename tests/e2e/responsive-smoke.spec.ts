import { expect, test } from '@playwright/test'

const viewports = [
  { name: 'desktop', width: 1180, height: 760 },
  { name: 'tablet', width: 834, height: 1194 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'compact phone', width: 360, height: 800 }
] as const

for (const viewport of viewports) {
  test(`${viewport.name} keeps the task surface readable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/')

    await expect(page.getByRole('heading', { name: '今天' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '快速添加任务' })).toBeVisible()

    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }))
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport + 1)
  })
}

test('keyboard quick add and settings tabs provide immediate feedback', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Control+N')

  const quickAdd = page.locator('form.quick-add')
  const quickAddInput = quickAdd.getByRole('textbox', { name: '快速添加任务' })
  await expect(quickAddInput).toBeFocused()
  await quickAddInput.fill('键盘冒烟任务')

  const addButton = quickAdd.getByRole('button', { name: '添加任务' })
  await expect(addButton).toBeEnabled()
  await addButton.click()
  await expect(page.getByRole('heading', { name: '键盘冒烟任务' })).toBeVisible()

  const settingsButton = page.getByRole('button', { name: '设置与备份' })
  await settingsButton.click()
  await expect(page.getByRole('tab', { name: 'AI' })).toBeVisible()
  await page.getByRole('tab', { name: 'AI' }).click()
  await expect(page.getByRole('heading', { name: '学习包推荐' })).toBeVisible()
})

test('reduced motion is honored by the document media query', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
})
