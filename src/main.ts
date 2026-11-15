import './index.css';
import { initApp } from './app';

initApp().catch((err) => {
  console.error('PyroLens failed to start:', err);
});
