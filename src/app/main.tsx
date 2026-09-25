import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { store } from './state/store';
import './styles.css';

// Below 1280 px the side panels would cover the canvas, so both start folded.
const wide = window.innerWidth >= 1280;
store.set({ panels: { left: wide, right: wide, drawer: false } });
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
