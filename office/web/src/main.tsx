import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import '@orderbook/ui/styles.css';
import './styles.css';
import { configureUi, ErrorBoundary, initAppearance, UpdateFinishedCard } from '@orderbook/ui';

// Which panel this is, and the two appearance defaults that genuinely differ
// from the Master's. Must run before `initAppearance()`, which reads them.
configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });

// Before first paint, so there is no flash of the wrong theme or density.
initAppearance();

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      {/* After an update (1.5): from which version to which, and how long it took. Under the splash until it goes. */}
      <UpdateFinishedCard running={__APP_VERSION__} />
    </ErrorBoundary>
  </StrictMode>,
);
