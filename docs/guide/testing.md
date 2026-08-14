# Writing a test here

Rules the suites already learned. They are cheap to follow and expensive to
rediscover:

- **Await `settled`, never a frame.** `source/lib/test/harness.js` exposes it; a
  navigation is awaited through `navigate()` or `navigationSettled`. No suite sleeps.
- **Cross the interface an application crosses.** `AppRouter` is not exported, so a
  router test attaches a router. A test that reaches past the interface passes
  against a seam nothing else uses.
- **No mock module loader, no transform.** The runner serves the same three mounts
  the application does. Import through the import map, never by relative path into
  another mount: module identity is URL identity, and two URLs for `inject.js` are
  two injectors.
- **Configure the memory storage adapter** (`createMemoryStorage()`, [preference persistence](preferences.md)) so cases
  cannot inherit each other's preferences or leave any in the browser.
- **Install the collection's text resolver in `beforeEach`, and do not restore it
  while elements are still mounted** — a mounted element re-resolves its own strings,
  so restoring the resolver first makes an unrelated case fail in the teardown of
  this one.
- **A framework suite may not read an application's files.** `source/lib/test/`
  ships its own fixtures under `test/fixtures/`, because the runner mounts whichever
  application is under test at `/`.
