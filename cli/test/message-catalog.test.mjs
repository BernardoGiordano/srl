import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { errors } from '../diagnostics/index.mjs';
import {
  bundlesFor,
  messageFindings,
  missingMessages,
  readMessages,
  referenceFindings,
  resolveMessage,
  sourceReferences,
  writeMissingMessages,
} from '../message-catalog/index.mjs';
import { readProject } from '../project-model/index.mjs';
import { clearParseCache } from '../project-model/parse.mjs';

/**
 * What a message reference means, over a fixture application rather than this repository.
 *
 * Every case here is one a catalog-against-catalog comparison cannot see. A key
 * written in JavaScript that no bundle declares, the same mistake in markup, a plural
 * family reached through `count` alone, a placeholder a call forgets, a key a remote
 * declares and the shell may not borrow, and a computed key whose entries must not read
 * as abandoned.
 *
 * The fixture is deliberately not compiled or linted, and the exclusions are in
 * tsconfig.json and eslint.config.js. It declares a typo on purpose, and a file that
 * satisfies every static tool cannot also be a file that states one.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/messages', import.meta.url));
const APP = { name: 'app-m', dir: join(FIXTURES, 'app-m') };

/** @returns {Promise<import('../message-catalog/types.js').MessageModel>} */
async function fixtureMessages() {
  clearParseCache();
  const model = await readProject(APP, { roots: [APP.dir] });
  return readMessages(APP, model);
}

/** @param {import('../diagnostics/types.js').Diagnostic[]} found @param {string} code */
function withCode(found, code) {
  return found.filter((diagnostic) => diagnostic.code === code);
}

void test('a key no bundle declares is an error, in JavaScript and in markup', async () => {
  const found = messageFindings(await fixtureMessages());
  const unknown = withCode(found, 'messages/unknown-key');

  assert.deepEqual(
    unknown.map((diagnostic) => `${diagnostic.file ?? ''}:${String(diagnostic.line)}`).sort(),
    [
      'cli/test/fixtures/messages/app-m/src/host.js:6',
      'cli/test/fixtures/messages/app-m/src/page.html:3',
      'cli/test/fixtures/messages/app-m/src/page.js:7',
    ],
    'the same mistake is found in both authored forms, and placed',
  );

  const typo = unknown.find((diagnostic) => diagnostic.message.includes('orders.titel'));
  assert.ok(typo?.message.includes('Did you mean "orders.title"?'), 'the nearest key is named');
});

void test('a finding points at the key, not at the call around it', async () => {
  const found = messageFindings(await fixtureMessages());
  const markup = withCode(found, 'messages/unknown-key').find((diagnostic) =>
    diagnostic.file?.endsWith('page.html'),
  );

  const source = await readFile(join(APP.dir, 'src', 'page.html'), 'utf8');
  const line = source.split('\n')[(markup?.line ?? 1) - 1] ?? '';
  assert.equal(
    line.slice((markup?.column ?? 1) - 1, (markup?.column ?? 1) - 1 + 'orders.greting'.length),
    'orders.greting',
  );
});

void test('a plural family answers a reference that passes count', async () => {
  const messages = await fixtureMessages();
  const plural = messages.references.find((reference) => reference.key === 'cart.items');

  assert.ok(plural?.count, 'count is what selects a variant');
  assert.equal(resolveMessage(messages, plural)?.value, '{count} item');
  assert.equal(
    withCode(messageFindings(messages), 'messages/unknown-key').filter((diagnostic) =>
      diagnostic.message.includes('cart.items'),
    ).length,
    0,
    'no flat cart.items key exists, and the reference still resolves',
  );
});

void test('a placeholder the call does not pass is an error, and count alone is not', async () => {
  const found = messageFindings(await fixtureMessages());
  const missing = withCode(found, 'messages/missing-parameter');

  assert.equal(missing.length, 1);
  assert.ok(missing[0]?.message.includes('{waiting}'));
  assert.equal(withCode(found, 'messages/unused-parameter').length, 0);
});

void test('a remote bundle answers for the remote, and the shell may not borrow from it', async () => {
  const messages = await fixtureMessages();
  const remote = join(APP.dir, 'remotes', 'reports', 'remote-entry.js');
  const shell = join(APP.dir, 'src', 'host.js');

  assert.deepEqual(
    bundlesFor(messages, remote).map((bundle) => bundle.name),
    ['reports', 'application'],
  );
  assert.deepEqual(
    bundlesFor(messages, shell).map((bundle) => bundle.name),
    ['application'],
  );

  const borrowed = withCode(messageFindings(messages), 'messages/unknown-key').find(
    (diagnostic) => diagnostic.file?.endsWith('host.js'),
  );
  assert.ok(borrowed?.message.includes('reports.title'), 'a remote loads on navigation');
});

