import clsx from 'clsx';
import { ListChecks, Plus } from 'lucide-react';

export type PanelTab = 'new-order' | 'orders';

interface NavigationProps {
  active: PanelTab;
  onChange: (tab: PanelTab) => void;
  /** Órdenes en la watch list. `undefined` mientras no se ha cargado. */
  orderCount?: number;
  /** Alguna orden espera respuesta del usuario (`AWAITING_APPROVAL`). */
  needsAttention?: boolean;
}

export function Navigation({ active, onChange, orderCount, needsAttention }: NavigationProps) {
  return (
    <nav className="grid grid-cols-2 border-b border-ink-600 bg-ink-800" aria-label="Secciones">
      <TabButton
        label="Nueva orden"
        icon={<Plus className="size-3.5" aria-hidden />}
        selected={active === 'new-order'}
        onClick={() => onChange('new-order')}
      />
      <TabButton
        label="Mis órdenes"
        icon={<ListChecks className="size-3.5" aria-hidden />}
        selected={active === 'orders'}
        onClick={() => onChange('orders')}
        count={orderCount}
        dot={needsAttention}
      />
    </nav>
  );
}

interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onClick: () => void;
  count?: number;
  dot?: boolean;
}

function TabButton({ label, icon, selected, onClick, count, dot }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={clsx(
        'relative flex items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition',
        selected
          ? 'border-b-2 border-mint-500 text-slate-50'
          : 'border-b-2 border-transparent text-slate-400 hover:text-slate-200',
      )}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="tabular rounded-full bg-ink-600 px-1.5 py-0.5 text-[10px] text-slate-300">
          {count}
        </span>
      )}
      {dot && (
        <span
          className="absolute right-2 top-2 size-1.5 rounded-full bg-amber-400"
          aria-label="Una orden espera tu respuesta"
        />
      )}
    </button>
  );
}
