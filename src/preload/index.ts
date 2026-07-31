import { contextBridge, ipcRenderer } from 'electron'
import type { FocusState, NudgeBridge } from '../shared/types'

const bridge: NudgeBridge = {
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    update: (id, input) => ipcRenderer.invoke('tasks:update', id, input),
    complete: (id, completed) => ipcRenderer.invoke('tasks:complete', id, completed),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id),
    restore: (id) => ipcRenderer.invoke('tasks:restore', id),
    reorder: (ids) => ipcRenderer.invoke('tasks:reorder', ids)
  },
  lists: {
    list: () => ipcRenderer.invoke('lists:list'),
    create: (name) => ipcRenderer.invoke('lists:create', name),
    update: (id, input) => ipcRenderer.invoke('lists:update', id, input),
    delete: (id) => ipcRenderer.invoke('lists:delete', id)
  },
  tags: {
    list: () => ipcRenderer.invoke('tags:list')
  },
  focus: {
    getState: () => ipcRenderer.invoke('focus:get-state'),
    getStats: () => ipcRenderer.invoke('focus:get-stats'),
    start: (input) => ipcRenderer.invoke('focus:start', input),
    pause: () => ipcRenderer.invoke('focus:pause'),
    resume: () => ipcRenderer.invoke('focus:resume'),
    stop: () => ipcRenderer.invoke('focus:stop'),
    skip: () => ipcRenderer.invoke('focus:skip'),
    onChange: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: FocusState): void => callback(state)
      ipcRenderer.on('focus:changed', listener)
      return () => ipcRenderer.removeListener('focus:changed', listener)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input) => ipcRenderer.invoke('settings:update', input)
  },
  backup: {
    exportJson: () => ipcRenderer.invoke('backup:export'),
    importJson: (mode) => ipcRenderer.invoke('backup:import', mode)
  },
  desktop: {
    toggleMiniWindow: () => ipcRenderer.invoke('desktop:toggle-mini'),
    showMainWindow: () => ipcRenderer.invoke('desktop:show-main'),
    onQuickAdd: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('desktop:quick-add', listener)
      return () => ipcRenderer.removeListener('desktop:quick-add', listener)
    }
  }
}

contextBridge.exposeInMainWorld('nudge', bridge)
