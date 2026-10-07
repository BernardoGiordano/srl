# Signals, services and HTTP

A component holds its state in signals, gets its services from the injector,
and reaches the API through one HTTP client. All three come from `@srljs/core`.

## Signals

`signal`, `computed`, `effect`, `untracked` and `batch` follow Angular's names.
A signal is read and written through `.value`.

```js
import { computed, signal } from '@srljs/core';

const count = signal(0);
const doubled = computed(() => count.value * 2);

count.value += 1;
doubled.value; // 2
```

Calling a signal as `count()` is a TypeError, and `if (count)` is always true
because a signal is an object. Write `if (count.value)`.

A template unwraps signals, so `{{ count }}` renders the number when `count` is a
signal field. A getter that reads `.value` works the same way, and keeps the
signal private.

```js
export class CounterBox extends SignalElement {
  #count = signal(0);

  get count() {
    return this.#count.value;
  }

  increment() {
    this.#count.value += 1;
  }
}
```

The element renders again when a signal its template read changes. `&panel` in
a binding passes the signal itself, unread, to an input that expects one.

`effect()` runs again whenever a signal it read changes, and returns a function
that stops it. Stop it when the element disconnects, for example from the
`lifetime` signal.

```js
onMount() {
  const stop = effect(() => console.log(this.#count.value));
  this.lifetime.addEventListener('abort', stop, { once: true });
}
```

`untracked(() => …)` reads without subscribing, and `peek(source)` reads one
signal that way. `batch(() => …)` applies several writes as one change.

For one asynchronous read, use `resource()`, which the
[component guide](components.md#reading-asynchronous-data) describes.

## Services and injection

The injector has one root scope. A typed token names a service, `provide`
registers how to build it, and `inject` returns the one instance, built on first
use.

```js
import { inject, provide, token } from '@srljs/core';

/** @type {import('@core/foundation/types.js').InjectionToken<OrderService>} */
export const ORDER_SERVICE = token('OrderService');

provide(ORDER_SERVICE, () => new OrderService(inject(API_CLIENT)));

const orders = inject(ORDER_SERVICE);
```

The token's type comes from `@core/foundation/types.js`, because hand-written
types are reached by their path.

Register services in the `providers` hook of [startup](startup.md), so they
exist before the root mounts. `provide` again replaces the provider and drops a
built instance, which is how a test swaps a service in `beforeEach`. `inject`
throws for a token with no provider, and names the cycle when two services need
each other.

## The HTTP client

`ApiClient` sends JSON to one base URL through a transport the application
chooses.

```js
import { API_CLIENT, ApiClient, provide } from '@srljs/core';

provide(API_CLIENT, () => new ApiClient('/api', { fetch: globalThis.fetch }));
```

The transport decides who the request is sent as. `globalThis.fetch` sends it
anonymously. `sessionFetch` from `@srljs/core` sends it as the signed-in user
through the `AuthSession`, and a remote passes `host.auth.fetch`. A suite passes
a function that records each call.

| Method | Request |
|---|---|
| `get(path, query, signal)` | A GET. Identical GETs in flight share one request, and `signal` cancels only its own caller. |
| `post(path, body)`, `put`, `patch` | The body as JSON. |
| `delete(path)` | A DELETE with no body. |
| `streamUrl(path, query)` | The URL alone, for an `EventSource`. |

The query drops `undefined` values and repeats array values. A path that
resolves outside the base URL, such as `/../admin` or `//host/x`, rejects
before anything is sent.

A failed response throws `ApiError`. It carries `status`, `path`, the parsed
`body` and a `code`, read from `{ "error": "code" }` by default. `forbidden` is
true for a 403. `fields` holds the per-field codes of a 422, such as
`{ email: 'taken' }`, so a form can show the message under that input. An API
with another error shape passes `errorCode(status, body)` as an option.

```js
try {
  await inject(API_CLIENT).post('/customers', draft);
} catch (cause) {
  if (cause instanceof ApiError && cause.status === 422) showFieldErrors(cause.fields);
  else throw cause;
}
```
