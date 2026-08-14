import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { signal } from '@core/foundation/reactive.js';
import { inject } from '@core/foundation/inject.js';
import { num, t } from '@core/localization/i18n.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Team } from '../../services/people-service.js' */

/**
 * Teams: six cards, and one plural.
 *
 * `t('people.headcount', { count })` selects a plural category through
 * `Intl.PluralRules` for the active locale, so English resolves `one`/`other` and Arabic
 * resolves `zero`/`one`/`two`/`few`/`many`/`other` from the same call and the same key.
 * That is the whole reason counts go through `t()` here rather than being concatenated
 * with a label.
 */
export class TeamsPage extends SignalElement {
  rows = signal(/** @type {readonly Team[]} */ ([]));
  failed = signal(false);

  /** @type {AbortController | undefined} */
  #request;

  get pending() {
    return this.rows.value.length === 0 && !this.failed.value;
  }

  get teams() {
    return this.rows.value;
  }

  onMount() {
    void this.load();
  }

  onDestroy() {
    this.#request?.abort();
    this.#request = undefined;
  }

  async load() {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed.value = false;

    try {
      const result = await inject(PEOPLE_SERVICE).teams(request.signal);
      if (request.signal.aborted) return;
      this.rows.value = result.rows;
    } catch {
      if (!request.signal.aborted) this.failed.value = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }

  /** @param {Team} team */
  headcount(team) {
    return t('people.headcount', { count: team.headcount });
  }

  /** @param {Team} team */
  share(team) {
    const total = this.rows.value.reduce((sum, candidate) => sum + candidate.headcount, 0);
    return total === 0 ? '' : num(team.headcount / total, { style: 'percent', maximumFractionDigits: 0 });
  }
}

await defineComponent({
  tag: 'teams-page',
  element: TeamsPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiAvatar],
});
