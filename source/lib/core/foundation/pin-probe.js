/**
 * The module `pinsEnforced` imports under a deliberately wrong import-map pin. An
 * engine that loads it ignores the page's pins. ADR-0129.
 */

export const probe = true;
