# ADR-0100: A journey is measured under stated network conditions

- Status: accepted
- Date: 2026-09-09
- Affects: `tools/benchmark/browser.mjs`, `tools/benchmark/node/startup.mjs`, `tools/benchmark/types.d.ts`, `docs/guide/performance.md`

## Context

Every delivery number this harness reports is taken with no network at all.

That is deliberate and it is what makes the numbers repeat:
[ADR-0045](0045-the-benchmark-drives-chrome-directly.md) resolves no host, so a request is
answered by a local server in well under a millisecond.
[ADR-0082](0082-chain-depth-is-the-gated-delivery-fact.md) then had to gate depth rather
than duration, because under zero network a serial chain and a flat one of the same size
report the same milliseconds, the same request count and the same bytes. Its closing line
names the condition that would change that: "a harness that can afford simulated latency.
The moment a round trip costs something measurable and repeatable, depth stops being a
proxy and the duration becomes the fact to gate."

The gap that leaves is not academic. Everything measured here is one page, one action,
zero latency: a cold start to first routed view, a navigation to one lazy route, a table
sort. A person deciding whether to adopt this framework asks a different question — what
does opening the deployed application and getting to a working screen cost — and the
repository had no measurement of that at all. The startup workloads are the closest thing,
and they end at the first view of an unauthenticated shell.

Chrome can price a round trip. `Network.emulateNetworkConditions` adds a fixed latency and
a fixed throughput in the network service, and it applies to the loopback origin this
harness serves. Fixed is the operative word: it is not a network, it is an arithmetic
delay, and it repeats.

## Decision

**A workload may ask for simulated conditions, and pays them on every request.**
`browser.mjs` takes `network` beside `cache` and `init`, and sends
`Network.emulateNetworkConditions` on the page's session before the first navigation.
Absent, nothing is emulated and every existing workload measures exactly what it did
before.

**One journey workload uses it.** `delivery/journey-40ms` opens the built artifact cold,
waits for the real session restore and route guard to settle, then navigates to the first
declared lazy route and waits for its view. The reported duration is one number on the
page's own clock — document start to the destination view on screen — because that is the
thing a user experiences. `signedIn` and `navigation` split it, and `requests`,
`chainDepth`, `encodedBytes` and `latency` say what it was made of and under what.

**The conditions are stated in the workload's own title,** not only in a comment: 40 ms of
added round-trip time, 5 Mbit/s down, 1 Mbit/s up. A number whose conditions live somewhere
else is a number that gets quoted without them.

**It runs on the artifact origin only.** The journey is a claim about the deployed
application, and the source origin ships a browser-side Tailwind compiler and a native
module graph no deployment serves.

**It is not gated yet.** No baseline records it, so it reports as new, and the evidence
module lists it as uncovered rather than letting a green run imply it passed
([ADR-0099](0099-a-performance-claim-carries-its-standing.md)). Recording it is a separate,
deliberate commit on a quiet machine, as baseline discipline requires of every number.

## Consequences

The repository can answer "what does it cost to open this application" with a measurement
instead of an inference. On the machine that produced this record it is about 950 ms to a
working authenticated screen at 40 ms round trip: roughly 815 ms to a settled session and
130 ms for the route, over 91 requests, three deep, 137 KB.

Depth stays the gated delivery fact. The journey's dominant term is depth multiplied by
latency, so the two move together, and the count is still the one that does not change with
the machine. This record does not reopen ADR-0082; it removes the reason that record could
not be reopened, and the gate follows only when a journey baseline exists.

Emulation is not a network. There is no packet loss, no congestion, no TLS handshake, no
DNS, and the server is on the same host — so the number is a floor, and a real deployment
over a real link will be worse. It is stated as conditions rather than as an experience for
exactly that reason.

The cost is about 9 seconds of the local profile and three samples of the ci profile, which
the ceiling in `budgets.json` absorbs. If a second profile is ever wanted — a slow one — it
is another entry with its own stated numbers rather than a parameter somebody forgets to
report.
