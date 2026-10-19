/**
 * Telegram thinking-level helpers: the level lives in the Model picker, not in Tools.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PERMANENT_ADMINS = process.env.PERMANENT_ADMINS || 'tester';

const {
  buildToolsKb,
  buildModelKb,
  buildActiveChipsKb,
  addThinkingRow,
  formatActiveTools,
  normalizeThinkingLevel,
  toolLabel,
} = await import('../src/bot.js');
const { InlineKeyboard } = await import('grammy');

const catalog = [
  { id: 'create_image', label: 'Create Image', supported: true },
  { id: 'create_video', label: 'Create Video', supported: true },
  { id: 'create_music', label: 'Create Music', supported: true },
  { id: 'extended_thinking', label: 'Thinking', supported: true },
  { id: 'google_search', label: 'Search', supported: false },
];

const flat = (kb) => kb.inline_keyboard.flat();

describe('thinking level helpers', () => {
  test('normalizes unknown values to medium', () => {
    assert.equal(normalizeThinkingLevel(undefined), 'medium');
    assert.equal(normalizeThinkingLevel('EXTREME'), 'medium');
    assert.equal(normalizeThinkingLevel('High'), 'high');
  });

  test('level row has Low / Medium / High with the current one ticked', () => {
    const btns = flat(addThinkingRow(new InlineKeyboard(), 'high'));
    assert.deepEqual(btns.map((b) => b.callback_data), ['think:low', 'think:medium', 'think:high']);
    assert.deepEqual(btns.map((b) => b.text), ['Low', 'Medium', '✓ High']);
  });

  test('tools keyboard lists only Create Image / Video / Music', () => {
    const btns = flat(buildToolsKb(catalog, { create_video: true, extended_thinking: true }));
    assert.deepEqual(btns.map((b) => b.callback_data), [
      'tool:create_image',
      'tool:create_video',
      'tool:create_music',
    ]);
    assert.deepEqual(btns.map((b) => b.text), [
      '○ Create Image',
      '✓ Create Video',
      '○ Create Music',
    ]);
  });

  test('model keyboard has Default, the models, then the level row', () => {
    const models = [
      { id: 'flash', display_name: 'Flash', available: true },
      { id: 'pro', display_name: 'Pro', available: false },
    ];
    const rows = buildModelKb(models, 'pro', 'low').inline_keyboard.filter((r) => r.length);
    assert.deepEqual(rows.map((r) => r[0].callback_data), ['model:', 'model:flash', 'model:pro', 'think:low']);
    assert.equal(rows[2][0].text, '✓ Pro (limited)');
    assert.deepEqual(rows[3].map((b) => b.callback_data), ['think:low', 'think:medium', 'think:high']);
    assert.deepEqual(rows[3].map((b) => b.text), ['✓ Low', 'Medium', 'High']);
  });

  test('level row is always present, with no model chosen', () => {
    const rows = buildModelKb([], undefined, undefined).inline_keyboard.filter((r) => r.length);
    assert.equal(rows[0][0].text, '✓ Default');
    assert.equal(rows[1][1].text, '✓ Medium');
  });

  test('chips and summary list only media tools, never Thinking', () => {
    assert.equal(toolLabel('create_music'), 'Create Music');
    assert.equal(formatActiveTools({ create_image: true, extended_thinking: true }), 'Create Image');
    assert.equal(formatActiveTools({ extended_thinking: true }), '(none)');
    assert.equal(buildActiveChipsKb({ extended_thinking: true }), null);
    const chip = flat(buildActiveChipsKb({ create_video: true, extended_thinking: true }))[0];
    assert.equal(chip.text, '✓ Create Video ×');
    assert.equal(chip.callback_data, 'chip:create_video');
  });
});
