import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { App } from './app/App.tsx';
import { applyTheme, readTheme } from './lib/theme.ts';

// Paint the stored theme before React mounts so there is no flash of the wrong palette.
applyTheme(readTheme());

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
