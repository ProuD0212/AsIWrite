import { useEffect, type ReactNode } from 'react';
import { modalState } from './modalState';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // counted so the game can hold time while a window is open (settings toggle)
  useEffect(() => {
    modalState.open++;
    return () => {
      modalState.open--;
    };
  }, []);
  return (
    // pointer-events-auto / select-text: in-game modals live inside the HUD layer, which is
    // pointer-events-none + select-none so clicks fall through to the map — a modal must opt back in
    <div data-modal-open className="pointer-events-auto fixed inset-0 z-[70] flex select-text items-center justify-center bg-black/55 p-4" onMouseDown={onClose}>
      <div
        className={`panel scroll-thin max-h-[88vh] w-full overflow-y-auto rounded-xl p-5 shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-parch">{title}</h2>
          <button className="rounded px-2 text-parch-dim hover:text-parch" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Btn({ children, onClick, variant = 'default', className = '', disabled, title }: { children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'danger' | 'ghost'; className?: string; disabled?: boolean; title?: string }) {
  const v = {
    default: 'bg-white/8 hover:bg-white/14 text-parch border border-white/10',
    primary: 'bg-glow/90 hover:bg-glow text-ink font-semibold',
    danger: 'bg-red-500/15 hover:bg-red-500/30 text-red-200 border border-red-400/20',
    ghost: 'hover:bg-white/10 text-parch-dim hover:text-parch',
  }[variant];
  return (
    <button title={title} disabled={disabled} onClick={onClick} className={`rounded-md px-3 py-1.5 text-sm transition disabled:opacity-40 ${v} ${className}`}>
      {children}
    </button>
  );
}
