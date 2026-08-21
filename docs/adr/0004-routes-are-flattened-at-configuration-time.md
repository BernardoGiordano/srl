# ADR-0004: Routes are flattened at configuration time

- Status: accepted
- Date: 2026-08-12
- Affects: `source/lib/core/navigation/router.js`

## Context

Routes are authored as a tree, because that is how layouts nest. A URL has to be matched
against that tree, and there are two places to do it: descend the tree once per
navigation, or flatten it once at configuration time into one compiled matcher per leaf,
each carrying the chain of routes from the root down to itself.

A tree-walking matcher has to invent a rule for a case the author never wrote down:
whether a parent whose children all failed to match is itself a match. Every answer is
surprising to somebody, and "first match wins" stops meaning what it says, because
"first" depends on traversal order rather than on document order.

## Decision

The route tree is flattened when the router is attached. Matching is one pass over a flat
list of compiled regular expressions, first match wins, and a parent is unmatchable on
its own unless it has a child whose path is `''`.

Flattening is also where the two configuration errors are detected — a route a URL could
never reach, and a duplicate — so they are reported to whoever attached the router, at
startup, rather than at the first navigation that quietly finds nothing.

## Consequences

Matching is linear in the number of leaves. Matching the last of 1,000 routes measures
0.3 ms, so nothing product-visible fails today, and the flattened table is exactly where
a segment index or a trie would go when a measured budget says so. Because no caller can
see how a URL was matched — only which route answered — that change costs no caller and
no test.

Duplicate parameter names across levels resolve to the deepest one, which is the level
whose URL segment the reader is looking at.

Reopen when a measured route budget fails, not for symmetry with a framework that indexes
by default.
