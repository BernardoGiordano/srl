import assert from 'node:assert/strict';
import test from 'node:test';

import { staticTarget, validateAbsolutePath } from '../delivery/release-target.mjs';

/**
 * A release root reaches an rsync destination and every generated configuration file,
 * so it is admitted in its canonical form or refused. ADR-0133.
 */

void test('a release root is an absolute path in its canonical form', () => {
  assert.equal(validateAbsolutePath('/srv/app', 'release root'), '/srv/app');
  assert.equal(validateAbsolutePath('/srv/app/', 'release root'), '/srv/app');
  assert.equal(validateAbsolutePath('/srv/app.v2/releases', 'release root'), '/srv/app.v2/releases');
  assert.equal(staticTarget({ remoteRoot: '/srv/app/' }).remoteRoot, '/srv/app');
});

void test('a release root that names somewhere else once cleaned up is refused', () => {
  for (const path of ['/', '/..', '/srv/..', '/srv/../etc', '/srv/./app', '/srv/.', '//srv', '/srv//app', 'srv/app', '/srv/app;x', '/srv/a b']) {
    assert.throws(() => validateAbsolutePath(path, 'release root'), /release:target: (unsafe )?release root/u, path);
  }
});
