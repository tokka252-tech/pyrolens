import './index.css';
import { initApp } from './app';

initApp().catch((err) => {
  console.error('PyreSync failed to start:', err);
});
