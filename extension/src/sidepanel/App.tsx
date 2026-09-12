/**
 * Orquestador del panel: puerta de sesión + navegación por pestañas.
 *
 * La puerta es explícita a propósito. Sin sesión no se renderiza nada del
 * producto, y al caducar el token se vuelve aquí con el motivo escrito.
 */

import { useCallback, useState } from 'react';
import { AuthView } from './components/AuthView';
import { HeaderBar } from './components/HeaderBar';
import { Navigation, type PanelTab } from './components/Navigation';
import { NewOrderView } from './components/NewOrderView';
import { WatchListView } from './components/WatchListView';
import { useAuth } from './state/authContext';
import type { InstructionSummary } from '@/services/api.types';

export function App() {
  const { session } = useAuth();
  const [tab, setTab] = useState<PanelTab>('new-order');
  const [summaries, setSummaries] = useState<InstructionSummary[] | null>(null);

  const handleCount = useCallback((next: InstructionSummary[]) => setSummaries(next), []);

  if (!session) return <AuthView />;

  const needsAttention = summaries?.some((item) => item.status === 'AWAITING_APPROVAL') ?? false;

  return (
    <div className="flex min-h-full flex-col">
      <HeaderBar />
      <Navigation
        active={tab}
        onChange={setTab}
        orderCount={summaries?.length}
        needsAttention={needsAttention}
      />
      <main className="flex-1 px-3 py-3">
        {tab === 'new-order' ? <NewOrderView /> : <WatchListView onCount={handleCount} />}
      </main>
    </div>
  );
}
