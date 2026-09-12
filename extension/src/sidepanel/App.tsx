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
import { isMockMode } from '@/services/apiClient';

export function App() {
  const { session } = useAuth();
  // El backend Rust solo sirve monitores y eventos: abre directamente la
  // superficie que existe en vivo y deja el análisis dinámico para mocks.
  const [tab, setTab] = useState<PanelTab>(() => (isMockMode() ? 'new-order' : 'orders'));
  const [summaries, setSummaries] = useState<InstructionSummary[] | null>(null);

  const handleCount = useCallback((next: InstructionSummary[]) => setSummaries(next), []);

  // El backend Rust no implementa usuarios ni auth. Mantener la puerta de
  // login en vivo haría inaccesible su watch list aunque el adaptador funcione.
  if (!session && isMockMode()) return <AuthView />;

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
