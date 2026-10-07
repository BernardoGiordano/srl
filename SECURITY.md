# Security policy

## Supported versions

Security fixes go into the latest published minor version of `@srljs/core` and
`@srljs/cli`, which release together.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting, the
"Report a vulnerability" button on the repository's Security tab. Please do not
open a public issue.

Include the affected version, a minimal reproduction and the impact you see. You
will get an acknowledgement, and the fix ships as a new release with a CHANGELOG
entry that credits you unless you prefer otherwise.

## Scope

In scope:

- template escaping, sanitization and the Trusted Types policies
- manifest admission, including the same-origin and integrity rules
- the authentication session and the remote host grants
- the CLI's build, release and check tools
- `srl serve` and the test-runner preset against a page in the developer's own
  browser, such as one that rebinds its hostname to 127.0.0.1, posts across
  sites, or sends text a terminal would act on

Out of scope:

- `srl serve` bound with `--host` to a network you don't trust. Any machine on
  that network can read what it serves.
- the example application's demo backend
- a remote that runs on the shell's origin, which can act as the page by design.
  The [auth guide](docs/guide/auth-and-remotes.md#trust-boundary) explains why.
