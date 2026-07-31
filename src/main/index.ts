import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  type OpenDialogOptions,
  powerMonitor,
  type SaveDialogOptions,
  shell,
  Tray
} from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AppSettings, CreateTaskInput, UpdateTaskInput } from '../shared/types'
import { localDateKey, NudgeDatabase } from './database'
import { FocusService } from './focus-service'

const WINDOWS_APP_ID = 'io.github.kirtofu.nudge'
const WINDOWS_DEV_APP_ID = `${WINDOWS_APP_ID}.dev`

app.setName('Nudge')
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? WINDOWS_APP_ID : WINDOWS_DEV_APP_ID)
}

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let tray: Tray | null = null
let database: NudgeDatabase
let focusService: FocusService
let reminderTimer: NodeJS.Timeout | null = null
let isQuitting = false

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000).optional(),
  listId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  scheduledFor: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  reminderAt: z.string().nullable().optional(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  estimateMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
  tagNames: z.array(z.string().max(40)).max(8).optional()
})

const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['open', 'completed', 'deleted']).optional()
})

const settingsSchema = z.object({
  dailyGoalMinutes: z.number().int().min(1).max(1440).optional(),
  longTermGoalHours: z.number().min(1).max(100_000).optional(),
  longTermGoalLabel: z.string().trim().min(1).max(80).optional(),
  pomodoroFocusMinutes: z.number().int().min(1).max(180).optional(),
  pomodoroBreakMinutes: z.number().int().min(1).max(60).optional(),
  autoStart: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  globalShortcut: z.string().trim().min(1).max(80).optional()
})

function getIconPath(): string {
  const iconFilename = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return app.isPackaged
    ? join(process.resourcesPath, iconFilename)
    : join(app.getAppPath(), 'build', iconFilename)
}

function getIcon() {
  const iconPath = getIconPath()
  return existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
}

