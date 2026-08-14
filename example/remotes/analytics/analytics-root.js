/**
 * The analytics remote's root element.
 *
 * Written the way a foreign application would be, not the way this repository writes
 * components: no base class, no signals, no `.html` template, no expression compiler. A
 * plain `HTMLElement`, DOM built by hand, state in ordinary fields, a `render()` that
 * replaces its own subtree, and every subscription torn down by hand in
 * `disconnectedCallback`.
 *
 * That is real ceremony the shell's own components do not pay, and showing the cost is the
 * point: it is what a team on another stack pays to integrate here, they pay it inside
 * their own folder, and the shell is unaffected.
 *
 * Two things it does not do differently, because the contract carries them: translation and
 * authorization. Its strings come from its own bundle merged into the shell's table, and
 * its API calls go through the shell's outbound HTTP path — with the shell's credential
 * attachment, its refresh and its retry. It never sees a token, and it cannot: the context
 * exposes `fetch` and `json` and no way to obtain one.
 *
 * The re-render strategy is the crudest possible: throw the subtree away and rebuild it. No
 * diffing, so nothing here may hold focus or scroll position across a render, and nothing
 * does. A remote at real scale would bring its own renderer, which is exactly what it is
 * allowed to do.
 */

/** @import { HostContext } from '../../../source/lib/core/remotes/types.js' */

/**
 * @typedef {object} ChannelRow
 * @property {string} channel
 * @property {number} orders
 * @property {number} value
 */

/**
 * @typedef {object} Summary
 * @property {string} generatedAt
 * @property {string} currency
 * @property {number} conversion Fraction, not a percentage.
 * @property {ChannelRow[]} byChannel
 */

/** @type {WeakMap<HTMLElement, HostContext>} */
const contexts = new WeakMap();

/**
 * Define the root element and bind one instance to one capability context.
 *
 * Idempotent, because `customElements.define` throws on a duplicate tag and a remote loaded
 * twice by a misconfigured manifest should not take the page down with it.
 *
 * @param {string} tag
 * @param {HostContext} host
 * @returns {HTMLElement}
 */
export function createAnalyticsRoot(tag, host) {
  defineAnalyticsRoot(tag);
  const element = document.createElement(tag);
  contexts.set(element, host);
  return element;
}

