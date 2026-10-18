/**
 * Telegram thinking-level helpers: keyboards and chip labels.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PERMANENT_ADMINS = process.env.PERMANENT_ADMINS || 'tester';

const {
  buildToolsKb,
  buildActiveChipsKb,
  addThinkingRow,
  formatActiveTools,
  normalizeThinkingLevel,
  toolLabel,
} = await import('../src/bot.js');
const { InlineKeyboard } = await import('grammy');

const catalog = [
  { id: 'extended_thinking', label: 'Thinking', supported: true },
  { id: 'deep_research', label: 'Deep Research', supported: true },
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

  test('tools keyboard shows the level row under Thinking only while it is on', () => {
    const off = flat(buildToolsKb(catalog, {}, 'medium')).map((b) => b.callback_data);
    assert.ok(!off.some((d) => d.startsWith('think:')));

    const kb = buildToolsKb(catalog, { extended_thinking: true }, 'medium').inline_keyboard;
    assert.equal(kb[0][0].callback_data, 'tool:extended_thinking');
    assert.deepEqual(kb[1].map((b) => b.callback_data), ['think:low', 'think:medium', 'think:high']);
    assert.equal(kb[1][1].text, '✓ Medium');
    assert.equal(kb[2][0].callback_data, 'tool:deep_research');
  });

  test('Thinking chip and summary include the level', () => {
    assert.equal(toolLabel('extended_thinking', 'low'), 'Thinking · Low');
    assert.equal(toolLabel('deep_research', 'low'), 'Deep Research');
    assert.equal(formatActiveTools({ extended_thinking: true }, 'high'), 'Thinking · High');
    const chip = flat(buildActiveChipsKb({ extended_thinking: true }, 'medium'))[0];
    assert.equal(chip.text, '✓ Thinking · Medium ×');
    assert.equal(chip.callback_data, 'chip:extended_thinking');
  });
});
