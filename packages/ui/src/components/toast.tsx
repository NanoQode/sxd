'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../cn';

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone?: 'info' | 'success' | 'danger';
}

interface ToastApi {
  toast: (t: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const toast = useCallback((t: Omit<ToastMessage, 'id'>) => {
    setItems((prev) => [...prev.slice(-4), { ...t, id: Date.now() + Math.random() }]);
  }, []);
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right" duration={6000}>
        {children}
        {items.map((item) => {
          const Icon =
            item.tone === 'success' ? CheckCircle2 : item.tone === 'danger' ? XCircle : Info;
          return (
            <ToastPrimitive.Root
              key={item.id}
              onOpenChange={(open) =>
                !open && setItems((prev) => prev.filter((p) => p.id !== item.id))
              }
              className={cn(
                'flex items-start gap-3 rounded-md border border-border bg-bg-elevated p-3 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out',
                item.tone === 'danger' && 'border-danger/40',
                item.tone === 'success' && 'border-success/40',
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  item.tone === 'danger'
                    ? 'text-danger'
                    : item.tone === 'success'
                      ? 'text-success'
                      : 'text-info',
                )}
              />
              <div className="min-w-0 flex-1 text-sm">
                <ToastPrimitive.Title className="font-medium">{item.title}</ToastPrimitive.Title>
                {item.description ? (
                  <ToastPrimitive.Description className="text-fg-muted">
                    {item.description}
                  </ToastPrimitive.Description>
                ) : null}
              </div>
              <ToastPrimitive.Close
                aria-label="Dismiss"
                className="sx-touch -m-2 flex items-center justify-center rounded-md p-2 text-fg-muted hover:text-fg"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[100] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
