import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const elements = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
    const initial = ref.current?.querySelector<HTMLElement>('[data-cancel]') ?? elements()[0]; initial?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); cancel.current(); return; }
      if (event.key !== 'Tab') return;
      const items = elements(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const current = ref.current;
    current?.addEventListener('keydown', key);
    return () => { current?.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="modal"><h2>{title}</h2>{children}</div></div>;
}