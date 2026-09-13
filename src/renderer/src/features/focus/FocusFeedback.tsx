import { useEffect, useRef } from 'react'
import { useNudgeStore } from '../../store'
import { findTask } from '../tasks/model'

export function FocusFeedback(): React.JSX.Element {
  const pending = useNudgeStore((state) => state.pendingFocus)
  const current = useNudgeStore((state) => findTask(state.tasks, state.focusState?.taskId ?? null))
  const target = useNudgeStore((state) => findTask(state.tasks, state.pendingFocus?.taskId ?? null))
  const busy = useNudgeStore((state) => state.focusBusy)
  const error = useNudgeStore((state) => state.focusError)
  const confirm = useNudgeStore((state) => state.confirmFocusSwitch)
  const cancel = useNudgeStore((state) => state.cancelFocusSwitch)
  const retry = useNudgeStore((state) => state.retryFocus)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (pending) dialog.current?.showModal()
    else dialog.current?.close()
  }, [pending])
  return (
    <>
      {error && !pending && (
        <div className="focus-error inline-notice" role="alert">
          <span>{error}</span>
          <button type="button" disabled={busy} onClick={() => void retry()}>
            重试
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="focus-switch-dialog"
        aria-labelledby="focus-switch-title"
        onCancel={(event) => {
          event.preventDefault()
          if (!busy) cancel()
        }}
      >
        <h2 id="focus-switch-title">切换正在进行的专注？</h2>
        <p>
          先保存“{current?.title ?? '当前专注'}”已计时的时长，再开始“
          {target?.title ?? (pending?.mode === 'stopwatch' ? '自由计时' : '番茄专注')}”。
        </p>
        {error && (
          <p className="save-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>
            继续当前专注
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? '保存中…' : '保存并切换'}
          </button>
        </div>
      </dialog>
    </>
  )
}
