'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeChatText,
  applyCustomReadings,
  composeChatMessage
} = require('../src/text-normalizer');

test('common laughter has natural readings and long runs are capped', () => {
  for (const input of ['w', 'ｗ']) {
    assert.equal(normalizeChatText(input), 'わら', input);
  }
  for (const input of ['ww', 'www', 'ｗｗｗ', 'WWW', 'wＷｗW', 'w'.repeat(2000)]) {
    assert.equal(normalizeChatText(input), 'わらわら', input.slice(0, 40));
  }
  assert.equal(normalizeChatText('W'), 'W');
  assert.equal(normalizeChatText('それは無理w'), 'それは無理わら');
  assert.equal(normalizeChatText('ほんとwwwそれな'), 'ほんとわらわらそれな');
  assert.equal(normalizeChatText('(笑)'), 'わら');
  assert.equal(normalizeChatText('（笑）'), 'わら');
  assert.equal(normalizeChatText('(笑笑)'), 'わらわら');
});

test('laughter does not consume ordinary words, identifiers, units, or keyboard controls', () => {
  for (const input of [
    'news', 'wow', 'snow', 'NewWorld', 'IDwww42', '300w', '300W',
    'wキー', 'wを押す', 'WASD', 'Shift+w', 'W+A', 'キーはw', '前進キーはwです'
  ]) {
    const output = normalizeChatText(input);
    assert.ok(!output.includes('わら'), `${input} -> ${output}`);
  }
  assert.equal(normalizeChatText('news'), 'news');
  assert.equal(normalizeChatText('wow'), 'wow');
  assert.equal(normalizeChatText('300w'), '300w');
});

test('numeric applause is limited to a complete chat reaction', () => {
  assert.equal(normalizeChatText('8888'), 'パチパチ');
  for (const input of ['8888!', '8888。', '88888888']) {
    assert.ok(normalizeChatText(input).includes('パチパチ'), input);
  }
  for (const input of ['88', '8888円', 'ID8888', '090-8888-1234', '8888人参加']) {
    const output = normalizeChatText(input);
    assert.ok(!output.includes('パチパチ'), `${input} -> ${output}`);
  }
});

test('URL and email contents cannot be altered by built-in or custom slang', () => {
  for (const input of [
    'https://www.example.com/www?q=w',
    'http://example.com/WT/GG',
    'www.example.com'
  ]) {
    assert.equal(normalizeChatText(input), 'ユーアールエル', input);
    assert.equal(normalizeChatText(input, { dictionary: { w: 'くさ', www: '笑い' } }), 'ユーアールエル', input);
  }
  assert.equal(normalizeChatText('www@example.com'), 'メールアドレス');
  assert.equal(normalizeChatText('w@example.com', { dictionary: { w: 'くさ' } }), 'メールアドレス');
  assert.equal(normalizeChatText('ｗｗｗ.example.com'), 'ユーアールエル');
  assert.equal((normalizeChatText('www.example.comとwww.test.co.jp').match(/ユーアールエル/g) || []).length, 2);
});

test('inline and fenced code do not get slang or custom-dictionary expansion', () => {
  assert.equal(normalizeChatText('`www`'), 'www');
  assert.equal(normalizeChatText('`WT`', { profile: 'black_desert' }), 'WT');
  assert.equal(normalizeChatText('`www`', { dictionary: { www: '笑い' } }), 'www');
  assert.equal(normalizeChatText('```js\nconst w = "www";\n```'), 'コード');
  const mixed = normalizeChatText('`www` w');
  assert.equal(mixed, 'www わら');
});

test('Discord syntax becomes short labels without speaking IDs or internal emoji names', () => {
  for (const input of ['<@123456789012345678>', '<@!123456789012345678>', '<@&123456789012345678>']) {
    assert.equal(normalizeChatText(input), 'メンション', input);
  }
  assert.equal(normalizeChatText('<#123456789012345678>'), 'チャンネル');
  assert.equal(normalizeChatText('<:www:123456789012345678>'), '絵文字');
  assert.equal(normalizeChatText('<a:WT:123456789012345678>'), '絵文字');
});

test('custom readings win once, using the longest original match', () => {
  const dictionary = { foobar: 'foo', foo: 'bar', bar: 'baz' };
  assert.equal(applyCustomReadings('foobar foo bar', dictionary), 'foo bar baz');
  assert.equal(normalizeChatText('foobar foo bar', { dictionary }), 'foo bar baz');
  assert.equal(normalizeChatText('GG', { dictionary: { GG: 'おつかれ' } }), 'おつかれ');
  assert.equal(normalizeChatText('hello', { dictionary: { hello: 'www' } }), 'www');
  assert.equal(normalizeChatText('hello', { dictionary: { hello: 'WT' }, profile: 'black_desert' }), 'WT');
  assert.equal(applyCustomReadings('hello', { '': '不正', hello: 'やあ' }), 'やあ');
  assert.equal(normalizeChatText('hello', { dictionary: { '': '不正', hello: 'やあ' } }), 'やあ');
});

