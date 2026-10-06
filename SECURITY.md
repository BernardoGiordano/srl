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

Out of scope:

- `srl serve`, which is a development server and binds every interface by
  default. Do not expose it to a network you do not trust.
- the example application's demo backend
- a remote that runs on the shell's origin, which can act as the page by design.
  The [auth guide](docs/guide/auth-and-remotes.md#trust-boundary) explains why.
