import { useNudgeStore } from '../../store'

export function beginAdd(): void {
  const state = useNudgeStore.getState()
  state.closeLearning()
  state.closeDrawer()
  state.setCommandOpen(false)
  if (state.currentView === 'completed') state.setView('inbox')
  requestAnimationFrame(() => document.getElementById('quick-add-input')?.focus())
}
