export function formatDate(value) {
  return String(value);
}

const money = (value) => String(value);

registerTemplateGlobals({ formatDate, currency: money });
