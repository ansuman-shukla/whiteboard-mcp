import './globals';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readConfig } from './config';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App config={readConfig()} />
  </StrictMode>,
);
