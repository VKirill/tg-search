import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMockApi } from './mockApi';
import './styles.css';

if (typeof window !== 'undefined' && !window.api) {
  window.api = createMockApi();
}

createRoot(document.getElementById('root')!).render(<App />);
