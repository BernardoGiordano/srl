import { provide } from '@core/foundation/inject.js';
import { REMOTE_HOST } from '@core/remotes/mfe.js';
import { startApplication } from '@core/application/runtime.js';
import { createRemoteHostProvider } from '@host/remote-host.js';

/** @import { ApplicationSpec, StartedApplication } from '@core/application/types.js' */

/**
 * Startup for an application that mounts micro-frontends.
 *
 * The default `REMOTE_HOST` wiring lives here rather than in `core/`, so an
 * application says it mounts remotes by which startup function it calls rather
 * than by installing a library-internal token itself. ADR-0027.
 *
 * The default is installed before the application's own `providers` hook, and
 * `provide` replaces, so an application with a different capability policy
 * installs its own from that hook. One that wants nothing from `host/` calls
 * `startApplication` directly and imports nothing from here.
 *
 * @param {ApplicationSpec} spec
 * @returns {Promise<StartedApplication>}
 */
export function startHostedApplication(spec) {
  return startApplication({
    ...spec,

    // Folded into the `providers` step rather than added as a step of its own:
    // it is a provider installation, it has to run where the manifest is already
    // installed and the root is not yet imported, and that is precisely what the
    // existing step is for. The reported step list stays the vocabulary
    // applications already know.
    providers: async (manifest) => {
      provide(REMOTE_HOST, () => createRemoteHostProvider());
      await spec.providers?.(manifest);
    },
  });
}
