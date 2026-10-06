/**
 * Map an order status to a badge tone. The list and the detail screen share it,
 * so a status reads the same colour on both.
 *
 * @param {string} status
 * @returns {'neutral' | 'info' | 'good' | 'bad'}
 */
export function orderStatusTone(status) {
  switch (status) {
    case 'shipped':
    case 'invoiced':
      return 'good';
    case 'cancelled':
      return 'bad';
    case 'confirmed':
      return 'info';
    default:
      return 'neutral';
  }
}
