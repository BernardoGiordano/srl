import { t } from '@core/localization/i18n.js';

// A key the shell declares, and one only the remote's bundle declares: a remote loads on
// navigation, so the shell cannot depend on its translations being registered.
export const title = () => t('orders.title');
export const borrowed = () => t('reports.title');