/** @param {string} tag */
function defineAnalyticsRoot(tag) {
  if (customElements.get(tag) !== undefined) return;

  customElements.define(
    tag,
    class AnalyticsRoot extends HTMLElement {
      /** @type {Summary | null} */
      #summary = null;

      /** @type {string | null} */
      #error = null;

      #loading = false;

      /** What the last action had to say: a grant refusal, or the export stub. */
      /** @type {string | null} */
      #notice = null;

      /** @type {Array<() => void>} */
      #subscriptions = [];

      connectedCallback() {
        const host = contextFor(this);
        // A custom element can be moved in the DOM, running both callbacks again.
        // Subscribing without clearing first leaves a duplicate listener per move.
        this.#unsubscribe();
        this.#subscriptions = [
          // Sign-in, sign-out, any change of scope: the permission-gated control has to
          // appear and disappear with it.
          host.auth.onChange(() => {
            this.#notice = null;
            void this.#load();
          }),
          // A locale change re-renders from the same data. Nothing is refetched, because
          // the numbers are not localised — only their formatting is.
          host.i18n.onChange(() => {
            this.render();
          }),
        ];

        this.render();
        void this.#load();
      }

      disconnectedCallback() {
        this.#unsubscribe();
      }

      #unsubscribe() {
        for (const dispose of this.#subscriptions) dispose();
        this.#subscriptions = [];
      }

      /** @returns {Promise<void>} */
      async #load() {
        const host = contextFor(this);
        if (host.auth.user() === null) {
          this.#summary = null;
          this.#error = null;
          this.render();
          return;
        }

        this.#loading = true;
        this.#error = null;
        this.render();

        try {
          this.#summary = readSummary(await host.auth.json('/api/analytics/summary'));
        } catch (cause) {
          this.#summary = null;
          this.#error = cause instanceof Error ? cause.message : String(cause);
        } finally {
          this.#loading = false;
          this.render();
        }
      }

      /**
       * Call an API this remote is not granted, on purpose, and show what comes back. The
       * demonstration is the error: the shell refuses before a request is made, and the
       * refusal names the grant that would have to change.
       *
       * @returns {Promise<void>}
       */
      async #probeUngranted() {
        const host = contextFor(this);
        try {
          await host.auth.fetch('/api/users');
          this.#notice = 'The call succeeded, which means the grant check is not working.';
        } catch (cause) {
          this.#notice = cause instanceof Error ? cause.message : String(cause);
        }
        this.render();
      }

      render() {
        const host = contextFor(this);
        /** @type {HostContext['i18n']['t']} */
        const t = (key, params) => host.i18n.t(key, params);
        const locale = host.i18n.locale();
        const user = host.auth.user();
        const permissions = host.auth.permissions();

        const root = el('div', 'space-y-5 p-4 sm:p-6');

        const header = el('header');
        header.append(
          el('p', 'text-[11px] font-semibold uppercase tracking-wider text-muted', t('analytics.remoteLabel')),
          el('h1', 'mt-1 text-[19px] font-bold text-brand', t('analytics.title')),
          el('p', 'mt-1 max-w-3xl text-[13.5px] leading-relaxed text-muted', t('analytics.lead')),
        );
        root.append(header);

        /* ── Identity and permissions, straight from the contract ─────────── */

        const identity = el('div', 'rounded-xl border border-ui-border bg-surface px-5 py-4 text-[13px]');
        identity.append(
          el(
            'p',
            'text-muted',
            user === null
              ? t('analytics.anonymous')
              : t('analytics.signedInAs', { name: user.name, subject: user.subject }),
          ),
        );

        const granted = el('p', 'mt-2 flex flex-wrap items-center gap-2 text-muted');
        granted.append(el('span', '', t('analytics.permissions')));
        if (permissions.length === 0) {
          granted.append(el('span', 'text-muted/70', t('analytics.noPermissions')));
        } else {
          for (const permission of permissions) {
            granted.append(el('code', 'rounded bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink', permission));
          }
        }
        identity.append(granted);
        identity.append(el('p', 'mt-2 text-[11.5px] text-muted', t('analytics.mount', { mount: host.mount })));
        root.append(identity);

        /* ── The data, fetched with the shell's session ───────────────────── */

        const panel = el('div', 'rounded-xl border border-ui-border bg-surface px-5 py-4');

        if (this.#loading && this.#summary === null) {
          panel.append(el('p', 'text-[13px] text-muted', t('analytics.loading')));
        } else if (this.#error !== null) {
          panel.append(el('p', 'text-[13px] font-medium text-rose-700', t('analytics.failed')));
          panel.append(el('p', 'mt-1 break-words font-mono text-[11.5px] text-muted', this.#error));
        } else if (this.#summary === null) {
          panel.append(el('p', 'text-[13px] text-muted', t('analytics.signInFirst')));
        } else {
          const summary = this.#summary;

          const totals = el('dl', 'grid gap-4 sm:grid-cols-3');
          const orders = summary.byChannel.reduce((sum, row) => sum + row.orders, 0);
          const value = summary.byChannel.reduce((sum, row) => sum + row.value, 0);
          totals.append(
            metric(t('analytics.metric.orders'), formatNumber(locale, orders)),
            metric(t('analytics.metric.value'), formatCurrency(locale, value, summary.currency)),
            metric(t('analytics.metric.conversion'), formatPercent(locale, summary.conversion)),
          );
          panel.append(totals);

          // A table built by hand, because this remote has no table component and is not
          // going to import one. Native semantics are free; everything else is not.
          const table = el('table', 'mt-4 w-full text-[13px]');
          const head = el('thead');
          const headRow = el('tr', 'border-b border-ui-border text-start text-[11.5px] uppercase tracking-wide text-muted');
          for (const [label, align] of /** @type {Array<[string, string]>} */ ([
            [t('analytics.column.channel'), 'text-start'],
            [t('analytics.column.orders'), 'text-end'],
            [t('analytics.column.value'), 'text-end'],
            [t('analytics.column.share'), 'text-end'],
          ])) {
            const cell = el('th', `py-2 font-semibold ${align}`, label);
            cell.setAttribute('scope', 'col');
            headRow.append(cell);
          }
          head.append(headRow);
          table.append(head);

          const body = el('tbody');
          for (const row of summary.byChannel) {
            const tr = el('tr', 'border-b border-ui-border/60');
            const name = el('th', 'py-2 text-start font-medium text-ink', t(`analytics.channel.${row.channel}`));
            name.setAttribute('scope', 'row');
            tr.append(
              name,
              el('td', 'py-2 text-end tabular-nums text-ink', formatNumber(locale, row.orders)),
              el('td', 'py-2 text-end tabular-nums text-ink', formatCurrency(locale, row.value, summary.currency)),
              el(
                'td',
                'py-2 text-end tabular-nums text-muted',
                formatPercent(locale, value === 0 ? 0 : row.value / value),
              ),
            );
            body.append(tr);
          }
          table.append(body);
          panel.append(table);

          panel.append(
            el(
              'p',
              'mt-3 text-[11.5px] text-muted',
              t('analytics.updated', { at: formatTime(locale, summary.generatedAt) }),
            ),
          );
        }

        const actions = el('div', 'mt-4 flex flex-wrap gap-2');
        actions.append(
          button(t('analytics.refresh'), 'primary', () => {
            void this.#load();
          }),
        );

        /*
         * The permission gate. `can` answers only about permissions this remote was granted
         * in the manifest, so the button is absent for a session without the write scope —
         * and the remote learns nothing about the user's other entitlements. The server must
         * check it again regardless: this is an affordance, not an authorization decision,
         * and any remote could render the button anyway.
         */
        if (host.auth.can('analytics:write')) {
          actions.append(
            button(t('analytics.export'), 'plain', () => {
              this.#notice = t('analytics.exportStub');
              this.render();
            }),
          );
        }

        actions.append(
          button(t('analytics.probe'), 'plain', () => {
            void this.#probeUngranted();
          }),
        );
        panel.append(actions);
        root.append(panel);

        /* ── Least privilege, demonstrated rather than described ──────────── */

        const note = el('div', 'rounded-xl border border-ui-border bg-canvas px-5 py-4 text-[13px]');
        note.append(el('p', 'text-muted', t('analytics.leastPrivilege')));
        if (this.#notice !== null) {
          note.append(el('p', 'mt-2 break-words font-mono text-[11.5px] text-ink', this.#notice));
        }
        note.append(el('p', 'mt-2 text-[11.5px] text-muted', t('analytics.source')));
        root.append(note);

        this.replaceChildren(root);
      }
    },
  );
}

/**
 * @param {HTMLElement} element
 * @returns {HostContext}
 */
function contextFor(element) {
  const host = contexts.get(element);
  if (host === undefined) {
    throw new Error('<analytics-root> was created without a host context. Use mount(host).');
  }
  return host;
}

/* ── The whole of this remote's rendering library ─────────────────────────── */

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  // textContent, never innerHTML. Every string reaching this function is a translation or a
  // server value, and a remote that interpolates markup is one XSS away from owning the
  // shell's session, which is on the same origin.
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function metric(label, value) {
  const wrapper = el('div');
  wrapper.append(
    el('dt', 'text-[11.5px] uppercase tracking-wide text-muted', label),
    el('dd', 'mt-1 text-[22px] font-bold tracking-tight text-ink', value),
  );
  return wrapper;
}

/**
 * @param {string} label
 * @param {'primary' | 'plain'} tone
 * @param {() => void} onClick
 * @returns {HTMLElement}
 */
function button(label, tone, onClick) {
  const node = el('button', BUTTON_CLASSES[tone], label);
  node.setAttribute('type', 'button');
  node.addEventListener('click', onClick);
  return node;
}

const BUTTON_CLASSES = {
  primary:
    'cursor-pointer rounded-md bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-brand-contrast hover:bg-brand-hover',
  plain:
    'cursor-pointer rounded-md border border-ui-border px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-canvas',
};

/* ── Validation at the deployment boundary ────────────────────────────────── */

/**
 * The response shape is a contract with a service this remote does not deploy with, so it is
 * checked rather than asserted. `host.auth.json` returns `unknown` for exactly this reason:
 * a cast here would turn a renamed field into `NaN` on screen with nothing in the console.
 *
 * @param {unknown} value
 * @returns {Summary}
 */
function readSummary(value) {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The analytics summary response is not an object.');
  }
  const record = /** @type {Record<string, unknown>} */ (value);

  return {
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    currency: typeof record.currency === 'string' ? record.currency : 'EUR',
    conversion: requireNumber(record.conversion, 'conversion'),
    // Cast at the point of iteration rather than into a variable: `Array.isArray` narrows an
    // `unknown` to `any[]`, and an intermediate binding would carry that `any` onwards.
    byChannel: (Array.isArray(record.byChannel)
      ? /** @type {unknown[]} */ (record.byChannel)
      : []
    ).map((row, index) => {
      const entry = /** @type {Record<string, unknown>} */ (row);
      return {
        channel: typeof entry.channel === 'string' ? entry.channel : `#${String(index)}`,
        orders: requireNumber(entry.orders, 'orders'),
        value: requireNumber(entry.value, 'value'),
      };
    }),
  };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The analytics summary field "${field}" is not a finite number.`);
  }
  return value;
}

/**
 * @param {string} locale
 * @param {number} value
 * @returns {string}
 */
function formatNumber(locale, value) {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * @param {string} locale
 * @param {number} value
 * @param {string} currency
 * @returns {string}
 */
function formatCurrency(locale, value, currency) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * @param {string} locale
 * @param {number} value
 * @returns {string}
 */
function formatPercent(locale, value) {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

/**
 * @param {string} locale
 * @param {string} iso
 * @returns {string}
 */
function formatTime(locale, iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { timeStyle: 'medium', dateStyle: 'short' }).format(date);
}
