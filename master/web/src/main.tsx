import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './ui/fonts.css';
import './ui/tokens.css';
import './ui/reset.css';
import './ui/base.css';
import './styles.css';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initAppearance } from './ui/theme';

// Before first paint, so there is no flash of the wrong theme or density.
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