void test('a key present in a translation and absent from the default locale is an error', async () => {
  const orphans = withCode(messageFindings(await fixtureMessages()), 'messages/orphan-key');

  assert.equal(orphans.length, 1);
  assert.ok(orphans[0]?.message.includes('orders.renamed'));
  assert.ok(orphans[0]?.file?.endsWith('it.json'));
  assert.ok((orphans[0]?.line ?? 0) > 1, 'placed at the line that declares it');
});

void test('a plural variant a language needs and the default locale does not is not an orphan', async () => {
  const orphans = withCode(messageFindings(await fixtureMessages()), 'messages/orphan-key');
  assert.equal(
    orphans.filter((diagnostic) => diagnostic.message.includes('cart.items.many')).length,
    0,
  );
});

void test('a computed key claims its family, and a key named outside a call is not abandoned', async () => {
  const found = messageFindings(await fixtureMessages());
  const unused = withCode(found, 'messages/unused-key').map(
    (diagnostic) => diagnostic.message.split('"')[1],
  );

  assert.ok(!unused.includes('orders.status.open'), 'claimed by t("orders.status." + name)');
  assert.ok(!unused.includes('panels.live'), 'named by a property in src/table.js');
  assert.ok(!unused.includes('ui.table.empty'), 'claimed by standardText("table", name)');
  assert.ok(unused.includes('abandoned'), 'and a key nothing names is still reported');

  const computed = withCode(found, 'messages/computed-key');
  assert.equal(computed.length, 1);
  assert.ok(computed[0]?.message.includes('orders.status.'));
});

void test('an unsaved buffer is checked against the bundles as saved', async () => {
  const messages = await fixtureMessages();
  const model = await readProject(APP, { roots: [APP.dir] });
  const file = join(APP.dir, 'src', 'host.js');

  const edited = [
    "import { t } from '@core/localization/i18n.js';",
    '',
    "export const title = () => t('orders.ttle');",
  ].join('\n');

  const references = await sourceReferences(model, file, edited);
  assert.deepEqual(
    references.map((reference) => reference.key),
    ['orders.ttle'],
    'the buffer is read, not the file',
  );

  const found = referenceFindings(messages, references);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.code, 'messages/unknown-key');
  assert.equal(found[0]?.line, 3);
  assert.equal(
    withCode(found, 'messages/unused-key').length,
    0,
    'one file cannot answer a question about every file',
  );
});

void test('extraction adds the missing keys and leaves every existing line alone', async () => {
  const messages = await fixtureMessages();
  const bundle = messages.bundles.find((candidate) => candidate.name === 'application');
  const path = bundle?.defaultPath ?? '';
  const before = await readFile(path, 'utf8');

  try {
    const missing = missingMessages(messages);
    assert.deepEqual(
      missing.map((entry) => ({ bundle: entry.bundle.name, keys: entry.keys })),
      [
        { bundle: 'application', keys: ['orders.greting', 'orders.titel', 'reports.title'] },
      ],
      'the nearest bundle owns the key, and the remote answered its own reference',
    );

    const written = await writeMissingMessages(messages);
    assert.deepEqual(
      written.map((entry) => entry.added),
      [['orders.greting', 'orders.titel', 'reports.title']],
    );

    const after = await readFile(path, 'utf8');
    const document = JSON.parse(after);
    assert.equal(document.orders.titel, 'orders.titel', 'the key is its own message until written');
    assert.equal(document.orders.title, 'Orders', 'and every existing message is untouched');
    assert.equal(document.reports.title, 'reports.title', 'a new parent is created once');
    assert.ok(after.includes('"$comment"'), 'notes survive an extraction');
    for (const line of before.split('\n')) {
      if (line.trim() === '' || line.trim() === '},') continue;
      assert.ok(after.includes(line), `extraction rewrote: ${line}`);
    }

    const again = await fixtureMessages();
    assert.equal(
      withCode(messageFindings(again), 'messages/unknown-key').length,
      0,
      'and running it twice adds nothing',
    );
    assert.deepEqual((await writeMissingMessages(again)).length, 0);
  } finally {
    await writeFile(path, before, 'utf8');
  }
});

void test('a message reference is an error only when a source names one', async () => {
  const found = messageFindings(await fixtureMessages());
  assert.equal(
    errors(found).every((diagnostic) => diagnostic.code.startsWith('messages/')),
    true,
  );
  assert.equal(withCode(found, 'messages/references').length, 1, 'the run says it ran');
});

void test('the placeholder grammar is the runtime’s', async () => {
  const runtime = await readFile(
    fileURLToPath(new URL('../../source/lib/core/localization/i18n.js', import.meta.url)),
    'utf8',
  );
  const module = await readFile(
    fileURLToPath(new URL('../message-catalog/index.mjs', import.meta.url)),
    'utf8',
  );

  const pattern = /const PLACEHOLDER = (.+);/u;
  assert.equal(
    pattern.exec(module)?.[1],
    pattern.exec(runtime)?.[1],
    'the two implementations of `{name}` must read the same',
  );
});
