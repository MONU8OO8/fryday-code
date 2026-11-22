import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Core serves the UI at /ui/. The public demo is static files on any path (GitHub Pages has
// no fallback to index.html), so it keeps its screens in the #fragment instead.
const demo = import.meta.env.VITE_DEMO === '1';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {demo ? <HashRouter><App /></HashRouter> : <BrowserRouter basename="/ui"><App /></BrowserRouter>}
  </React.StrictMode>
);
