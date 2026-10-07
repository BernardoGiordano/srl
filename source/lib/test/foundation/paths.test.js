import { admitPath, admitPathname, destination, within } from '@core/foundation/paths.js';
import { assert } from '../harness.js';

/**
 * Path admission, the one canonical form the manifest, the router, the remote host,
 * the HTTP client and the release target share. ADR-0133.
 *
 * Each row is a spelling some reader takes for a different path than the next one
 * does. The table runs once here, and each caller's suite checks that it reaches
 * this module.
 */

/** @type {ReadonlyArray<[string, string]>} */
const HOSTILE = [
  ['/\\evil.example/x', 'must not contain a backslash'],
  ['//evil.example/x', 'must be a root-relative path'],
  ['evil.example/x', 'must be a root-relative path'],
  ['https://evil.example/x', 'must be a root-relative path'],
  ['/\t/evil.example/x', 'must be same-origin'],
  ['/api#/admin', 'must not contain a fragment'],
  ['/api/../admin', 'must be written in its normal form'],
  ['/api/./admin', 'must be written in its normal form'],
  ['/api/%2e%2e/admin', 'must be written in its normal form'],
  ['/api/.%2E/admin', 'must be written in its normal form'],
  ['/api/</script>', 'must be written in its normal form'],
  ['/..', 'must be written in its normal form'],
  ['/api/..%2f..%2fadmin', 'must not escape a separator or a dot'],
  ['/api/..%2F..%2Fadmin', 'must not escape a separator or a dot'],
  ['/api/%5cadmin', 'must not escape a separator or a dot'],
  ['/api/%2ex', 'must not escape a separator or a dot'],
  ['/api/..;/admin', 'must not contain a dot segment'],
  ['/api/.;x/admin', 'must not contain a dot segment'],
  ['/api//admin', 'must not contain an empty segment'],
  ['/a//b', 'must not contain an empty segment'],
];

describe('path admission', () => {
  it('refuses every spelling one reader takes for another path', () => {
    for (const [path, reason] of HOSTILE) {
      assert.throws(() => admitPath(path, 'value', { query: true }), `value ${reason}`);
    }
  });

  it('returns a canonical path unchanged', () => {
    for (const path of ['/', '/api/', '/api/v1', '/api/v1/', '/a/%20b', '/a;v=1/b', '/a/b.js']) {
      assert.equal(admitPath(path, 'value'), path);
    }
  });

  it('admits a query only when asked to', () => {
    assert.throws(() => admitPath('/api/x?/', 'value'), 'must not contain a query');
    assert.equal(admitPath('/a.js?v=1', 'value', { query: true }), '/a.js?v=1');
  });

  it('refuses what a parsed URL still carries', () => {
    // Parsing resolved the dots. What is left reaches a server that may decode it.
    const origin = 'https://app.example';
    assert.equal(admitPathname(new URL('/api/a/../b', origin), 'request'), '/api/b');
    for (const path of ['/api/..%2fadmin', '/api/..;/admin', '/api//admin']) {
      assert.throws(() => admitPathname(new URL(path, origin), 'request'), 'request must not');
    }
  });

  it('holds a path below a prefix, and not a sibling that shares its characters', () => {
    assert.ok(within('/api/a/', '/api/a/b'));
    assert.ok(within('/api/a', '/api/a/b'));
    assert.ok(within('/api/a', '/api/a'));
    assert.ok(within('/', '/anything'));
    assert.notOk(within('/api/a/', '/api/ab'));
    assert.notOk(within('/api/a', '/api/ab'));
    assert.notOk(within('/api/a/', '/api/a'), 'a grant ending in "/" holds only what is below it');
  });
});

describe('destination', () => {
  const origin = 'https://app.example';

  it('keeps a same-origin URL whole, even when its pathname would parse as an origin', () => {
    const { kind, url } = destination('/.//evil.example/x', origin);
    assert.equal(kind, 'route');
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '//evil.example/x');
  });

  it('names an http or https URL on another origin as external', () => {
    assert.equal(destination('https://other.example/x', origin).kind, 'external');
    assert.equal(destination('//other.example/x', origin).kind, 'external');
  });

  it('refuses every other scheme', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'blob:https://app.example/1', 'file:///etc/passwd']) {
      assert.throws(() => destination(href, origin), 'Only http and https');
    }
  });
});
