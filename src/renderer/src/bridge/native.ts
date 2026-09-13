import type { NudgeBridge, SecretStoreStatus } from '@shared/types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { format } from 'date-fns'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '本地命令没有执行成功'
    const code = /密钥库|密钥/.test(message)
      ? 'secret-store'
      : /密码|凭据|权限/.test(message)
        ? 'auth'
        : /离线|网络|连接|超时/.test(message)
          ? 'offline'
          : /冲突/.test(message)
            ? 'conflict'
            : /取消/.test(message)
              ? 'canceled'
              : /无效|不能为空|最多|至少|格式/.test(message)
                ? 'validation'
                : 'internal'
    const normalized = new Error(message) as Error & { code: string; retryable: boolean }
    normalized.code = code
    normalized.retryable = ['offline', 'conflict', 'internal'].includes(code)
    throw normalized
  }
}

function subscribe<T>(eventName: string, callback: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  void listen<T>(eventName, (event) => callback(event.payload)).then((off) => {
    if (disposed) off()
    else unlisten = off
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

async function migrateLegacySecrets(): Promise<SecretStoreStatus> {
  const status = await call<SecretStoreStatus>('secrets_status')
  if (status.migration !== 'pending') return status
  const { migrateLegacySecrets: migrate } = await import('../legacy-secret-migration')
  return migrate((input) => call('secrets_import_legacy', { input }))
}

export function createTauriBridge(): NudgeBridge {
  return {
    app: {
      bootstrap: async () => {
        const status = await call<SecretStoreStatus>('secrets_status')
        if (status.migration === 'pending') {
          try {
            await migrateLegacySecrets()
          } catch {
            // The old vault remains untouched; settings surfaces the pending state.
          }
        }
        return call('app_bootstrap')
      },
      onDataChanged: (callback) => subscribe('app-data-changed', callback)
    },
    tasks: {
      list: () => call('tasks_list'),
      create: (input) => call('tasks_create', { input }),
      update: (id, input) => call('tasks_update', { id, input }),
      complete: (id, completed) => call('tasks_complete', { id, completed }),
      delete: (id) => call('tasks_delete', { id }),
      restore: (id) => call('tasks_restore', { id }),
      reorder: (ids) => call('tasks_reorder', { ids })
    },
    lists: {
      list: () => call('lists_list'),
      create: (name) => call('lists_create', { name }),
      update: (id, input) => call('lists_update', { id, name: input.name, color: input.color }),
      delete: (id) => call('lists_delete', { id })
    },
    tags: { list: () => call('tags_list') },
    focus: {
      getState: () => call('focus_get_state'),
      getStats: () => call('focus_get_stats'),
      history: (query) => call('focus_history', { query }),
      start: ({ mode, taskId, replaceActive = false }) =>
        call('focus_start', { mode, taskId: taskId ?? null, replaceActive }),
      pause: () => call('focus_pause'),
      resume: () => call('focus_resume'),
      stop: () => call('focus_stop'),
      skip: () => call('focus_skip'),
      onChange: (callback) => subscribe('focus-changed', callback)
    },
    settings: {
      get: () => call('settings_get'),
      update: (input) => call('settings_update', { input })
    },
    learning: {
      get: (taskId) => call('learning_get', { taskId }),
      ensure: (taskId) => call('learning_ensure', { taskId }),
      generate: (taskId, input = {}) =>
        call('learning_generate', {
          taskId,
          sections: input.sections ?? null,
          includeNotes: input.includeNotes ?? false
        }),
      cancel: (taskId) => call('learning_cancel', { taskId }),
      resources: {
        create: (taskId, input) => call('learning_resource_create', { taskId, input }),
        update: (id, input) => call('learning_resource_update', { id, input }),
        delete: (id) => call('learning_resource_delete', { id }),
        reorder: (packId, ids) => call('learning_resource_reorder', { packId, ids }),
        pin: (id, pinned) => call('learning_resource_pin', { id, pinned })
      },
      roadmap: {
        upsertNode: (taskId, input) => call('learning_node_upsert', { taskId, input }),
        deleteNode: (id) => call('learning_node_delete', { id }),
        connect: (packId, sourceNodeId, targetNodeId) =>
          call('learning_edge_connect', { packId, sourceNodeId, targetNodeId }),
        disconnect: (id) => call('learning_edge_disconnect', { id }),
        autoLayout: (taskId) => call('learning_auto_layout', { taskId }),
        setStatus: (id, status) => call('learning_node_set_status', { id, status })
      },
      onProgress: (callback) => subscribe('learning-progress', callback)
    },
    recommendation: {
      getSettings: () => call('recommendation_get_settings'),
      updateSettings: (input) => call('recommendation_update_settings', { input }),
      testConnection: (input) => call('recommendation_test_connection', { input: input ?? null })
    },
    sync: {
      configure: (input) => call('sync_configure', { input }),
      test: (input) => call('sync_test', { input: input ?? null }),
      run: () => call('sync_run'),
      disconnect: () => call('sync_disconnect'),
      getSettings: () => call('sync_get_settings'),
      confirmUpgrade: () => call('sync_confirm_upgrade'),
      getState: () => call('sync_get_state'),
      listConflicts: () => call('sync_list_conflicts'),
      resolveConflict: (id, choice) => call('sync_resolve_conflict', { id, choice }),
      onStateChanged: (callback) => subscribe('sync-state-changed', callback)
    },
    secrets: {
      status: () => call('secrets_status'),
      migrateLegacy: migrateLegacySecrets
    },
    backup: {
      exportJson: async () => {
        const path = await save({
          title: '导出 Nudge 备份',
          defaultPath: `nudge-backup-${format(new Date(), 'yyyy-MM-dd')}.json`,
          filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
        })
        if (!path) return { canceled: true }
        return call('backup_export', { path })
      },
      importJson: async (mode) => {
        const path = await open({
          title: mode === 'replace' ? '恢复 Nudge 备份' : '导入 Nudge 数据',
          multiple: false,
          filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
        })
        if (!path || Array.isArray(path)) return { canceled: true }
        return call('backup_import', { path, mode })
      }
    },
    media: {
      thumbnailDataUrl: (source) => call('media_thumbnail_data_url', { source })
    },
    desktop: {
      toggleMiniWindow: () => call('desktop_toggle_mini_window'),
      showMainWindow: () => call('desktop_show_main'),
      openExternal: (url) => call('desktop_open_external', { url }),
      minimize: () => call('desktop_minimize'),
      toggleMaximize: () => call('desktop_toggle_maximize'),
      close: () => call('desktop_close'),
      platform: () => call('desktop_platform'),
      prepareNotifications: () => call('notifications_prepare'),
      onQuickAdd: (callback) => subscribe('desktop-quick-add', callback)
    }
  }
}
