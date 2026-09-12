import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initApiClient } from '@/services/apiClient';
import { App } from './App';
import { AuthProvider } from './state/authContext';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('[compralo] falta #root en index.html');

// La sesión y el modo (mock o backend real) se hidratan de storage **antes** del
// primer render. Si no, el panel parpadea del login a la sesión ya iniciada.
void initApiClient().then(() => {
  createRoot(container).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  );
});
