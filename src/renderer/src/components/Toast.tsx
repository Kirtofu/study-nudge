import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

type ToastInput = {
  message: string
  detail?: string
  actionLabel?: string
  onAction?: () => void | Promise<void>
  duration?: number
  tone?: 'success' | 'error'
}

type ToastValue = ToastInput & { id: number }

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined)

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastValue[]>([])
  const nextId = useRef(0)
  const showToast = useCallback((input: ToastInput) => {
    setToasts((current) => [...current, { ...input, id: ++nextId.current }])
  }, [])
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    []
  )

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-relevant="additions text">
        <AnimatePresence>
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  dismiss
}: {
  toast: ToastValue
  dismiss: (id: number) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const remaining = useRef(toast.duration ?? 5000)
  useEffect(() => {
    if (busy || paused || error) return
    const started = Date.now()
    const timer = setTimeout(() => dismiss(toast.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - started
    }
  }, [busy, paused, error, dismiss, toast.id])
  const undo = async (): Promise<void> => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await toast.onAction?.()
      dismiss(toast.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <motion.div
      className={`toast ${toast.tone === 'error' || error ? 'toast-error' : ''}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false)
      }}
    >
      {toast.tone === 'error' || error ? (
        <AlertCircle size={18} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={18} aria-hidden="true" />
      )}
      <div className="toast-copy">
        <strong>{toast.message}</strong>
        {(error || toast.detail) && <span>{error || toast.detail}</span>}
      </div>
      {toast.onAction && (
        <button type="button" className="toast-action" disabled={busy} onClick={() => void undo()}>
          {busy ? (
            <LoaderCircle size={14} className="spin" aria-label="正在处理" />
          ) : error ? (
            '重试'
          ) : (
            toast.actionLabel
          )}
        </button>
      )}
      <button
        type="button"
        className="icon-button toast-close"
        disabled={busy}
        aria-label="关闭提示"
        onClick={() => dismiss(toast.id)}
      >
        <X size={16} />
      </button>
    </motion.div>
  )
}

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext)
}
