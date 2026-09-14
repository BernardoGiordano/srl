# ADR-0118: A record keyed by outside data has no prototype

- Status: accepted
- Date: 2026-09-14
- Affects: `source/lib/core/localization/i18n.js`, `source/lib/core/remotes/manifest-policy.js`, `source/lib/core/http/client.js`, `source/lib/core/forms/group.js`, `source/lib/test/localization/i18n.test.js`, `source/lib/test/remotes/manifest-policy.test.js`, `source/lib/test/http/client.test.js`, `source/lib/test/forms/forms.test.js`

## Context

Issue #5 asked for protection against prototype pollution. Template expressions already
have it. `FORBIDDEN_MEMBERS` in `core/template/dialect.js` refuses `__proto__`,
`constructor` and `prototype` on every member operation, and `UNRESOLVABLE_NAMES` keeps an
identifier off `Object.prototype`. The lifecycle names the issue also mentions are
[ADR-0115](0115-a-field-may-not-hide-a-method.md)'s. What had no rule was the runtime's own
code, wherever it builds or reads a plain object with keys it did not write.

`JSON.parse` turns `"__proto__"` into an ordinary own key. When such a key meets a plain
object, two things go wrong.

- **A write goes to the setter.** `record[key] = value` with a key of `__proto__` calls
  `Object.prototype.__proto__`. An object value replaces the record's prototype, a string
  is discarded, and in both cases the entry never lands.
- **A read finds an inherited member.** `record[key]` with `constructor`, `toString` or
  `__proto__` returns something from `Object.prototype` that the data never declared.

Nothing in the runtime merges recursively, so no document could reach `Object.prototype`
itself. The damage stayed inside one record. It was still silent, and one of the sites is
admission code that exists to refuse a bad document.

| Site | Keys come from | What went wrong |
|---|---|---|
| `admitTemplateGroups` | the manifest | A group named `__proto__` became the record's prototype, and left the record and the derived `templateFiles` union without a refusal |
| The message tables in `i18n.js` | bundles, and the caller of `t` | `t('constructor')` returned a function, and `t('toString', params)` threw inside `interpolate` |
| `ApiError.fields` | a 422 body | A `__proto__` code was dropped, and `fields.constructor` was a function |
| `FormGroup.patch` | a payload, often a response body | `patch({ constructor: 'x' })` threw, because `fields.constructor` is `Object` and has no `fill` |

**Rejected: refusing the dangerous names at each site.** A list of names suits the template
dialect, which answers whether an expression may say something at all. Here the list would
have to track `Object.prototype` and would still refuse a key that is legitimate data.
`cli/message-catalog/` reads bundles into a `Map`, where `__proto__` is a key like any
other, so refusing it at runtime would make the checker and the runtime disagree.

**Rejected: `Map` for these records.** `AppManifest.templateGroups`, `ApiError.fields` and
`messageTable` are published shapes that applications read with property access. A `Map`
would change the interface to fix a lookup.

**Rejected: `Object.hasOwn` at every read.** It is the right answer where the author owns
the object and only the key is data, which is why `FormGroup.leafAt` already used it. For a
record the runtime builds and hands out, it would be a guard every consumer has to
remember, application code included.

## Decision

**A record the runtime builds from keys it did not author has no prototype.** It is created
with `Object.create(null)`, so writing any key defines that key, and reading a key the data
never held gives `undefined`. This covers the template groups, every message table in
`i18n.js`, and `ApiError.fields`.

**A record the author supplies is read through its own keys when the key is data.**
`FormGroup.patch` checks `Object.hasOwn(this.fields, name)` before it fills, as `leafAt`
does before it resolves a path.

Three sites stay as they are.

- `admitBundleFiles` checks every key against the URLs the admitted patterns resolve to,
  so no key can be a name `Object.prototype` carries.
- Router parameters are named by route definitions, which the author writes.
- `createElement` assigns `props` with `Object.assign`, because each value has to go
  through the element's setter. Props are the author's objects, and an object literal's
  `__proto__` sets a prototype rather than creating an own key.

## Consequences

A record with no prototype has no `hasOwnProperty`, `toString` or `valueOf`. Property
access, `Object.keys`, `Object.entries`, spread and `JSON.stringify` behave as before.
`record.hasOwnProperty(key)` throws, and so does interpolating the record into a string.
`messageTable` is exported, so a consumer that calls a prototype method on the table has to
switch to `Object.hasOwn`.

The runtime now agrees with `cli/message-catalog/` about a bundle key named `__proto__`,
and both keep it as a message. The standard-text resolver in
`source/components/internal/text.js` reads `messageTable` directly and gets the same
answer without a change.

**What would reopen it:** a consumer with a real need to call a prototype method on one of
these records. Or an application that hands a parsed response to `createElement` as
`props` unchanged, which would bring that site under the rule. A new site that builds a
record from outside keys follows the rule rather than reopening it.
