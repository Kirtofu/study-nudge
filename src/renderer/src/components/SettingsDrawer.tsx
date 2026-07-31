import { useState } from 'react'
import {
  ArchiveRestore,
  BellRing,
  Clock3,
  Download,
  Keyboard,
  ListTodo,
  PlayCircle,
  Power,
  Save,
  Target,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { AppSettings, TaskList } from '@shared/types'
import { api } from '../bridge'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

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
  const [name, setName] = useState(list.name)
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
          if (clean && clean !== list.name) void updateList(list.id, { name: clean })
          else setName(list.name)
        }}
      />
      <button
        type="button"
        className="icon-button danger-icon"
        aria-label={`删除“${list.name}”清单`}
        onClick={() => {
          if (!window.confirm(`删除“${list.name}”清单？其中的任务会移到收集箱。`)) return
          void deleteList(list.id).then(() => showToast({ message: '清单已删除', detail: '其中的任务已移到收集箱' }))
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
  const [saving, setSaving] = useState(false)
  const showToast = useToast()

  if (!settings) return null

  const update = async (input: Partial<AppSettings>): Promise<void> => {
    setSaving(true)
    try {
      await updateSettings(input)
    } catch (error) {
      showToast({ message: '设置没有保存', detail: error instanceof Error ? error.message : '请稍后重试' })
    } finally {
      setSaving(false)
    }
  }

  const importBackup = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (mode === 'replace' && !window.confirm('覆盖恢复会替换当前数据。Nudge 会先自动备份，仍要继续吗？')) return
    try {
      const result = await api.backup.importJson(mode)
      if (result.canceled) return
      await Promise.all([refreshTasks(), refreshStats()])
      showToast({ message: mode === 'replace' ? '备份已经恢复' : '数据已经导入', detail: `处理了 ${result.imported ?? 0} 条记录` })
    } catch (error) {
      showToast({ message: '备份没有导入成功', detail: error instanceof Error ? error.message : '请检查文件格式' })
    }
  }

  return (
    <aside className="detail-drawer settings-drawer" aria-label="设置与备份">
      <div className="drawer-header">
        <div className="save-state">
          {saving ? (
            <>
              <Save size={13} aria-hidden="true" />正在保存
            </>
          ) : (
            <span>设置与备份</span>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="关闭设置" onClick={closeDrawer}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="drawer-scroll">
        <section className="settings-section">
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

        <section className="settings-section">
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
                onBlur={(event) => void update({ pomodoroFocusMinutes: Number(event.target.value) })}
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
                onBlur={(event) => void update({ pomodoroBreakMinutes: Number(event.target.value) })}
              />
              <small>分钟</small>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <Power size={17} aria-hidden="true" />
            <div>
              <h2>桌面行为</h2>
              <p>提醒需要 Nudge 在托盘中保持运行。</p>
            </div>
          </div>
          <div className="settings-toggle-row">
            <span>
              <PlayCircle size={15} aria-hidden="true" />开机时启动
            </span>
            <Toggle checked={settings.autoStart} label="开机时启动" onChange={(autoStart) => void update({ autoStart })} />
          </div>
          <div className="settings-toggle-row">
            <span>
              <BellRing size={15} aria-hidden="true" />关闭窗口后留在托盘
            </span>
            <Toggle checked={settings.closeToTray} label="关闭到托盘" onChange={(closeToTray) => void update({ closeToTray })} />
          </div>
          <label className="settings-field shortcut-field">
            <span>
              <Keyboard size={15} aria-hidden="true" />全局快速添加
            </span>
            <input
              type="text"
              defaultValue={settings.globalShortcut}
              onBlur={(event) => void update({ globalShortcut: event.target.value })}
            />
          </label>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <ListTodo size={17} aria-hidden="true" />
            <div>
              <h2>清单管理</h2>
              <p>删除清单时，任务会安全地移回收集箱。</p>
            </div>
          </div>
          <div className="settings-list-stack">
            {lists.filter((list) => list.id !== 'inbox').map((list) => <EditableList key={list.id} list={list} />)}
          </div>
        </section>

        <section className="settings-section">
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
                void api.backup.exportJson().then((result) => {
                  if (!result.canceled) showToast({ message: '备份已经导出', detail: result.path })
                })
              }
            >
              <Download size={15} aria-hidden="true" />导出 JSON
            </button>
            <button type="button" className="secondary-button" onClick={() => void importBackup('merge')}>
              <Upload size={15} aria-hidden="true" />合并导入
            </button>
            <button type="button" className="danger-button" onClick={() => void importBackup('replace')}>
              <ArchiveRestore size={15} aria-hidden="true" />覆盖恢复
            </button>
          </div>
        </section>
      </div>
    </aside>
  )
}
