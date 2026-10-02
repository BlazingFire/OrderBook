import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import '@orderbook/ui/styles.css';
import './styles.css';
import { configureUi, ErrorBoundary, initAppearance } from '@orderbook/ui';

// Which panel this is, and its theme key. Must run before `initAppearance()`,
// which reads them. Light by default since 1.3, like the Office; dark is still
// a choice in Settings → Appearance. The key moved from 'ob.theme.v2' because
// `initAppearance()` stores whatever it loads, so every existing Master has
// 'dark' saved there: the new key starts each one on light once, and a choice
// made after that persists as before.
configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme.v3' });

// Before first paint, so there is no flash of the wrong theme.
initAppearance();

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
