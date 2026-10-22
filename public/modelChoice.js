/** Model menu labels shared by the Telegram bot and the Mini App. */

export const UNRELIABLE_MODEL_IDS = new Set(['gemini-flash', 'gemini-pro']);

export function isUnreliableModel(model) {
  const id = String(model?.id || model?.name || '').trim().toLowerCase();
  return UNRELIABLE_MODEL_IDS.has(id);
}

export function defaultModelName() {
  return 'Default (recommended)';
}

export function defaultModelLabel(selected) {
  return `${selected ? '✓ ' : ''}${defaultModelName()}`;
}

export function modelOptionName(model) {
  const name = model?.display_name || model?.id || 'Model';
  const limited = model?.available ? '' : ' (limited)';
  const unreliable = isUnreliableModel(model) ? ' · unreliable' : '';
  return `${name}${limited}${unreliable}`;
}

export function modelOptionLabel(model, selected) {
  return `${selected ? '✓ ' : ''}${modelOptionName(model)}`;
}
