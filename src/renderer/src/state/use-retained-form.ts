import { useEffect, useRef, useState } from 'react'

// Refresh untouched fields from the bridge, while keeping local edits (including
// credentials that are intentionally absent from bridge snapshots).
export function useRetainedForm<T extends object>(incoming: T) {
  const previous = useRef(incoming)
  const [draft, setDraft] = useState(incoming)
  useEffect(() => {
    const before = previous.current
    previous.current = incoming
    const keys = (Object.keys(incoming) as Array<keyof T>).filter(
      (key) => !Object.is(before[key], incoming[key])
    )
    if (!keys.length) return
    setDraft((current) => {
      const next = { ...current }
      for (const key of keys) if (Object.is(current[key], before[key])) next[key] = incoming[key]
      return next
    })
  }, [incoming])
  return [draft, setDraft] as const
}
