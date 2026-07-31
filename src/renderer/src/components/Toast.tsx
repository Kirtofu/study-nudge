import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, X } from 'lucide-react'

type ToastInput = {
  message: string
  detail?: string
  actionLabel?: string
  onAction?: () => void | Promise<void>
  duration?: number
}

type ToastValue = ToastInput & { id: number }

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined)

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toast, setToast] = useState<ToastValue | null>(null)
  const timer = useRef<number | null>(null)

  const dismiss = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setToast(null)
  }, [])

  const showToast = useCallback(
    (input: ToastInput) => {
      if (timer.current) window.clearTimeout(timer.current)
      const value = { ...input, id: Date.now() }
      setToast(value)
      timer.current = window.setTimeout(dismiss, input.duration ?? 5000)
    },
    [dismiss]
  )

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )
  const contextValue = useMemo(() => showToast, [showToast])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="true">
        <AnimatePresence>
          {toast ? (
            <motion.div
              key={toast.id}
              className="toast"
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <CheckCircle2 size={18} aria-hidden="true" />
              <div className="toast-copy">
                <strong>{toast.message}</strong>
                {toast.detail ? <span>{toast.detail}</span> : null}
              </div>
              {toast.actionLabel && toast.onAction ? (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    void toast.onAction?.()
                    dismiss()
                  }}
                >
                  {toast.actionLabel}
                </button>
              ) : null}
              <button type="button" className="icon-button toast-close" aria-label="关闭提示" onClick={dismiss}>
                <X size={16} aria-hidden="true" />
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext)
}
