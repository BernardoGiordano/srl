import { SignalElement } from '@core/elements/signal-element.js';
import { defineComponent } from '@core/elements/component.js';
import { resource } from '@core/foundation/resource.js';
import { inject } from '@core/foundation/inject.js';
import { num, t } from '@core/localization/i18n.js';
import { UiAvatar } from '@components/shell/ui-avatar.js';

import { AppCard } from '../../ui/app-card.js';
import { AppNotice } from '../../ui/app-notice.js';
import { PEOPLE_SERVICE } from '../../services/people-service.js';

/** @import { Team } from '../../services/people-service.js' */

/**
 * Show the six teams as cards. `t()` selects the right headcount plural for the
 * active locale.
 */
export class TeamsPage extends SignalElement {
  #teams = resource(
    (signal) => inject(PEOPLE_SERVICE).teams(signal).then((result) => result.rows),
    { initial: /** @type {Team[]} */ ([]), lifetime: () => this.lifetime },
  );

  pending = this.#teams.pending;
  failed = this.#teams.failed;

  get teams() {
    return this.#teams.value.value;
  }

  onMount() {
    void this.load();
  }

  load() {
    return this.#teams.reload();
  }

  /** @param {Team} team */
  headcount(team) {
    return t('people.headcount', { count: team.headcount });
  }

  /** @param {Team} team */
  share(team) {
    const total = this.teams.reduce((sum, candidate) => sum + candidate.headcount, 0);
    return total === 0 ? '' : num(team.headcount / total, { style: 'percent', maximumFractionDigits: 0 });
  }
}

await defineComponent({
  tag: 'teams-page',
  element: TeamsPage,
  module: import.meta.url,
  uses: [AppCard, AppNotice, UiAvatar],
});
