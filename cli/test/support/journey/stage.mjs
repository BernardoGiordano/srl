/**
 * The one thing the journey runs against: a built artifact, served as production serves
 * it, with the application's own Content-Security-Policy on the entry document.
 *
 * Both callers stage it the same way — the suite that fails a pull request and the
 * recorder that writes the support matrix — because a matrix recorded against friendlier
 * bytes than the suite drives would be a claim about nothing. The build is the real
 * `buildArtifact`, the origin is `cli/origin`, and the policy is the one the build
 * emitted.
 *
 * Not part of the published package.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildArtifact, buildRemoteArtifact } from '../../../delivery/build.mjs';
import { apps } from '../../../layout.mjs';
import { startArtifactOrigin } from '../artifact-origin.mjs';

/**
 * A fixed commit and epoch, so two stagings of the same source produce the same bytes and
 * a failure is never "the artifact was different this time".
 */
const RELEASE = {
  commit: '0000000000000000000000000000000000000000',
  sourceDateEpoch: 0,
};

/**
 * @typedef {{ url: string, csp: string, close: () => Promise<void> }} Stage
 */

/**
 * @param {string} name The application to build, by directory name.
 * @returns {Promise<Stage>}
 */
export async function stageArtifact(name) {
  const app = (await apps()).find((candidate) => candidate.name === name);
  if (app === undefined) throw new Error(`No application named ${name} in this repository.`);

  const temporary = await mkdtemp(join(tmpdir(), `journey-${name}-`));

  // The shell declares its Remotes, so it cannot be composed without them. They are built
  // here for the same reason the shell is: the journey drives the application the pipeline
  // emits, not a reduced one.
  const declared = /** @type {{ remotes?: Array<{ name: string }> }} */ (
    JSON.parse(await readFile(join(app.dir, 'app.manifest.json'), 'utf8'))
  );
  const remotes = await Promise.all(
    (declared.remotes ?? []).map((remote) =>
      buildRemoteArtifact({
        app,
        name: remote.name,
        outDir: join(temporary, remote.name),
        release: RELEASE,
      }),
    ),
  );

  const built = await buildArtifact({
    app,
    outDir: join(temporary, 'shell'),
    release: RELEASE,
    remotes,
  });
  const security = /** @type {{ csp: string }} */ (built.security);

  const origin = await startArtifactOrigin({
    appDir: app.dir,
    artifactDir: join(String(built.root), String(built.public)),
    entry: String(built.entry),
    csp: security.csp,
    unavailable: null,
    tampered: null,
    // The example's fixture backend takes any username; the password picks the role, and
    // the journey needs one that carries both `inventory:read` and `sales:write`.
    session: { username: 'journey', password: 'admin' },
    mounts: remotes.map((report) => ({
      base: String(report.base),
      dir: join(String(report.root), String(report.public)),
    })),
  });

  return {
    url: origin.url,
    csp: security.csp,
    async close() {
      await origin.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