test('custom laughter respects token boundaries in message text', () => {
  const dictionary = { w: 'くさ' };
  assert.equal(normalizeChatText('w', { dictionary }), 'くさ');
  assert.equal(normalizeChatText('www', { dictionary }), 'くさくさ');
  assert.equal(normalizeChatText('それw', { dictionary }), 'それくさ');
  for (const input of ['news', 'wow', '300w', 'wキー', 'Shift+w']) {
    assert.ok(!normalizeChatText(input, { dictionary }).includes('くさ'), input);
  }
  assert.equal(normalizeChatText('www', { dictionary: { w: 'くさ', www: '大笑い' } }), '大笑い');
});

test('speaker names remain literal unless explicitly registered in the custom dictionary', () => {
  assert.equal(composeChatMessage({ speaker: 'www', content: 'w' }), 'www、わら');
  assert.equal(composeChatMessage({ speaker: 'WT', content: 'w', profile: 'black_desert' }), 'WT、わら');
  assert.equal(composeChatMessage({ speaker: 'www', content: 'w', speakName: false }), 'わら');
  assert.equal(composeChatMessage({
    speaker: '家名', content: 'w', dictionary: { 家名: 'なまえ', w: 'くさ' }
  }), 'なまえ、くさ');
  // Explicit name dictionaries retain literal replacement, unlike chat laughter rules.
  assert.equal(applyCustomReadings('NewUser', { w: 'ふ' }), 'NeふUser');
});

test('Black Desert class expansions require the selected profile or clear game context', () => {
  assert.ok(normalizeChatText('WT', { profile: 'black_desert' }).includes('ウィッチ'));
  assert.ok(normalizeChatText('WZ', { profile: 'black_desert' }).includes('ウィザード'));
  assert.ok(normalizeChatText('覚醒WTで拠点戦').includes('ウィッチ'));
  assert.ok(!normalizeChatText('WT', { profile: 'general' }).includes('ウィッチ'));
  assert.ok(!normalizeChatText('WZ', { profile: 'general' }).includes('ウィザード'));
  assert.ok(!normalizeChatText('WT').includes('ウィッチ'));
  for (const input of ['伝承文化 WT', '覚醒剤 WZ', '`黒い砂漠` WT']) {
    assert.equal(normalizeChatText(input), normalizeChatText(input, { profile: 'general' }), input);
  }
  for (const input of ['snapshot', 'class', 'party', 'LOWZ', 'WTest']) {
    const output = normalizeChatText(input, { profile: 'black_desert' });
    assert.ok(!output.includes('ウィッチ') && !output.includes('ウィザード'), `${input} -> ${output}`);
  }
});

test('emoji modifiers remain attached and unsupported compound emoji are preserved', () => {
  assert.equal(normalizeChatText('👍🏽'), normalizeChatText('👍'));
  assert.equal(normalizeChatText('👏🏻'), normalizeChatText('👏'));
  assert.equal(normalizeChatText('❤️'), normalizeChatText('❤'));
  // A partial dictionary match must not leave a selector, skin tone, or ZWJ stranded.
  assert.equal(normalizeChatText('❤️‍🔥'), '❤️‍🔥');
  assert.equal(normalizeChatText('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
  assert.equal(normalizeChatText('👨‍👩‍👧‍👦', { maxLength: 5 }), '');
});

test('long ASCII identifiers containing w remain unmodified', () => {
  for (const input of ['w'.repeat(5999) + 'x', 'x' + 'w'.repeat(5999)]) {
    assert.equal(normalizeChatText(input), input);
  }
});

test('ordinary Japanese words do not suffer substring slang replacement', () => {
  for (const input of ['笑顔がいい', '草原を歩く', '爆笑した', '草食動物']) {
    const output = normalizeChatText(input);
    assert.ok(!output.includes('わら') && !output.includes('パチパチ'), `${input} -> ${output}`);
  }
});

test('message normalization and composed output remain within the configured limit', () => {
  for (const input of ['あ'.repeat(12000), 'w'.repeat(12000), 'www '.repeat(3000)]) {
    assert.ok(normalizeChatText(input).length <= 6000);
  }
  const dictionary = { test: 'あ'.repeat(2000) };
  const output = normalizeChatText('test test', { dictionary, maxLength: 50 });
  assert.ok(output.length <= 50);
  const composed = composeChatMessage({
    speaker: 'なまえ'.repeat(100), content: '本文'.repeat(100), maxLength: 60
  });
  assert.ok(composed.length <= 60);
});