function loadRenderer(window: BrowserWindow, mini = false): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    window.loadURL(`${rendererUrl}${mini ? '?mini=1' : ''}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: mini ? { mini: '1' } : undefined
    })
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f4ed',
    icon: getIcon(),
    title: 'Nudge',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f4ed',
      symbolColor: '#141413',
      height: 42
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!isQuitting && database.getSettings().closeToTray) {
      event.preventDefault()
      window.hide()
      if (!database.getSetting('closeHintShown', false)) {
        showNotification('Nudge 仍在运行', '提醒和专注计时会继续工作，可从托盘再次打开。')
        database.setSetting('closeHintShown', true)
      }
    }
  })
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(window)
  return window
}

function createMiniWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 360,
    height: 190,
    minWidth: 360,
    minHeight: 190,
    maxWidth: 480,
    maxHeight: 260,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#faf9f5',
    icon: getIcon(),
    title: 'Nudge 专注',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#faf9f5',
      symbolColor: '#141413',
      height: 34
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    miniWindow = null
  })
  loadRenderer(window, true)
  return window
}

function showMainWindow(quickAdd = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (quickAdd) mainWindow.webContents.send('desktop:quick-add')
}

function toggleMiniWindow(): void {
  if (!miniWindow || miniWindow.isDestroyed()) {
    miniWindow = createMiniWindow()
    return
  }
  if (miniWindow.isVisible()) miniWindow.hide()
  else {
    miniWindow.show()
    miniWindow.focus()
  }
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notice = new Notification({ title, body, icon: getIcon(), silent: false })
  notice.on('click', () => showMainWindow())
  notice.show()
}

function createTray(): void {
  tray = new Tray(getIcon().resize({ width: 18, height: 18 }))
  tray.setToolTip('Nudge · 待办与专注')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Nudge', click: () => showMainWindow() },
      { label: '快速添加任务', accelerator: 'Ctrl+Alt+Space', click: () => showMainWindow(true) },
      { label: '专注迷你窗', click: () => toggleMiniWindow() },
      { type: 'separator' },
      {
        label: '退出 Nudge',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => showMainWindow())
}

function registerQuickAddShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  try {
    return globalShortcut.register(accelerator, () => showMainWindow(true))
  } catch {
    return false
  }
}

function applyDesktopSettings(settings: AppSettings): boolean {
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, openAsHidden: true })
  return registerQuickAddShortcut(settings.globalShortcut)
}

function checkReminders(): void {
  for (const task of database.getDueReminders()) {
    showNotification(task.title, task.notes || '这是你之前设置的任务提醒。')
    database.markReminderNotified(task.id)
  }
}

function backupDirectory(): string {
  return join(app.getPath('userData'), 'backups')
}

function createDatabaseBackup(force = false): string | null {
  const today = localDateKey()
  if (!force && database.getSetting('lastBackupDate', '') === today) return null
  database.checkpoint()
  const directory = backupDirectory()
  mkdirSync(directory, { recursive: true })
  const filePath = join(directory, `nudge-${today}-${Date.now()}.db`)
  copyFileSync(database.path, filePath)
  const backups = readdirSync(directory)
    .filter((file) => /^nudge-.*\.db$/.test(file))
    .sort()
    .reverse()
  for (const file of backups.slice(7)) unlinkSync(join(directory, file))
  database.setSetting('lastBackupDate', today)
  return filePath
}

function registerIpc(): void {
  ipcMain.handle('tasks:list', () => database.listTasks())
  ipcMain.handle('tasks:create', (_event, raw: unknown) => {
    const input = createTaskSchema.parse(raw) as CreateTaskInput
    return database.createTask(input)
  })
  ipcMain.handle('tasks:update', (_event, id: string, raw: unknown) => {
    const input = updateTaskSchema.parse(raw) as UpdateTaskInput
    return database.updateTask(z.string().parse(id), input)
  })
  ipcMain.handle('tasks:complete', (_event, id: string, completed: boolean) =>
    database.completeTask(z.string().parse(id), z.boolean().parse(completed))
  )
  ipcMain.handle('tasks:delete', (_event, id: string) => database.deleteTask(z.string().parse(id)))
  ipcMain.handle('tasks:restore', (_event, id: string) => database.restoreTask(z.string().parse(id)))
  ipcMain.handle('tasks:reorder', (_event, ids: string[]) =>
    database.reorderTasks(z.array(z.string()).parse(ids))
  )

  ipcMain.handle('lists:list', () => database.listLists())
  ipcMain.handle('lists:create', (_event, name: string) => database.createList(z.string().parse(name)))
  ipcMain.handle('lists:update', (_event, id: string, raw: unknown) => {
    const input = z.object({ name: z.string().optional(), color: z.string().optional() }).parse(raw)
    return database.updateList(z.string().parse(id), input)
  })
  ipcMain.handle('lists:delete', (_event, id: string) => database.deleteList(z.string().parse(id)))
  ipcMain.handle('tags:list', () => database.listTags())

  ipcMain.handle('focus:get-state', () => focusService.getState())
  ipcMain.handle('focus:get-stats', () => database.getFocusStats())
  ipcMain.handle('focus:start', (_event, raw: unknown) => {
    const input = z
      .object({ mode: z.enum(['pomodoro', 'stopwatch']), taskId: z.string().nullable().optional() })
      .parse(raw)
    return focusService.start(input)
  })
  ipcMain.handle('focus:pause', () => focusService.pause())
  ipcMain.handle('focus:resume', () => focusService.resume())
  ipcMain.handle('focus:stop', () => focusService.stop())
  ipcMain.handle('focus:skip', () => focusService.skip())

  ipcMain.handle('settings:get', () => database.getSettings())
  ipcMain.handle('settings:update', (_event, raw: unknown) => {
    const input = settingsSchema.parse(raw)
    const previous = database.getSettings()
    const settings = database.updateSettings(input)
    if (!applyDesktopSettings(settings)) {
      database.updateSettings(previous)
      applyDesktopSettings(previous)
      throw new Error(`快捷键“${settings.globalShortcut}”不可用，请换一个组合。`)
    }
    return settings
  })

  ipcMain.handle('backup:export', async () => {
    const options: SaveDialogOptions = {
      title: '导出 Nudge 备份',
      defaultPath: `nudge-backup-${localDateKey()}.json`,
      filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
    }
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    writeFileSync(result.filePath, JSON.stringify(database.exportData(), null, 2), 'utf8')
    return { canceled: false, path: result.filePath }
  })

  ipcMain.handle('backup:import', async (_event, mode: 'merge' | 'replace') => {
    const parsedMode = z.enum(['merge', 'replace']).parse(mode)
    const options: OpenDialogOptions = {
      title: parsedMode === 'replace' ? '恢复 Nudge 备份' : '导入 Nudge 数据',
      properties: ['openFile'],
      filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    createDatabaseBackup(true)
    const payload = JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as Record<string, unknown>
    const imported = database.importData(payload, parsedMode)
    return { canceled: false, path: result.filePaths[0], imported }
  })

  ipcMain.handle('desktop:toggle-mini', () => toggleMiniWindow())
  ipcMain.handle('desktop:show-main', () => showMainWindow())
}

async function bootstrap(): Promise<void> {
  const lock = app.requestSingleInstanceLock()
  if (!lock) {
    app.quit()
    return
  }

  app.on('second-instance', () => showMainWindow())
  await app.whenReady()
  Menu.setApplicationMenu(null)

  const legacyPaths = Array.from(
    new Set(
      [
        process.env.NUDGE_LEGACY_DATA_PATH,
        join(app.getAppPath(), 'data.json'),
        join(dirname(process.execPath), 'data.json'),
        join(process.resourcesPath, 'legacy', 'data.json'),
        'D:\\项目\\study-nudge\\data.json'
      ].filter((candidate): candidate is string => Boolean(candidate))
    )
  )
  database = new NudgeDatabase(join(app.getPath('userData'), 'nudge.db'), legacyPaths)
  focusService = new FocusService(database, showNotification)
  focusService.onChange((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('focus:changed', state)
    }
  })

  registerIpc()
  createTray()
  const settings = database.getSettings()
  if (!applyDesktopSettings(settings)) {
    showNotification('全局快捷键没有启用', `“${settings.globalShortcut}”已被占用或格式无效，可在设置中更换。`)
  }
  createDatabaseBackup()
  checkReminders()
  reminderTimer = setInterval(checkReminders, 30_000)
  powerMonitor.on('resume', checkReminders)

  mainWindow = createMainWindow()
}

app.on('before-quit', () => {
  isQuitting = true
  if (reminderTimer) clearInterval(reminderTimer)
  globalShortcut.unregisterAll()
  focusService?.dispose()
  database?.checkpoint()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !database?.getSettings().closeToTray) app.quit()
})

app.on('activate', () => showMainWindow())

void bootstrap()
