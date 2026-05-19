import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SessionProvider } from './state/SessionContext';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element not found');

// NOTE: StrictMode is deliberately disabled. Its dev-only double-mount
// breaks Pixi.js — the second invocation of `Application.init` on the
// same canvas crashes during shader compilation because the first
// instance's WebGL context is still in flight when the rerun begins.
// Production builds strip StrictMode anyway, so removing it here only
// changes the dev-mode experience.
createRoot(container).render(
  <SessionProvider>
    <App />
  </SessionProvider>,
);
