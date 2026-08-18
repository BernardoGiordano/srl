/**
 * The machine a result came from.
 *
 * A benchmark number without this is not evidence, it is an anecdote. ADR-0037.
 * So every result file carries a full description, and a one-line `profile` that
 * comparisons key on — including the runtime dependency versions, not just the
 * hardware, because a faster median after a Lit upgrade is a different fact from a
 * faster median after an optimisation.
 */

import { createHash } from 'node:crypto';
import { cpus, totalmem, type as osType, release } from 'node:os';

import { readText } from '../layout.mjs';
import { VENDOR } from '../package/interface.mjs';
import { join } from 'node:path';

/** @import { Environment } from './types.js' */

/**
 * @param {{ chrome: string, excludeDependencies?: readonly string[] }} browser
 * @returns {Promise<Environment>}
 */
export async function describeEnvironment(browser) {
  const cores = cpus();
  const dependencies = await vendoredVersions();
  for (const name of browser.excludeDependencies ?? []) delete dependencies[name];

  /** @type {Omit<Environment, 'profile'>} */
  const facts = {
    platform: osType(),
    release: release(),
    arch: process.arch,
    cpu: cores[0]?.model.trim() ?? 'unknown',
    cores: cores.length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    chrome: browser.chrome,
    dependencies,
  };

  return { profile: fingerprint(facts), ...facts };
}

/**
 * A short stable identity for "the same environment". Hashed rather than spelled
 * out because the full description is in the same file two lines below, and a
 * profile is only ever compared for equality.
 *
 * @param {Omit<Environment, 'profile'>} facts
 * @returns {string}
 */
function fingerprint(facts) {
  const parts = [
    facts.platform,
    facts.release,
    facts.arch,
    facts.cpu,
    String(facts.cores),
    String(facts.memoryGiB),
    facts.node,
    facts.chrome,
    ...Object.entries(facts.dependencies)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, version]) => `${name}@${version}`),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * The versions the browser actually runs, read from the vendor provenance file
 * rather than from package.json: node_modules holds types, source/lib/vendor holds
 * the bytes, and this is a measurement of the bytes.
 *
 * @returns {Promise<Record<string, string>>}
 */
async function vendoredVersions() {
  const provenance = JSON.parse(await readText(join(VENDOR, 'provenance.json')));
  /** @type {Record<string, string>} */
  const versions = {};
  for (const entry of provenance.files ?? []) {
    if (typeof entry?.package === 'string' && typeof entry.version === 'string') {
      versions[entry.package] = entry.version;
    }
  }
  return versions;
}
