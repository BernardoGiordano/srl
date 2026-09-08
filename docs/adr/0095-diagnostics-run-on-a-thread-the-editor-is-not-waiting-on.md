# ADR-0095: Diagnostics run on a thread the editor is not waiting on

- Status: accepted
- Date: 2026-09-08
- Affects: `cli/language-server/analysis.mjs`, `cli/language-server/validation.mjs`, `cli/language-server/server.mjs`

## Context

ADR-0091 moved scheduling out of protocol dispatch and left one consequence open:
nothing preempted a running typecheck. `checkTemplateSource()` is a single synchronous
compiler call, so the only bound available on the thread that also answers messages was a
clock. A check that overran a 5000 ms budget threw the compiler's own cancellation, and
the retry was issued deliberately without a budget, on the reasoning that a slow project
should be slow rather than silently undiagnosed. That reasoning is right and the
mechanism is wrong: the second attempt is the one that holds the thread for as long as it
takes, so the worst case for a completion is unbounded and arrives exactly on the
pathological template the budget was written for.

The budget also cancels for the wrong reason. Time elapsed is not evidence that an answer
stopped being wanted, and a document whose check is genuinely expensive loses its answer
to the clock repeatedly while nobody touches it.

Two alternatives lost. Yielding more often inside the check is not available: the
compiler call does not return until it is finished, and its cancellation token is polled
at points TypeScript chooses. A separate process, rather than a thread, was rejected
because the overlay traffic is the open buffers of one editor — structured clone across a
thread boundary is cheaper than a serialised pipe, and the failure handling is the same.

## Decision

Diagnostic execution belongs to `analysis.mjs`, which runs it on a worker thread. The
thread is not an interface: callers still ask for the current outcome of an editor
document, and nothing outside the module names a lane, a snapshot or a check id.

`cli/language-server/validation.mjs` is that thread. It holds its own
`SrlLanguageService`, receives overlays as messages and applies them in arrival order, so
a check answers about the text it started from. A new lane starts with no overlays, so
every open buffer is replayed onto it.

Cancellation is a shared integer, not a message: a message is only read between checks. It
holds the highest check the parent has abandoned, and the token the compiler polls
compares its own id against it.

A check is abandoned when its document goes stale under it — an edit, a close, a project
reload — and never on a clock. There is no budget and no unbudgeted retry.

A configuration change ends the lane rather than clearing its cache. `invalidateCompiler()`
discards the parsed `tsconfig.json` on the interactive thread, which still builds a
program of its own for `templateExpressionMembers()`; the validation thread is replaced
outright, because a fresh thread is the same cold rebuild with less state to be wrong
about.

A lane that dies fails its unanswered checks rather than resolving them empty: an empty
diagnostic list reads as "no errors here", which is the one thing a crashed checker has
not established. The next check starts a new lane.

`dispose()` resolves once the lane has exited, so `shutdown` is answered after the
compiler thread is gone rather than before.

## Consequences

There is a second compiler and a second warmup, which ADR-0091 accepted in advance, and
the project model is read once per thread. Cold cost is paid twice; warm cost is paid
where it does not block a keystroke.

A pathological template now occupies only its own thread, for as long as it takes, until
something makes it stale. That is the trade the budget was avoiding, and it is the right
way round: the request that was being starved is no longer on that thread at all.

The interactive thread is not compiler-free. Completion and hover still call
`templateExpressionMembers()`, so a cold completion still pays a program build. That is
the next measurable thing, not this one, and ADR-0044's gate does not yet describe an
interactive workload that could hold it.

Overlay traffic is one message per keystroke carrying the whole document. That is what
makes the lane's answers about the editor's text rather than the disk's, and it is bounded
by the number of open buffers.

This reopens if a lane restart per configuration edit becomes the dominant cost in a
project whose `tsconfig.json` is edited often, or if a measured interactive workload shows
the surviving main-thread program build, rather than validation, is what a completion
waits for.
