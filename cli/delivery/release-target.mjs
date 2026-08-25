/**
 * Where a prepared release is going — the half of delivery a repository owns.
 *
 * `prepareRelease()` turns a verified artifact into a transport tree: immutable
 * assets, one versioned release directory, one signed-by-hash report. That much
 * is true of every deployment. A site name, an nginx template, a supervisor
 * program, a database directory that must outlive the release — none of it is,
 * and none of it belongs in a module a second repository is meant to import.
 *
 * A ReleaseTarget carries those facts across the seam. It is opened in two
 * phases because the release id sits between them:
 *
 *   open()    everything knowable before the id — the payload a target adds to
 *             the release, and the `identity` value folded into the hash the id
 *             is derived from. Two deployments that differ in any rendered fact
 *             must differ here, or one id would name two configurations.
 *   render()  everything that needs the id — the configuration files, whose
 *             paths and contents name the versioned release root.
 *
 * `staticTarget()` is the first adapter and ships with the framework: a plain
 * directory tree, no configuration, serveable by any host. The second lives in
 * the repository that owns the deployment. Two adapters is what makes this a
 * seam rather than a parameter.
 */

import { createHash } from 'node:crypto';

/**
 * A file a target adds to the release directory, beside the artifact's own.
 *
 * @typedef {{ path: string, kind: string, bytes: Buffer }} ReleasePayloadFile
 */

/**
 * What the release looks like on the host, once the id exists.
 *
 * @typedef {{
 *   id: string,
 *   remoteRoot: string,
 *   releaseRoot: string,
 *   assetsRoot: string,
 *   artifact: { app: string, commit: string, csp: string, importMapSha256: string },
 * }} ReleaseContext
 */

/**
 * @typedef {{
 *   configurations?: Array<{ path: string, source: string }>,
 *   remote?: Record<string, unknown>,
 * }} ReleaseRendering
 */

/**
 * @typedef {{
 *   identity: unknown,
 *   files?: ReleasePayloadFile[],
 *   render?: (context: ReleaseContext) => ReleaseRendering,
 * }} OpenReleaseTarget
 */

/**
 * @typedef {{
 *   name: string,
 *   app?: string,
 *   remoteRoot: string,
 *   open: () => Promise<OpenReleaseTarget> | OpenReleaseTarget,
 * }} ReleaseTarget
 */

/**
 * A release as a plain directory: `assets/` beside `releases/<id>/`, and nothing
 * generated for a particular server. Any host that can serve two directories and
 * follow a symbolic link can serve this.
 *
 * @param {{ remoteRoot: string, app?: string }} options
 * @returns {ReleaseTarget}
 */
export function staticTarget(options) {
  const remoteRoot = validateAbsolutePath(options.remoteRoot, 'release root');
  return {
    name: 'static',
    app: options.app,
    remoteRoot,
    open: () => ({ identity: { transport: 'static', remoteRoot } }),
  };
}

/**
 * Substitute every `__TOKEN__` in a template, and refuse a template that has one
 * left. A configuration file installed as root with an unresolved token in it is
 * a broken host; a missing token is always a template and a caller that have
 * drifted apart.
 *
 * @param {string} template
 * @param {Map<string, string>} values
 * @param {string} what Names the file in the error.
 * @returns {string}
 */
export function renderTemplate(template, values, what) {
  let output = template;
  for (const [token, value] of values) {
    if (!output.includes(token)) throw new Error(`release:target: ${what} needs ${token}.`);
    output = output.replaceAll(token, value);
  }
  const unresolved = /__[A-Z0-9_]+__/u.exec(output)?.[0];
  if (unresolved !== undefined) {
    throw new Error(`release:target: unresolved token ${unresolved} in ${what}.`);
  }
  return output;
}

/**
 * An absolute path on the host, with no trailing slash.
 *
 * Every value validated here reaches a generated configuration file or an rsync
 * destination, so it is checked where it enters rather than trusted from the
 * environment variable that reached a shell script.
 *
 * @param {string} path
 * @param {string} what
 * @returns {string}
 */
export function validateAbsolutePath(path, what) {
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(path) || path === '/' || path.includes('/../')) {
    throw new Error(`release:target: unsafe ${what} ${path}`);
  }
  return path.replace(/\/$/u, '');
}

/** @param {string} site @returns {string} */
export function validateSite(site) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(site)) {
    throw new Error(`release:target: unsafe site name ${site}`);
  }
  return site;
}

/** @param {number} port @returns {number} */
export function validatePort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`release:target: unsafe API port ${port}`);
  }
  return port;
}

/** @param {string} program @returns {string} */
export function validateProgram(program) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(program)) {
    throw new Error(`release:target: unsafe supervisor program ${program}`);
  }
  return program;
}

/**
 * The http-scope variable prefix for one deployment, from a site or a program
 * name: `app-rehearsal.example.com` and `app-rehearsal` both give
 * `space_rehearsal`.
 *
 * Variable and zone names declared by a site file are http-scoped, so two
 * deployments sharing one prefix are a duplicate declaration `nginx -t` refuses
 * for the whole host — which is what keeps a rehearsal stack from claiming
 * production's requests. And nginx hashes every variable name into
 * `variables_hash_bucket_size`, 64 by default, where a name built from a whole
 * hostname overflows and is reported as `could not build variables_hash` for
 * every site the host loads, not only this one. Both budgets are cheaper to
 * check here than to discover as a refused configuration.
 *
 * @param {string} name
 * @returns {string}
 */
export function nginxScope(name) {
  const scope = (name.split('.')[0] ?? '').replaceAll('-', '_');
  const rendered = `${scope}_cache_control`;
  if (!/^[a-z][a-z0-9_]*$/u.test(scope) || rendered.length > 40) {
    throw new Error(
      `release:target: ${name} yields an unusable nginx variable $${rendered}; use a shorter name.`,
    );
  }
  return scope;
}

/** @param {Buffer | string} bytes @returns {string} */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
