import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { navigate } from '@core/navigation/router.js';
import { availableLocales, locale, setLocale, t } from '@core/localization/i18n.js';
import { AUTH_SESSION } from '@auth/session.js';

/**
 * The only route available without a session. It passes credentials to
 * `AuthSession.login()`, and the configured store handles the request. In this
 * example, the password chooses a demo role for the scope guards.
 */
export class LoginPage extends SignalElement {
/** Keep the error as a key so language changes update its text. */
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

    // A file input with this name yields no credential.
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
