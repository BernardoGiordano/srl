# ADR-0071: A built template is fetched by the component that needs it

- Status: accepted
- Date: 2026-08-26
- Affects: `cli/delivery/build.mjs`

## Context

The artifact build emitted two copies of every template: one hash-named file each, and one
`templates-<hash>.json` holding all of them. It then pointed the runtime manifest at the
bundle, which made the `templates` startup step mandatory in every built artifact — one
request, blocking, for the markup of every component in the application, before the first
component module could load.

For an application of twelve templates that is a good trade. For a real one it inverts:
the shell and the landing route need three or four templates, and the visitor pays for
fifty. The application measured above shipped 77 KiB of JSON, of which a first paint used
under a fifth, and the bundle URL was fetched with `cache: no-cache` because the
non-artifact bundle it was designed for is a mutable `/templates.json`.

Meanwhile the per-template files were already there, already hash-named, already
`Cache-Control: immutable`, and already the URL each `defineComponent` names after the
build's template transform. They were described as fallbacks. They were the better
delivery all along.

## Decision

Split delivery is the default: one immutable file per template, fetched by the component
that names it, when its chunk loads. No bundle is emitted, and the emitted manifest carries
no `templateBundle` — a key the source manifest sets by hand is *removed* rather than
passed through, since a manifest naming a file the artifact does not contain buys a wasted
round trip on every load.

`--templates bundle` restores the old shape for the case that motivated it in the first
place: a link where a round trip costs more than the bytes. It is a build flag rather than
a manifest field because it is a property of a deployment, not of an application.

A Remote's descriptor carries `templates` only under bundle delivery, for the same reason:
split templates are fetched by the Remote's own components from the Remote's own base, so
there is nothing for the shell to preload and nothing to pin.

## Consequences

A visitor downloads the markup of the routes they open. Each template is one immutable
file, so a template that did not change is not re-fetched after a deploy that changed
another — which the single bundle, keyed by the hash of all of them, could never offer.

The cost is one request per component rather than one per application, which on HTTP/2
overlaps with the chunk that triggered it. An application whose users are on high-latency
links, or that wants its whole markup in one warm cache entry, asks for `--templates
bundle` and gets exactly what it got before.

**Both of the paragraphs above were revised by
[ADR-0081](0081-the-manifest-names-every-template.md), which measured them.** They do not
overlap: a component's template URL is not known until its own module has arrived, so nine
components in one chunk are nine round trips in a row. The manifest now names every template
and startup starts them all, which closes that chain — and means a visitor downloads all of
an application's markup rather than only the routes they open. The delivery this record
decided is unchanged; what it says the delivery costs is not. The behaviour decided here
remains available in full, as `--templates split-lazy`.

Split templates carry no subresource integrity, where the bundle recorded a `sha384` in a
Remote's asset list. They are same-origin ([ADR-0012](0012-every-manifest-url-is-same-origin.md))
and content-addressed by name, and `fetch` of a document cannot be pinned the way a
`<script>` can; a template arriving over a compromised origin is not the threat the asset
pins were protecting against, since the shell's own modules arrive from there too.

The artifact report describes what was emitted: `templates.delivery`, `templates.bundle`
(`null` under split), `templates.count`, `templates.bytes`, and `templates.files` — the
list every verification walks.
