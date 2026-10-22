import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type ToastKind = 'ok' | 'err' | 'info' | 'warn'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

interface ToastCtx {
  push: (kind: ToastKind, text: string) => void
}

const Ctx = createContext<ToastCtx>({ push: () => {} })

export function useToast() {
  return useContext(Ctx)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev.slice(-3), { id, kind, text }])
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, kind === 'err' ? 6000 : 3200)
  }, [])

  const value = useMemo(() => ({ push }), [push])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-dot" />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
