import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type ToastItem = { id: number; message: string };

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string) => {
    const id = Date.now();
    setItems((prev) => [...prev, { id, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status">
        {items.map((t) => (
          <div key={t.id} className="toast">{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function installGlobalErrors(push: (msg: string) => void) {
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    push(err instanceof Error ? err.message : String(err));
  });
}
