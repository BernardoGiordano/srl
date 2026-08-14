import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { navigate } from '@core/navigation/router.js';
import { availableLocales, locale, setLocale, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

/**
 * The sign-in screen: the only route outside the shell, because it is the only one a
 * visitor with no session may render.
 *
 * What actually happens on submit is worth following, because it is the `bff`
 * strategy end to end and none of it is in this file:
 *
 *   1. `AuthSession.login()` hands the credentials to the store the manifest named.
 *   2. `BffCookieTokenStore` posts them to `/auth/login`, same-origin.
 *   3. The server sets an HttpOnly session cookie and returns a CSRF token plus the
 *      session's identity and scopes. No access token crosses the wire.
 *   4. The store keeps the CSRF token, the session signal gets the identity, and
 *      every later request is authorized by the cookie the browser sends and the
 *      header the store adds.
 *
 * This screen therefore never sees a credential, and neither does anything else in
 * `src/`. Swapping the manifest to `memory` or `dpop` changes no line here.
 *
 * The password picks a role, which is not authentication and is not pretending to be:
 * it is the smallest thing that lets one running server demonstrate three entitlement
 * sets, so the scope guards and `/forbidden` are visible rather than described.
 */
export class LoginPage extends SignalElement {
  /** The message key of the failure, not the sentence: a sentence would not follow a
   * language change once it is in a signal. */
  errorKey = signal('');
  busy = signal(false);

  get localeCode() {
    return locale.value;
  }

  get locales() {
    return availableLocales.value;
  }

  /** @param {Event} event */
  selectLocale(event) {
    if (event.target instanceof HTMLSelectElement) void setLocale(event.target.value);
  }

  /** @param {SubmitEvent} event */
  submit(event) {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    // `FormData.get` returns `string | File | null`, and `String(File)` yields
    // "[object File]". Narrowing rather than stringifying means a file input
    // accidentally named `password` produces an empty value rather than garbage.
    const data = new FormData(form);
    const credentials = { username: readField(data, 'username'), password: readField(data, 'password') };

    this.busy.value = true;
    this.errorKey.value = '';

    void inject(AUTH_SESSION)
      .login(credentials)
      .then(() => navigate('/'))
      .catch(() => {
        this.errorKey.value = 'login.failed';
      })
      .finally(() => {
        this.busy.value = false;
      });
  }

  get errorMessage() {
    return this.errorKey.value === '' ? '' : t(this.errorKey.value);
  }
}

/**
 * @param {FormData} data
 * @param {string} name
 * @returns {string}
 */
function readField(data, name) {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

await defineComponent({ tag: 'login-page', element: LoginPage, module: import.meta.url });
