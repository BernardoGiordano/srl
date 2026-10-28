import { assert } from '../../lib/test/harness.js';

/**
 * The default palette writes each token once, and the element's `color-scheme` picks the
 * light or dark arm of each pair (ADR-0142). Asserted on computed colours in real Chrome,
 * under the system preference and under each explicit choice, because which arm applies
 * is the cascade's answer.
 *
 * The theme controller is left out. It applies a theme on every change of the system
 * preference, which these tests make, and its inline `color-scheme` would decide the arm
 * before the palette's own rules could. A registered theme is drawn as the controller
 * writes it, which the controller's own suite asserts.
 */

/*
 * The runner's commands module is untyped JavaScript, so it is imported by a specifier
 * the type checker does not follow.
 */
const COMMANDS = /** @type {string} */ (
  '../../../node_modules/@web/test-runner-commands/browser/commands.mjs'
);
const loaded = /** @type {unknown} */ (await import(COMMANDS));
const commands =
  /** @type {{ emulateMedia(media: { colorScheme: 'light' | 'dark' }): Promise<void> }} */ (loaded);

const PALETTE = '/components/theme-default.css';

/** @type {string} */
let source = '';

/** @type {string[]} */
let tokens = [];

/**
 * What `value` computes to as a colour inside `scope`.
 *
 * @param {string} value
 * @param {HTMLElement} [scope]
 */
function colour(value, scope = document.body) {
  const probe = document.createElement('span');
  probe.style.color = value;
  scope.append(probe);
  const answer = getComputedStyle(probe).color;
  probe.remove();
  return answer;
}

/**
 * Every token's colour inside `scope`, by name.
 *
 * @param {HTMLElement} [scope]
 */
function palette(scope) {
  return Object.fromEntries(tokens.map((token) => [token, colour(`var(${token})`, scope)]));
}

/** @param {'light' | 'dark'} scheme */
async function system(scheme) {
  await commands.emulateMedia({ colorScheme: scheme });
}

/** @type {Record<string, string>} */
let light = {};

/** @type {Record<string, string>} */
let dark = {};

before(async () => {
  source = await (await fetch(PALETTE)).text();
  tokens = [...source.matchAll(/(--ui-[\w-]+)\s*:/gu)].map((match) => String(match[1]));

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = PALETTE;
  await new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = reject;
    document.head.append(link);
  });

  await system('light');
  light = palette();
  await system('dark');
  dark = palette();
});

afterEach(async () => {
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.themePreference;
  root.style.colorScheme = '';
  await system('light');
});

describe('the default palette', () => {
  it('writes each token once, in one block', () => {
    assert.ok(tokens.includes('--ui-color-canvas'));
    assert.sameArray([...new Set(tokens)], tokens, 'no token is declared twice');
    assert.notOk(source.includes('prefers-color-scheme'), 'the scheme picks the arm, not a query');
  });

  it('follows the system preference while no theme is chosen', () => {
    assert.equal(getComputedStyle(document.documentElement).colorScheme, 'light dark');
    assert.equal(light['--ui-color-canvas'], 'rgb(244, 244, 245)');
    assert.equal(dark['--ui-color-canvas'], 'rgb(12, 12, 14)');
    assert.equal(dark['--ui-color-sidebar-hover'], light['--ui-color-sidebar-hover']);
  });

  it('lets an explicit choice win in both directions', async () => {
    const root = document.documentElement;

    await system('dark');
    root.dataset.theme = 'light';
    assert.equal(JSON.stringify(palette()), JSON.stringify(light), 'light on a dark system');

    await system('light');
    root.dataset.theme = 'dark';
    assert.equal(JSON.stringify(palette()), JSON.stringify(dark), 'dark on a light system');
  });

  it('resolves a pair inside a colour function', async () => {
    const mixed = 'color-mix(in srgb, var(--ui-color-canvas) 50%, transparent)';
    const lit = colour(mixed);
    await system('dark');
    assert.ok(colour(mixed) !== lit, 'the mix takes the dark arm');
  });

  it('gives a registered dark theme the dark arm of every token it does not list', () => {
    const target = document.createElement('div');
    target.dataset.theme = 'night';
    target.style.colorScheme = 'dark';
    target.style.setProperty('--ui-color-primary', '#4ade80');
    document.body.append(target);

    const night = palette(target);
    target.remove();
    assert.equal(night['--ui-color-primary'], 'rgb(74, 222, 128)');
    for (const token of tokens.filter((name) => name !== '--ui-color-primary')) {
      assert.equal(night[token], dark[token], token);
    }
  });
});
