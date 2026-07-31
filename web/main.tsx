import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root introuvable — index.html est-il bien celui de web/ ?');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
