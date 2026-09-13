import type { AppSettings, RecommendationProvider, TaskList } from '@shared/types'
import {
  ArchiveRestore,
  BellRing,
  Bot,
  Clock3,
  Cloud,
  CloudOff,
  Download,
  FileText,
  Keyboard,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  PlayCircle,
  Power,
  RefreshCw,
  Save,
  Target,
  TestTube2,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useState } from 'react'
import { api } from '../bridge'
import { useRetainedForm } from '../state/use-retained-form'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

type SettingsTab = 'general' | 'ai' | 'sync' | 'data'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'ai', label: 'AI' },
  { id: 'sync', label: '同步' },
  { id: 'data', label: '数据' }
]

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

function EditableList({ list }: { list: TaskList }): React.JSX.Element {
  const updateList = useNudgeStore((state) => state.updateList)
  const deleteList = useNudgeStore((state) => state.deleteList)
  const [draftName, setDraftName] = useRetainedForm({ name: list.name })
  const name = draftName.name
  const setName = (value: string): void => setDraftName({ name: value })
  const showToast = useToast()

  return (
    <div className="settings-list-row">
      <span className="list-color" style={{ backgroundColor: list.color }} aria-hidden="true" />
      <label className="sr-only" htmlFor={`settings-list-${list.id}`}>
        清单名称
      </label>
      <input
        id={`settings-list-${list.id}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const clean = name.trim()
          if (clean && clean !== list.name)
            void updateList(list.id, { name: clean }).catch((error) =>
              showToast({ tone: 'error', message: '清单名称没有保存', detail: String(error) })
            )
          else setName(list.name)
        }}
      />
      <button
        type="button"
        className="icon-button danger-icon"
        aria-label={`删除“${list.name}”清单`}
        onClick={() => {
          if (!window.confirm(`删除“${list.name}”清单？其中的任务会移到收集箱。`)) return
          void deleteList(list.id)
            .then(() => showToast({ message: '清单已删除', detail: '其中的任务已移到收集箱' }))
            .catch((error) =>
              showToast({ tone: 'error', message: '清单没有删除', detail: String(error) })
            )
        }}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

export function SettingsDrawer(): React.JSX.Element | null {
  const settings = useNudgeStore((state) => state.settings)
  const lists = useNudgeStore((state) => state.lists)
  const closeDrawer = useNudgeStore((state) => state.closeDrawer)
  const updateSettings = useNudgeStore((state) => state.updateSettings)
  const refreshTasks = useNudgeStore((state) => state.refreshTasks)
  const refreshStats = useNudgeStore((state) => state.refreshStats)
  const refreshData = useNudgeStore((state) => state.refreshData)
  const recommendationSettings = useNudgeStore((state) => state.recommendationSettings)
  const syncSettings = useNudgeStore((state) => state.syncSettings)
  const syncState = useNudgeStore((state) => state.syncState)
  const syncConflicts = useNudgeStore((state) => state.syncConflicts)
  const secretStore = useNudgeStore((state) => state.secretStore)
  const updateRecommendationSettings = useNudgeStore((state) => state.updateRecommendationSettings)
  const configureSync = useNudgeStore((state) => state.configureSync)
  const runSync = useNudgeStore((state) => state.runSync)
  const disconnectSync = useNudgeStore((state) => state.disconnectSync)
  const refreshSync = useNudgeStore((state) => state.refreshSync)
  const [saving, setSaving] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [testingSync, setTestingSync] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [aiDraft, setAiDraft] = useRetainedForm({
    provider: recommendationSettings?.provider ?? ('offline' as RecommendationProvider),
    endpoint: recommendationSettings?.endpoint ?? 'https://api.openai.com/v1',
    model: recommendationSettings?.model ?? 'gpt-4.1-mini',
    networkEnabled: recommendationSettings?.networkEnabled ?? false,
    sendNotes: recommendationSettings?.sendNotes ?? false,
    apiKey: ''
  })
  const [syncDraft, setSyncDraft] = useRetainedForm({
    serverUrl: syncSettings?.serverUrl ?? '',
    username: syncSettings?.username ?? '',
    password: '',
    passphrase: '',
    remotePath: syncSettings?.remotePath ?? 'Nudge/nudge-v2.enc',
    rememberPassphrase: syncSettings?.rememberPassphrase ?? false,
    deviceName: syncSettings?.deviceName ?? ''
  })
  const showToast = useToast()

  if (!settings) return null

  const update = async (input: Partial<AppSettings>): Promise<void> => {
    setSaving(true)
    try {
      await updateSettings(input)
    } catch (error) {
      showToast({
        message: '设置没有保存',
        detail: error instanceof Error ? error.message : '请稍后重试'
      })
    } finally {
      setSaving(false)
    }
  }

  const importBackup = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (
      mode === 'replace' &&
      !window.confirm('覆盖恢复会替换当前数据。Nudge 会先自动备份，仍要继续吗？')
    )
      return
    try {
      const result = await api.backup.importJson(mode)
      if (result.canceled) return
      await refreshData()
      showToast({
        message: mode === 'replace' ? '备份已经恢复' : '数据已经导入',
        detail: `处理了 ${result.imported ?? 0} 条记录`
      })
    } catch (error) {
      showToast({
        message: '备份没有导入成功',
        detail: error instanceof Error ? error.message : '请检查文件格式'
      })
    }
  }

  return (
    <aside className="detail-drawer settings-drawer" aria-label="设置与备份">
      <div className="drawer-header">
        <div className="save-state">
          {saving ? (
            <>
              <Save size={13} aria-hidden="true" />
              正在保存
            </>
          ) : (
            <span>设置与备份</span>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="关闭设置" onClick={closeDrawer}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="drawer-scroll">
        <section className="settings-section" hidden={activeTab !== 'general'}>
          <div className="settings-section-title">
            <Target size={17} aria-hidden="true" />
            <div>
              <h2>专注目标</h2>
              <p>把原 study-nudge 的 2 小时 / 350 小时目标保留下来。</p>
            </div>
          </div>
          <label className="settings-field">
            <span>每日目标</span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="1440"
                defaultValue={settings.dailyGoalMinutes}
                onBlur={(event) => void update({ dailyGoalMinutes: Number(event.target.value) })}
              />
              <small>分钟</small>
            </span>
          </label>
          <label className="settings-field">
            <span>长期目标名称</span>
            <input
              type="text"
              defaultValue={settings.longTermGoalLabel}
              onBlur={(event) => void update({ longTermGoalLabel: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>长期目标</span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="100000"
                defaultValue={settings.longTermGoalHours}
                onBlur={(event) => void update({ longTermGoalHours: Number(event.target.value) })}
              />
              <small>小时</small>
            </span>
          </label>
        </section>

        <section className="settings-section" hidden={activeTab !== 'ai'}>
          <div className="settings-section-title">
            <Bot size={17} aria-hidden="true" />
            <div>
              <h2>学习包推荐</h2>
              <p>默认离线生成模板；只有你主动点击生成时才会联网。</p>
            </div>
          </div>
          <div
            className={`secret-store-status ${secretStore?.available ? 'is-ready' : 'is-session'}`}
            role="status"
          >
            <LockKeyhole size={14} aria-hidden="true" />
            <span>
              {secretStore?.available
                ? `密钥由${secretStore.backend || '系统密钥库'}保护`
                : '系统密钥库不可用，秘密只在本次会话中保留'}
            </span>
          </div>
          <label className="settings-field">
            <span>推荐方式</span>
            <select
              value={aiDraft.provider}
              onChange={(event) =>
                setAiDraft({ ...aiDraft, provider: event.target.value as RecommendationProvider })
              }
            >
              <option value="offline">离线模板</option>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="ollama">Ollama 本机模型</option>
            </select>
          </label>
          {aiDraft.provider !== 'offline' ? (
            <>
              <label className="settings-field">
                <span>服务地址</span>
                <input
                  value={aiDraft.endpoint}
                  onChange={(event) => setAiDraft({ ...aiDraft, endpoint: event.target.value })}
                  placeholder={
                    aiDraft.provider === 'ollama'
                      ? 'http://localhost:11434'
                      : 'https://api.example.com/v1'
                  }
                />
              </label>
              <label className="settings-field">
                <span>模型</span>
                <input
                  value={aiDraft.model}
                  onChange={(event) => setAiDraft({ ...aiDraft, model: event.target.value })}
                />
              </label>
              {aiDraft.provider === 'openai-compatible' ? (
                <label className="settings-field">
                  <span>API 密钥</span>
                  <input
                    type="password"
                    value={aiDraft.apiKey}
                    onChange={(event) => setAiDraft({ ...aiDraft, apiKey: event.target.value })}
                    placeholder={
                      recommendationSettings?.hasApiKey
                        ? '已安全保存；留空则保持不变'
                        : '只保存到系统密钥库'
                    }
                    autoComplete="off"
                  />
                </label>
              ) : null}
              <div className="settings-toggle-row">
                <span>
                  <Cloud size={15} />
                  允许联网推荐
                </span>
                <Toggle
                  checked={aiDraft.networkEnabled}
                  label="允许联网推荐"
                  onChange={(networkEnabled) => setAiDraft({ ...aiDraft, networkEnabled })}
                />
              </div>
              <div className="settings-toggle-row">
                <span>
                  <FileText size={15} />
                  允许发送任务备注
                </span>
                <Toggle
                  checked={aiDraft.sendNotes}
                  label="允许发送任务备注"
                  onChange={(sendNotes) => setAiDraft({ ...aiDraft, sendNotes })}
                />
              </div>
              <p className="settings-privacy-note">
                生成前仍会逐次确认发送范围。API 密钥不写入数据库、日志、备份或同步文件。
              </p>
            </>
          ) : (
            <p className="settings-privacy-note">
              离线模板会即时创建资料搜索入口、视频搜索入口与五阶段学习路线。
            </p>
          )}
          <div className="settings-inline-actions">
            {aiDraft.provider !== 'offline' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={testingAi}
                onClick={() => {
                  setTestingAi(true)
                  void api.recommendation
                    .testConnection(aiDraft)
                    .then((result) => showToast({ message: result.message }))
                    .catch((error) =>
                      showToast({
                        message: '连接测试失败',
                        detail: error instanceof Error ? error.message : '请检查配置'
                      })
                    )
                    .finally(() => setTestingAi(false))
                }}
              >
                <TestTube2 size={14} />
                {testingAi ? '测试中…' : '测试连接'}
              </button>
            ) : null}
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setSaving(true)
                void updateRecommendationSettings(aiDraft)
                  .then(() => {
                    setAiDraft({ ...aiDraft, apiKey: '' })
                    showToast({ message: '推荐设置已保存' })
                  })
                  .catch((error) =>
                    showToast({
                      message: '推荐设置没有保存',
                      detail: error instanceof Error ? error.message : '请检查内容'
                    })
                  )
                  .finally(() => setSaving(false))
              }}
            >
              <Save size={14} />
              保存推荐设置
            </button>
          </div>
        </section>

        <section className="settings-section" hidden={activeTab !== 'sync'}>
          <div className="settings-section-title">
            <Cloud size={17} aria-hidden="true" />
            <div>
              <h2>加密 WebDAV 同步</h2>
              <p>服务器只会看到 Argon2id＋XChaCha20-Poly1305 加密后的快照。</p>
            </div>
          </div>
          <label className="settings-field">
            <span>服务器地址</span>
            <input
              value={syncDraft.serverUrl}
              onChange={(event) => setSyncDraft({ ...syncDraft, serverUrl: event.target.value })}
              placeholder="https://cloud.example.com/remote.php/dav/files/name/"
              inputMode="url"
            />
          </label>
          <label className="settings-field">
            <span>用户名</span>
            <input
              value={syncDraft.username}
              onChange={(event) => setSyncDraft({ ...syncDraft, username: event.target.value })}
              autoComplete="username"
            />
          </label>
          <label className="settings-field">
            <span>WebDAV 密码</span>
            <input
              type="password"
              value={syncDraft.password}
              onChange={(event) => setSyncDraft({ ...syncDraft, password: event.target.value })}
              placeholder={syncSettings?.hasCredentials ? '已保存在系统密钥库；修改时重新输入' : ''}
              autoComplete="new-password"
            />
          </label>
          <label className="settings-field">
            <span>独立同步口令</span>
            <input
              type="password"
              value={syncDraft.passphrase}
              onChange={(event) => setSyncDraft({ ...syncDraft, passphrase: event.target.value })}
              placeholder="至少 8 个字符；其他设备需要相同口令"
              autoComplete="new-password"
            />
          </label>
          <label className="settings-field">
            <span>远端文件</span>
            <input
              value={syncDraft.remotePath}
              onChange={(event) => setSyncDraft({ ...syncDraft, remotePath: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>设备名称</span>
            <input
              value={syncDraft.deviceName}
              onChange={(event) => setSyncDraft({ ...syncDraft, deviceName: event.target.value })}
            />
          </label>
          <div className="settings-toggle-row">
            <span>
              <LockKeyhole size={15} />
              在本机记住同步口令
            </span>
            <Toggle
              checked={syncDraft.rememberPassphrase}
              label="记住同步口令"
              onChange={(rememberPassphrase) => setSyncDraft({ ...syncDraft, rememberPassphrase })}
            />
          </div>
          <div className={`sync-state-row sync-${syncState?.status ?? 'disconnected'}`}>
            {syncState?.status === 'syncing' ? (
              <LoaderCircle size={15} className="spin" />
            ) : syncSettings?.enabled ? (
              <Cloud size={15} />
            ) : (
              <CloudOff size={15} />
            )}
            <span>
              {syncState?.status === 'syncing'
                ? '正在同步'
                : syncState?.lastSyncedAt
                  ? `上次同步 ${new Date(syncState.lastSyncedAt).toLocaleString()}`
                  : syncSettings?.enabled
                    ? '已配置，等待首次同步'
                    : '尚未连接'}
            </span>
            {syncState?.pendingChanges ? <small>{syncState.pendingChanges} 项待上传</small> : null}
          </div>
          {syncSettings?.enabled && !syncSettings.syncV3Confirmed ? (
            <div className="settings-warning-note" role="status">
              <strong>需要确认同步格式升级</strong>
              <span>v2.1 会使用 schema 3 与加密信封 v2；同一远端文件上的其他设备也需要升级。</span>
            </div>
          ) : null}
          {syncState?.lastError ? (
            <p className="settings-error-note">{syncState.lastError}</p>
          ) : null}
          <div className="settings-inline-actions sync-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={
                testingSync || !syncDraft.serverUrl || !syncDraft.password || !syncDraft.passphrase
              }
              onClick={() => {
                setTestingSync(true)
                void api.sync
                  .test(syncDraft)
                  .then((result) => showToast({ message: result.message }))
                  .catch((error) =>
                    showToast({
                      message: 'WebDAV 测试失败',
                      detail: error instanceof Error ? error.message : '请检查配置'
                    })
                  )
                  .finally(() => setTestingSync(false))
              }}
            >
              <TestTube2 size={14} />
              {testingSync ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!syncDraft.serverUrl || !syncDraft.password || !syncDraft.passphrase}
              onClick={() => {
                setSaving(true)
                void configureSync(syncDraft)
                  .then(() => {
                    setSyncDraft({ ...syncDraft, password: '', passphrase: '' })
                    showToast({ message: 'WebDAV 已安全配置' })
                  })
                  .catch((error) =>
                    showToast({
                      message: '同步配置没有保存',
                      detail: error instanceof Error ? error.message : '请检查内容'
                    })
                  )
                  .finally(() => setSaving(false))
              }}
            >
              <Save size={14} />
              保存配置
            </button>
            {syncSettings?.enabled ? (
              <button
                type="button"
                className="secondary-button"
                disabled={syncing}
                onClick={() => {
                  setSyncing(true)
                  void runSync()
                    .then(() => showToast({ message: '同步已经完成' }))
                    .catch((error) =>
                      showToast({
                        message: '同步没有完成',
                        detail: error instanceof Error ? error.message : '请稍后重试'
                      })
                    )
                    .finally(() => setSyncing(false))
                }}
              >
                <RefreshCw size={14} />
                {syncing ? '同步中…' : '立即同步'}
              </button>
            ) : null}
            {syncSettings?.enabled ? (
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => {
                  if (!window.confirm('断开 WebDAV？远端加密文件不会被删除。')) return
                  void disconnectSync()
                    .then(() => showToast({ message: 'WebDAV 已断开' }))
                    .catch((error) =>
                      showToast({
                        tone: 'error',
                        message: 'WebDAV 没有断开',
                        detail: String(error)
                      })
                    )
                }}
              >
                <CloudOff size={14} />
                断开
              </button>
            ) : null}
          </div>
          {syncConflicts.length ? (
            <div className="sync-conflicts">
              <strong>同步冲突 · {syncConflicts.length}</strong>
              {syncConflicts.slice(0, 5).map((conflict) => (
                <div key={conflict.id} className="sync-conflict-row">
                  <span>
                    {conflict.entityType} · {conflict.entityId.slice(0, 8)}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void api.sync
                        .resolveConflict(conflict.id, 'local')
                        .then(refreshSync)
                        .catch((error) =>
                          showToast({
                            tone: 'error',
                            message: '冲突没有处理成功',
                            detail: String(error)
                          })
                        )
                    }
                  >
                    保留本机
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void api.sync
                        .resolveConflict(conflict.id, 'remote')
                        .then(refreshSync)
                        .catch((error) =>
                          showToast({
                            tone: 'error',
                            message: '冲突没有处理成功',
                            detail: String(error)
                          })
                        )
                    }
                  >
                    采用远端
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="settings-section" hidden={activeTab !== 'general'}>
          <div className="settings-section-title">
            <Clock3 size={17} aria-hidden="true" />
            <div>
              <h2>番茄计时</h2>
              <p>专注完成后会自动进入休息计时。</p>
            </div>
          </div>
          <label className="settings-field">
            <span>专注时长</span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="180"
                defaultValue={settings.pomodoroFocusMinutes}
                onBlur={(event) =>
                  void update({ pomodoroFocusMinutes: Number(event.target.value) })
                }
              />
              <small>分钟</small>
            </span>
          </label>
          <label className="settings-field">
            <span>休息时长</span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="60"
                defaultValue={settings.pomodoroBreakMinutes}
                onBlur={(event) =>
                  void update({ pomodoroBreakMinutes: Number(event.target.value) })
                }
              />
              <small>分钟</small>
            </span>
          </label>
        </section>

        <section className="settings-section" hidden={activeTab !== 'general'}>
          <div className="settings-section-title">
            <Power size={17} aria-hidden="true" />
            <div>
              <h2>桌面行为</h2>
              <p>提醒需要 Nudge 在托盘中保持运行。</p>
            </div>
          </div>
          <div className="settings-toggle-row">
            <span>
              <PlayCircle size={15} aria-hidden="true" />
              开机时启动
            </span>
            <Toggle
              checked={settings.autoStart}
              label="开机时启动"
              onChange={(autoStart) => void update({ autoStart })}
            />
          </div>
          <div className="settings-toggle-row">
            <span>
              <BellRing size={15} aria-hidden="true" />
              关闭窗口后留在托盘
            </span>
            <Toggle
              checked={settings.closeToTray}
              label="关闭到托盘"
              onChange={(closeToTray) => void update({ closeToTray })}
            />
          </div>
          <label className="settings-field shortcut-field">
            <span>
              <Keyboard size={15} aria-hidden="true" />
              全局快速添加
            </span>
            <input
              type="text"
              defaultValue={settings.globalShortcut}
              onBlur={(event) => void update({ globalShortcut: event.target.value })}
            />
          </label>
        </section>

        <section className="settings-section" hidden={activeTab !== 'general'}>
          <div className="settings-section-title">
            <ListTodo size={17} aria-hidden="true" />
            <div>
              <h2>清单管理</h2>
              <p>删除清单时，任务会安全地移回收集箱。</p>
            </div>
          </div>
          <div className="settings-list-stack">
            {lists
              .filter((list) => list.id !== 'inbox')
              .map((list) => (
                <EditableList key={list.id} list={list} />
              ))}
          </div>
        </section>

        <section className="settings-section" hidden={activeTab !== 'data'}>
          <div className="settings-section-title">
            <ArchiveRestore size={17} aria-hidden="true" />
            <div>
              <h2>数据与备份</h2>
              <p>所有数据保存在本机，恢复前会自动创建数据库备份。</p>
            </div>
          </div>
          <div className="backup-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void api.backup
                  .exportJson()
                  .then((result) => {
                    if (!result.canceled)
                      showToast({ message: '备份已经导出', detail: result.path })
                  })
                  .catch((error) =>
                    showToast({ tone: 'error', message: '备份没有导出', detail: String(error) })
                  )
              }
            >
              <Download size={15} aria-hidden="true" />
              导出 JSON
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void importBackup('merge')}
            >
              <Upload size={15} aria-hidden="true" />
              合并导入
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => void importBackup('replace')}
            >
              <ArchiveRestore size={15} aria-hidden="true" />
              覆盖恢复
            </button>
          </div>
        </section>
      </div>
    </aside>
  )
}
