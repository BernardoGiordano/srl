import { startApplication } from '@core/application/runtime.js';

await startApplication({
  root: { load: () => import('./app-root.js').then((m) => m.AppRoot) },
});
