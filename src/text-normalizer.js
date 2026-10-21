'use strict';

const readings = require('./data/readings.json');

// Only fold full-width ASCII for comparisons. Untouched text (especially names,
// code, and custom dictionary output) keeps its original spelling.
function foldWidth(text) {
  return text.replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

const asciiWord = /[A-Za-z0-9_]/;
const asciiStart = /^[A-Za-z0-9_]/;
const asciiEnd = /[A-Za-z0-9_]$/;
const maxDefault = 6000;
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

function textLimit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : maxDefault;
}

function boundText(text, limit) {
  if (text.length <= limit) return text;
  let end = 0;
  // Includes combining marks and joined emoji, not just UTF-16 surrogate pairs.
  for (const part of graphemes.segment(text)) {
    const next = part.index + part.segment.length;
    if (next > limit) break;
    end = next;
  }
  return text.slice(0, end);
}

function hasBoundary(text, at, term) {
  return !(asciiStart.test(term) && asciiWord.test(text[at - 1] || ''))
    && !(asciiEnd.test(term) && asciiWord.test(text[at + term.length] || ''));
}

function buildIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = row.folded[0].toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  for (const rowsForLetter of index.values()) {
    rowsForLetter.sort((a, b) => b.term.length - a.term.length
      || Number(b.match === 'class') - Number(a.match === 'class'));
  }
  return index;
}

const builtins = buildIndex(readings.entries.map(row => ({ ...row, folded: foldWidth(row.term) })));
const classCodes = readings.entries.filter(row => row.match === 'class').map(row => row.term).join('|');
const classContext = new RegExp('(?:覚醒|伝承)\\s*(?:' + classCodes + ')(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?:' + classCodes + ')\\s*(?:の)?(?:覚醒|伝承)');

function customRows(dictionary) {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) return [];
  return Object.entries(dictionary)
    .filter(([term, reading]) => term.length > 0 && typeof reading === 'string')
    .map(([term, reading]) => ({ term, reading, folded: foldWidth(term), caseSensitive: true }))
    .sort((a, b) => b.term.length - a.term.length);
}

// Custom readings are literal, longest-first and non-recursive. This function
// intentionally has no slang rules: it is also used for registered speaker names.
function applyCustomReadings(input, dictionary = {}) {
  const text = String(input ?? '');
  const rows = customRows(dictionary);
  let output = '';
  for (let i = 0; i < text.length;) {
    const row = rows.find(candidate => text.startsWith(candidate.term, i));
    if (row) {
      output += row.reading;
      i += row.term.length;
    } else {
      output += text[i++];
    }
  }
  return output;
}

