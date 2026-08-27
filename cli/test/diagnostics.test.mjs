import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  counts,
  error,
  errors,
  formatJson,
  formatText,
  hasErrors,
  info,
  outputFormat,
  report,
  warning,
} from '../diagnostics/index.mjs';
import { REPO } from '../layout.mjs';

/**
 * The reporting seam.
 *
 * Six checks share this module, so what it decides it decides for all of them: how a
 * path is spelled, which severity fails the run, which stream a refusal goes to, and
 * what the JSON document promises a consumer. Each of those is a rule that used to be
 * copied per check. ADR-0072.
 */

void test('a finding carries what it was given, and nothing it was not', () => {
  const found = error('deps/example', 'a message', { group: 'web', line: 12, column: 3 });

  assert.deepEqual(found, {
    severity: 'error',
    code: 'deps/example',
    message: 'a message',
    group: 'web',
    file: null,
    line: 12,
    column: 3,
  });

  // Omitted is null rather than absent, so a consumer reads one shape.
  assert.deepEqual(info('deps/bare', 'passed'), {
    severity: 'info',
    code: 'deps/bare',
    message: 'passed',
    group: null,
    file: null,
    line: null,
    column: null,
  });
});

void test('a path inside the repository is shortened, and one outside is not', () => {
  // The reason this is here and not in each check: six of them had their own `show()`.
  assert.equal(
    error('x', 'y', { file: join(REPO, 'source', 'lib', 'core', 'reactive.js') }).file,
    'source/lib/core/reactive.js',
  );

  // A relative path is the caller's own spelling — an editor seam is handed
  // `fixture.html` and should get it back.
  assert.equal(error('x', 'y', { file: 'fixture.html' }).file, 'fixture.html');

  const outside = '/elsewhere/entirely/file.js';
  assert.equal(error('x', 'y', { file: outside }).file, outside);
});

void test('only an error fails the run', () => {
  const list = [info('a', 'ran'), warning('b', 'partial'), error('c', 'broken')];

  assert.deepEqual(counts(list), { error: 1, warning: 1, info: 1 });
  assert.equal(hasErrors(list), true);
  assert.equal(hasErrors([info('a', 'ran'), warning('b', 'partial')]), false);
  assert.deepEqual(
    errors(list).map((diagnostic) => diagnostic.code),
    ['c'],
  );
});

void test('progress goes to stdout under its group, refusals to stderr', () => {
  const text = formatText(
    [
      info('a', 'the library imports no application code'),
      info('b', 'the map is verbatim', { group: 'web' }),
      warning('c', 'ar.json is 40% translated', { group: 'web' }),
      error('d', 'imports "lit"', { group: 'web', file: 'source/lib/core/x.js', line: 4 }),
      info('e', 'both packages are 0.5.0', { group: 'toolchain' }),
    ],
    { title: 'Verify', summary: 'never printed when something failed' },
  );

  assert.equal(
    text.out,
    [
      'Verify',
      '  ok   the library imports no application code',
      '',
      'web',
      '  ok   the map is verbatim',
      '  note ar.json is 40% translated',
      '',
      'toolchain',
      '  ok   both packages are 0.5.0',
      '',
    ].join('\n'),
  );

  // The group is a heading on stdout and a location on stderr, because the refusal
  // block carries no headings to sit under.
  assert.equal(
    text.err,
    ['', '1 problem(s):', '', '  - source/lib/core/x.js:4: imports "lit"', '', ''].join('\n'),
  );
});

void test('the summary is printed only when nothing failed', () => {
  const passing = formatText([info('a', 'ran')], { summary: 'Everything passed.' });
  assert.match(passing.out, /Everything passed\.\n$/u);
  assert.equal(passing.err, '');

  const failing = formatText([error('a', 'broke')], { summary: 'Everything passed.' });
  assert.equal(failing.out, '');
  assert.match(failing.err, /1 problem\(s\)/u);
});

void test('a refusal with no file is placed by its group', () => {
  const text = formatText([error('a', 'the manifest was refused', { group: 'web' })]);
  assert.match(text.err, /- web: the manifest was refused/u);
});

void test('the JSON document states the verdict rather than implying it', () => {
  const document = JSON.parse(
    formatJson([info('a', 'ran'), warning('b', 'partial'), error('c', 'broken')]),
  );

  assert.equal(document.ok, false);
  assert.deepEqual(document.counts, { error: 1, warning: 1, info: 1 });
  assert.equal(document.diagnostics.length, 3);
  assert.equal(document.diagnostics[2].code, 'c');

  // A warning is reported and is not a refusal, so a run of them is still ok.
  assert.equal(JSON.parse(formatJson([warning('b', 'partial')])).ok, true);
});

void test('--json selects the other adapter, and the exit code is the same either way', () => {
  assert.equal(outputFormat(['node', 'verify.mjs']), 'text');
  assert.equal(outputFormat(['node', 'verify.mjs', '--json']), 'json');

  const list = [info('a', 'ran'), error('b', 'broke')];

  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const push = (/** @type {string[]} */ into) => (/** @type {string} */ text) => void into.push(text);

  assert.equal(report(list, { format: 'json', out: push(out), err: push(err) }), 1);
  assert.equal(err.length, 0, 'a consumer parsing the document wants one stream');
  assert.equal(JSON.parse(out.join('')).ok, false);

  out.length = 0;
  assert.equal(report(list, { format: 'text', out: push(out), err: push(err) }), 1);
  assert.match(err.join(''), /1 problem\(s\)/u);

  assert.equal(report([info('a', 'ran')], { format: 'text', out: push(out), err: push(err) }), 0);
});
