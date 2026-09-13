// Runs a built/installed app with isolated SQLite, WebView2 and session secrets.
// No real user database or credentials are read. Close Nudge before running.
// Usage: node scripts/smoke-windows.cjs <absolute path to nudge.exe>
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const repository = path.resolve(__dirname, '..')
const executable = path.resolve(process.argv[2] || path.join(repository, 'src-tauri/target/release/nudge.exe'))
const root = path.join(repository, 'src-tauri', 'target', `native-smoke-${Date.now()}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { executable, root, checks: [], pageErrors: [] }
let app
let server
let remoteBody
let remoteRevision = 0

async function until(read, accepts, timeout = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const value = await read()
      if (accepts(value)) return value
    } catch {}
    await sleep(150)
  }
  throw new Error(`Condition did not become true within ${timeout} ms`)
}
async function freePort() {
  const socket = net.createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
async function launch(profile) {
  const data = path.join(root, profile)
  fs.mkdirSync(data, { recursive: true })
  const port = await freePort()
  const child = spawn(executable, ['--hidden'], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NUDGE_TEST_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    }
  })
  app = { child, data }
  const address = `http://127.0.0.1:${port}`
  await until(() => fetch(`${address}/json/version`).then((response) => response.json()), (value) => Boolean(value.webSocketDebuggerUrl))
  app.browser = await chromium.connectOverCDP(address)
  await until(async () => {
    for (const page of app.browser.contexts().flatMap((context) => context.pages())) {
      const label = await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata.currentWindow.label)
      if (label === 'main') app.main = page
      if (label === 'focus') app.mini = page
    }
    return Boolean(app.main && app.mini)
  }, Boolean)
  for (const page of [app.main, app.mini]) {
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => report.pageErrors.push(error.message))
  }
  const snapshot = await invoke('app_bootstrap')
  assert.equal(snapshot.secretStore.backend, 'isolated-test-session')
  await invoke('desktop_show_main')
  await expect(app.main.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  return snapshot
}
async function stop() {
  if (!app) return
  if (app.browser) await app.browser.close().catch(() => undefined)
  const child = app.child
  if (child.exitCode === null) {
    child.kill()
    await until(() => child.exitCode !== null || child.signalCode !== null, Boolean, 10_000)
  }
  app = null
}
async function invoke(command, args, page = app.main) {
  return page.evaluate(([name, values]) => window.__TAURI_INTERNALS__.invoke(name, values), [command, args])
}
function pass(name) {
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
async function configureSync() {
  await invoke('sync_configure', { input: {
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    username: 'nudge-test', password: 'test-password', passphrase: 'isolated-smoke-passphrase',
    remotePath: 'nudge.enc', rememberPassphrase: false, deviceName: path.basename(app.data)
  } })
}
async function startWebDav() {
  server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from('nudge-test:test-password').toString('base64')}`) {
      response.writeHead(401).end(); return
    }
    const etag = `"${remoteRevision}"`
    if (request.method === 'OPTIONS') { response.writeHead(200, { DAV: '1, 2' }).end(); return }
    if (request.method === 'GET') {
      response.writeHead(remoteBody ? 200 : 404, { ETag: etag }).end(remoteBody); return
    }
    if (request.method === 'PUT') {
      if ((request.headers['if-match'] && request.headers['if-match'] !== etag) ||
          (request.headers['if-none-match'] === '*' && remoteBody)) {
        response.writeHead(412).end(); return
      }
      const chunks = []
      request.on('data', (data) => chunks.push(data))
      request.on('end', () => {
        remoteBody = Buffer.concat(chunks)
        remoteRevision += 1
        response.writeHead(201, { ETag: `"${remoteRevision}"` }).end()
      })
      return
    }
    response.writeHead(405).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke test requires Windows and WebView2')
  assert.ok(fs.existsSync(executable), 'Build or install the Windows app first')
  const running = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '(Get-Process -Name nudge -ErrorAction SilentlyContinue | Measure-Object).Count'], { windowsHide: true, encoding: 'utf8' }).trim()
  assert.equal(running, '0', 'Close all existing Nudge windows/tray processes first')
  fs.mkdirSync(root, { recursive: true })
  await startWebDav()
  await launch('first-device')
  assert.equal((await invoke('tasks_list')).length, 0)
  pass('installed executable starts with an empty isolated database')

  const input = app.main.getByRole('textbox', { name: '快速添加任务' })
  for (const title of ['本机记录甲 #回归', '本机记录乙']) {
    await input.fill(title)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
  }
  const [a, b] = await invoke('tasks_list')
  assert.equal(a.title, '本机记录甲')
  assert.equal(b.title, '本机记录乙')
  await invoke('tasks_create', { input: { title: '之前安排的任务', scheduledFor: '2020-01-02' } })
  await expect(app.main.getByRole('region', { name: '此前未完成' })).toContainText('原计划 2020-01-02')
  await invoke('tasks_reorder', { ids: [b.id, a.id] })
  await invoke('tasks_update', { id: a.id, input: { notes: '第一行\n第二行 Vec<T>' } })
  await invoke('tasks_complete', { id: b.id, completed: true })
  await invoke('tasks_complete', { id: b.id, completed: false })
  await invoke('tasks_delete', { id: b.id })
  await invoke('tasks_restore', { id: b.id })
  assert.deepEqual((await invoke('tasks_list')).slice(0, 2).map((task) => task.id), [b.id, a.id])
  pass('native quick add, carried plans, task mutations and scoped order')

  await invoke('settings_update', { input: { pomodoroFocusMinutes: 35 } })
  await expect(app.main.getByRole('button', { name: '35 分钟专注', exact: true })).toBeVisible()
  await expect(app.mini.getByRole('button', { name: '开始 35 分钟' })).toBeVisible()
  await invoke('desktop_toggle_mini_window')
  const first = await invoke('focus_start', { mode: 'stopwatch', taskId: a.id })
  await sleep(1200)
  const duplicate = await invoke('focus_start', { mode: 'stopwatch', taskId: a.id })
  assert.equal(duplicate.startedAt, first.startedAt)
  await invoke('focus_pause')
  await expect(app.mini.getByRole('button', { name: '继续', exact: true })).toBeVisible()
  const paused = await invoke('focus_get_state')
  await sleep(1000)
  assert.equal((await invoke('focus_get_state')).accumulatedSeconds, paused.accumulatedSeconds)
  await app.mini.getByRole('button', { name: '继续', exact: true }).click()
  await expect(app.main.getByRole('button', { name: '暂停计时' })).toBeVisible()
  await app.main.getByRole('button', { name: '专注于“本机记录乙”' }).click()
  await app.main.getByRole('button', { name: '继续当前专注' }).click()
  assert.equal((await invoke('focus_get_state')).taskId, a.id)
  await app.main.getByRole('button', { name: '专注于“本机记录乙”' }).click()
  await app.main.getByRole('button', { name: '保存并切换' }).click()
  await expect(app.mini.locator('.mini-running p')).toHaveText('本机记录乙')
  await sleep(1200)
  await app.mini.getByRole('button', { name: '结束', exact: true }).click()
  await until(() => invoke('focus_get_state'), (state) => state.status === 'idle')
  const sessions = (await invoke('focus_get_stats')).sessions
  assert.equal(sessions.length, 2)
  await invoke('focus_stop')
  assert.equal((await invoke('focus_get_stats')).sessions.length, 2)
  assert.equal(new Set(sessions.map((session) => session.id)).size, 2)
  pass('main/mini settings and focus events, pause/resume, duplicate start and atomic switch')

  await invoke('focus_start', { mode: 'stopwatch', taskId: a.id })
  await sleep(1100)
  await invoke('focus_pause')
  const backupPath = path.join(root, 'backup.json')
  await invoke('backup_export', { path: backupPath })
  await invoke('focus_stop')
  await invoke('tasks_delete', { id: b.id })
  await invoke('backup_import', { path: backupPath, mode: 'replace' })
  await expect(app.main.getByRole('button', { name: '打开“本机记录乙”详情' })).toBeVisible()
  await expect(app.mini.getByRole('button', { name: '继续', exact: true })).toBeVisible()
  assert.equal((await invoke('focus_get_state')).status, 'paused')
  pass('JSON backup restore refreshes both windows and the live paused timer')

  const tray = await invoke('plugin:tray|get_by_id', { id: 'nudge' })
  assert.notEqual(tray, null)
  await invoke('desktop_close')
  await until(() => invoke('plugin:window|is_visible', { label: 'main' }), (value) => value === false)
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NudgeSmokeKeys {
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEY key; [FieldOffset(0)] public MOUSE mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int x; public int y; public uint data; public uint flags; public uint time; public UIntPtr extra; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] input, int size);
 public static uint Press() {
   var events = new INPUT[6]; ushort[] keys = {17,18,32,32,18,17};
   for (int i=0;i<6;i++) { events[i].type=1; events[i].data.key.vk=keys[i]; events[i].data.key.flags=i>=3?2u:0u; }
   return SendInput(6,events,Marshal.SizeOf(typeof(INPUT)));
 }
}
'@
    if ([NudgeSmokeKeys]::Press() -ne 6) { throw 'Windows did not accept the keyboard input sequence' }
  `], { windowsHide: true })
  await until(() => invoke('plugin:window|is_visible', { label: 'main' }), Boolean)
  await expect(input).toBeFocused()
  pass('tray exists, close-to-tray works, Ctrl+Alt+Space restores quick add')

  await invoke('notifications_prepare')
  const reminder = await invoke('tasks_create', { input: { title: 'Nudge 安装测试提醒', reminderAt: new Date(Date.now() - 1000).toISOString() } })
  await until(async () => {
    await invoke('backup_export', { path: path.join(root, 'reminder-check.json') })
    const data = JSON.parse(fs.readFileSync(path.join(root, 'reminder-check.json'), 'utf8'))
    return data.data.tasks.find((task) => task.id === reminder.task.id).notified_at
  }, Boolean, 35_000)
  pass('Windows notification delivery succeeds and is persisted')

  await configureSync()
  await invoke('sync_run')
  const envelope = JSON.parse(remoteBody.toString())
  assert.equal(envelope.version, 2)
  assert.equal(envelope.algorithm, 'argon2id+xchacha20poly1305')
  assert.ok(!remoteBody.toString().includes('本机记录甲'))
  pass('real native WebDAV upload keeps the existing encrypted envelope format')
  const savedOrder = (await invoke('tasks_list')).map((task) => task.id)
  await stop()

  await launch('second-device')
  await configureSync()
  await invoke('sync_run')
  await expect(app.main.getByRole('button', { name: '打开“本机记录甲”详情' })).toBeVisible()
  await invoke('tasks_update', { id: a.id, input: { title: '另一台设备更新的任务' } })
  await invoke('settings_update', { input: { pomodoroFocusMinutes: 45 } })
  await invoke('tasks_create', { input: { title: '来自远端的新安排', scheduledFor: new Date().toLocaleDateString('en-CA') } })
  await invoke('sync_run')
  await stop()

  await launch('first-device')
  assert.deepEqual((await invoke('tasks_list')).map((task) => task.id), savedOrder)
  assert.equal((await invoke('focus_get_state')).status, 'paused')
  assert.equal((await invoke('tasks_list')).find((task) => task.id === a.id).notes, '第一行\n第二行 Vec<T>')
  pass('relaunch preserves SQLite order, edited notes and paused focus')
  await configureSync()
  await invoke('sync_run')
  await expect(app.main.getByRole('button', { name: '打开“来自远端的新安排”详情' })).toBeVisible()
  await expect(app.mini.locator('.mini-running p')).toHaveText('另一台设备更新的任务')
  assert.equal((await invoke('settings_get')).pomodoroFocusMinutes, 45)
  pass('second-device encrypted sync updates task data, settings and mini window without reload')

  await invoke('focus_stop')
  await invoke('desktop_toggle_mini_window')
  await app.main.evaluate(() => document.fonts.ready)
  await app.main.screenshot({ path: path.join(root, 'windows-main.png'), animations: 'disabled' })
  report.sessions = (await invoke('focus_get_stats')).sessions.length
  assert.deepEqual(report.pageErrors, [])
  pass('native WebView2 has no uncaught page errors')
}

main().catch((error) => {
  report.error = error.stack
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await stop().catch((error) => console.error(error))
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Native evidence: ${root}`)
})