// Segments keep protected content out of both built-in and custom replacements.
// A single pass avoids sentinel collisions and prevents code from enabling a
// game-specific profile for the surrounding conversation.
const protectedText = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|<t:\d+(?::[tTdDfFR])?>|<\/[\w -]+:\d+>|\|\|[\s\S]*?\|\||(?<![A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-])[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}|(?:https?|ftp):\/\/[^\s<>。！？、]+|(?<![A-Za-z0-9_])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d+)?(?:[\/?#][^\s<>。！？、]*)?/g;

function protectedReading(raw) {
  const folded = foldWidth(raw);
  if (folded.startsWith('```') || folded.startsWith('~~~')) return ' コード ';
  if (folded.startsWith('`')) return raw.slice(1, -1);
  if (folded.startsWith('||')) return ' 伏せ字 ';
  if (/^<@/.test(folded)) return ' メンション ';
  if (/^<#/.test(folded)) return ' チャンネル ';
  if (/^<a?:/.test(folded)) return ' 絵文字 ';
  if (/^<t:/.test(folded)) return ' 日時 ';
  if (/^<\//.test(folded)) return ' コマンド ';
  if (/^[^\s@]+@/.test(folded)) return ' メールアドレス ';
  return ' ユーアールエル ';
}

function segmentsFor(text) {
  const segments = [];
  let from = 0;
  // matchAll clones the RegExp, so concurrent callers cannot share lastIndex.
  for (const match of foldWidth(text).matchAll(protectedText)) {
    if (match.index > from) segments.push({ text: text.slice(from, match.index), plain: true });
    segments.push({ text: protectedReading(text.slice(match.index, match.index + match[0].length)), plain: false });
    from = match.index + match[0].length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), plain: true });
  return segments;
}

function isBlackDesertContext(text, profile) {
  if (profile === 'black_desert') return true;
  if (profile !== 'auto') return false;
  return /黒い砂漠|拠点戦|占領戦|ソラレ|赤の戦場|青の戦場|火箭|不退の旗|リトルサマナー|ドラカニア|セレンディア|カルフェオン/.test(text)
    || classContext.test(foldWidth(text));
}

function laughterAt(folded, at) {
  if (!/[wW]/.test(folded[at] || '')) return null;
  // Check the left boundary before scanning a run. Otherwise a long identifier
  // containing thousands of w's is rescanned at every character (quadratic work).
  if (asciiWord.test(folded[at - 1] || '')) return null;
  let end = at;
  while (end < folded.length && /[wW]/.test(folded[end])) end++;
  const run = folded.slice(at, end);
  if (!hasBoundary(folded, at, run)) return null;
  if (run === 'W') return null; // an isolated uppercase W is usually a key

  const before = folded.slice(Math.max(0, at - 24), at);
  const after = folded.slice(end, end + 24);
  if (/[+＝=\-/*]\s*$/.test(before) || /^\s*[+＝=\-/*]/.test(after)) return null;
  if (/\d\s*$/.test(before)) return null; // e.g. 300 w (watts)
  if (/(?:キー|ボタン|入力|操作)(?:は|が|を|の|[:：])?\s*$/.test(before)) return null;
  if (/^\s*(?:キー|key\b|ボタン|(?:を|が|の|は)?\s*(?:押|長押|連打|入力|離す|放す)|で\s*(?:移動|前進|歩|進))/i.test(after)) return null;
  return { length: run.length, count: Math.min(2, run.length), reading: run.length === 1 ? 'わら' : 'わらわら' };
}

function matchesRow(row, original, folded, at, bdo) {
  if (row.match === 'class' && !bdo) return false;
  if (row.match === 'class' && row.term === 'SP') {
    const before = folded.slice(Math.max(0, at - 6), at);
    const after = folded.slice(at + 2, at + 10);
    if (!/(?:覚醒|伝承)\s*$/.test(before) && !/^\s*(?:の)?(?:覚醒|伝承|職|クラス)/.test(after)
      && !(before.endsWith('[') && after.startsWith(']'))) return false;
  }
  const candidate = folded.slice(at, at + row.term.length);
  if (row.caseSensitive ? candidate !== row.folded : candidate.toLowerCase() !== row.folded.toLowerCase()) return false;
  return row.match === 'literal' || hasBoundary(folded, at, row.folded);
}

function normalizePlain(text, rows, bdo, applause, remaining) {
  const folded = foldWidth(text);
  let output = '';
  for (let i = 0; i < text.length && output.length < remaining;) {
    // Treat an emoji grapheme atomically. Skin tones / presentation selectors do
    // not need separate speech; an unknown ZWJ sequence must not be half-replaced.
    const emoji = text.slice(i).match(/^\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})*)*/u);
    if (emoji) {
      const whole = emoji[0];
      const base = whole.replace(/[\uFE0E\uFE0F]|\p{Emoji_Modifier}/gu, '');
      const custom = rows.find(row => row.term === whole) || rows.find(row => row.term === base);
      const entry = (builtins.get(base[0].toLowerCase()) || []).find(row => row.term.replace(/[\uFE0E\uFE0F]/g, '') === base);
      output += custom ? custom.reading : entry ? entry.reading : whole;
      i += whole.length;
      continue;
    }
    const laugh = laughterAt(folded, i);
    let custom = null;
    for (const candidate of rows) {
      // A legacy w dictionary entry must not corrupt English words, watts, or keys.
      if (/^[wW]+$/.test(candidate.folded)) {
        if (laugh && candidate.term.length === laugh.length && text.startsWith(candidate.term, i)) {
          custom = { length: laugh.length, reading: candidate.reading };
          break;
        }
      } else if (text.startsWith(candidate.term, i)) {
        custom = { length: candidate.term.length, reading: candidate.reading };
        break;
      }
    }
    // A single-w custom reading also controls long laughter runs, capped at two.
    if (!custom && laugh) {
      const single = rows.find(row => row.folded === folded[i] && row.term.length === 1);
      if (single) custom = { length: laugh.length, reading: single.reading.repeat(laugh.count) };
    }
    if (custom) {
      output += custom.reading;
      i += custom.length;
      continue;
    }

    const candidates = builtins.get((folded[i] || '').toLowerCase()) || [];
    const row = candidates.find(candidate => matchesRow(candidate, text, folded, i, bdo));
    if (row) {
      output += row.reading;
      i += row.term.length;
      continue;
    }

    const bracketLaugh = folded.slice(i).match(/^\((笑+|[wW]+)\)/);
    if (bracketLaugh) {
      output += bracketLaugh[1].length === 1 ? 'わら' : 'わらわら';
      i += bracketLaugh[0].length;
      continue;
    }
    if (laugh) {
      output += laugh.reading;
      i += laugh.length;
      continue;
    }
    if (applause && folded[i] === '8') {
      const run = folded.slice(i).match(/^8+/)[0];
      output += 'パチパチ';
      i += run.length;
      continue;
    }
    const bareLaugh = text.slice(i).match(/^笑+/);
    if (bareLaugh && !/[\p{Script=Han}A-Za-z0-9_]/u.test(text[i - 1] || '')
      && /^(?:\s|[。！？!?、,.）)」』]|$)/.test(text.slice(i + bareLaugh[0].length))) {
      output += bareLaugh[0].length === 1 ? 'わら' : 'わらわら';
      i += bareLaugh[0].length;
      continue;
    }
    output += text[i++];
  }
  return boundText(output, remaining);
}

function normalizeChatText(input, options = {}) {
  const limit = textLimit(options.maxLength ?? maxDefault);
  const text = boundText(String(input ?? ''), limit);
  const segments = segmentsFor(text);
  const plainText = segments.filter(segment => segment.plain).map(segment => segment.text).join(' ');
  const bdo = isBlackDesertContext(plainText, options.profile || 'auto');
  const applause = segments.every(segment => segment.plain) && /^\s*8{4,}\s*[!！。]*\s*$/.test(foldWidth(text));
  const rows = customRows(options.dictionary);
  let output = '';
  for (const segment of segments) {
    if (output.length >= limit) break;
    output += segment.plain
      ? normalizePlain(segment.text, rows, bdo, applause, limit - output.length)
      : boundText(segment.text, limit - output.length);
  }
  return boundText(output.replace(/\s+/g, ' ').trim(), limit);
}

function composeChatMessage({ content, speaker, speakName = true, dictionary = {}, profile = 'auto', maxLength = maxDefault }) {
  const limit = textLimit(maxLength);
  const body = normalizeChatText(content, { dictionary, profile, maxLength: limit });
  if (!body) return '';
  const name = speakName ? applyCustomReadings(speaker || 'ユーザー', dictionary) + '、' : '';
  return boundText((name + body).replace(/\s+/g, ' ').trim(), limit);
}

function dictionaryStats() {
  const categories = {};
  for (const row of readings.entries) categories[row.category] = (categories[row.category] || 0) + 1;
  return { version: readings.version, entries: readings.entries.length, categories };
}

module.exports = { normalizeChatText, applyCustomReadings, composeChatMessage, dictionaryStats };
