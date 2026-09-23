require('dotenv/config');

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior
} = require('@discordjs/voice');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const PREVIEW_TEXT = process.env.PREVIEW_TEXT || 'こんにちは。こちらは音声サンプルです。今日もよろしくお願いします。';
const CHUNK_CHARS = Math.max(60, Number(process.env.TTS_CHUNK_CHARS || 180));
const MAX_TEXT_CHARS = Math.max(CHUNK_CHARS, Number(process.env.TTS_MAX_TEXT_CHARS || 6000));
const SYNTH_CONCURRENCY = Math.max(1, Number(process.env.TTS_SYNTH_CONCURRENCY || 4));
const MAX_PENDING_MESSAGES = Math.max(10, Number(process.env.TTS_MAX_PENDING_MESSAGES || 500));
const MAX_AUDIO_QUEUE = Math.max(100, Number(process.env.TTS_MAX_AUDIO_QUEUE || 3000));
const REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.TTS_REQUEST_TIMEOUT_MS || 20000));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

let state = { guilds: {}, voices: {}, favorites: {}, dictionaries: {} };

try {
  if (fs.existsSync(STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = {
      guilds: parsed.guilds || {},
      voices: parsed.voices || {},
      favorites: parsed.favorites || {},
      dictionaries: parsed.dictionaries || {}
    };
  }
} catch (e) {
  console.error('State load failed:', e);
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STATE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fsp.rename(tmp, STATE_FILE);
    } catch (e) {
      console.error('State save failed:', e);
    }
  }, 100);
}

function guildSettings(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      voice_id: null,
      source_channel_id: null,
      panel_channel_id: null,
      panel_message_id: null,
      tts_enabled: false,
      speed: 1,
      volume: 1
    };
    saveStateSoon();
  }
  return state.guilds[guildId];
}

function patchGuild(guildId, patch) {
  const g = guildSettings(guildId);
  Object.assign(g, patch);
  saveStateSoon();
  return g;
}

function favoriteKey(guildId, userId) {
  return guildId + ':' + userId;
}

function isFavorite(guildId, userId, voiceId) {
  const key = favoriteKey(guildId, userId);
  return Array.isArray(state.favorites[key]) && state.favorites[key].includes(voiceId);
}

function toggleFavorite(guildId, userId, voiceId) {
  const key = favoriteKey(guildId, userId);
  const set = new Set(state.favorites[key] || []);
  if (set.has(voiceId)) set.delete(voiceId);
  else set.add(voiceId);
  state.favorites[key] = Array.from(set);
  saveStateSoon();
  return set.has(voiceId);
}

function listVoices(options) {
  options = options || {};
  const query = String(options.query || '').toLowerCase();
  let out = Object.values(state.voices).filter(v => v.enabled !== false);
  if (query) {
    out = out.filter(v => [v.name, v.style, v.engine_label, v.tags].filter(Boolean).join(' ').toLowerCase().includes(query));
  }
  if (options.favoritesOnly) {
    out = out.filter(v => isFavorite(options.guildId, options.userId, v.id));
  }
  return out.sort((a, b) => {
    const x = (a.engine_label || '') + '|' + (a.name || '') + '|' + (a.style || '');
    const y = (b.engine_label || '') + '|' + (b.name || '') + '|' + (b.style || '');
    return x.localeCompare(y, 'ja');
  });
}

function getVoice(id) {
  return id ? state.voices[id] || null : null;
}

function dictFor(guildId) {
  if (!state.dictionaries[guildId]) state.dictionaries[guildId] = {};
  return state.dictionaries[guildId];
}

function applyDictionary(guildId, text) {
  let out = String(text || '');
  const rows = Object.entries(dictFor(guildId)).sort((a, b) => b[0].length - a[0].length);
  for (const row of rows) out = out.split(row[0]).join(row[1]);
  return out;
}

function parseEngines() {
  try {
    const arr = JSON.parse(process.env.ENGINE_ENDPOINTS || '[]');
    return arr.map(x => ({
      id: String(x.id),
      label: String(x.label || x.id),
      url: String(x.url || '').replace(/\/$/, ''),
      type: String(x.type || 'voicevox')
    })).filter(x => x.id && x.url);
  } catch (e) {
    console.error('ENGINE_ENDPOINTS is invalid JSON:', e.message);
    return [];
  }
}

const engines = parseEngines();

async function fetchJson(url, options) {
  const res = await fetch(url, Object.assign({}, options || {}, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ': ' + await res.text());
  return res.json();
}

function makeVoiceId(engineId, speakerUuid, styleId) {
  return crypto.createHash('sha1').update(engineId + ':' + (speakerUuid || 'speaker') + ':' + styleId).digest('hex');
}

async function discoverEngine(engine) {
  if (engine.type !== 'voicevox') throw new Error('Unsupported engine type: ' + engine.type);
  const speakers = await fetchJson(engine.url + '/speakers');
  let count = 0;
  for (const speaker of speakers) {
    for (const style of speaker.styles || []) {
      const id = makeVoiceId(engine.id, speaker.speaker_uuid, style.id);
      state.voices[id] = {
        id,
        provider: 'voicevox_http',
        engine_id: engine.id,
        engine_label: engine.label,
        provider_voice_id: String(style.id),
        speaker_uuid: speaker.speaker_uuid || null,
        name: speaker.name || 'Unknown',
        style: style.name || null,
        tags: [speaker.name, style.name, engine.label].filter(Boolean).join(' '),
        enabled: true
      };
      count++;
    }
  }
  saveStateSoon();
  return count;
}

async function discoverAll() {
  const results = [];
  for (const engine of engines) {
    try {
      const count = await discoverEngine(engine);
      results.push({ engine: engine.label, count, ok: true });
    } catch (e) {
      results.push({ engine: engine.label, count: 0, ok: false, error: e.message });
    }
  }
  return results;
}

function findEngine(id) {
  return engines.find(e => e.id === id);
}

const synthInFlight = new Map();

async function synthesize(voice, text, options) {
  const engine = findEngine(voice.engine_id);
  if (!engine) throw new Error('Engine not configured: ' + voice.engine_id);
  const speaker = encodeURIComponent(voice.provider_voice_id);
  const query = await fetchJson(
    engine.url + '/audio_query?speaker=' + speaker + '&text=' + encodeURIComponent(text),
    { method: 'POST' }
  );
  query.speedScale = Number(options.speed || 1);
  query.volumeScale = Number(options.volume || 1);

  const res = await fetch(engine.url + '/synthesis?speaker=' + speaker, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ': ' + await res.text());
  return Buffer.from(await res.arrayBuffer());
}

async function ensureAudio(voiceId, text, options) {
  const voice = getVoice(voiceId);
  if (!voice) throw new Error('Voice not found');
  const signature = crypto.createHash('sha1')
    .update(voiceId + ':' + text + ':' + Number(options.speed || 1) + ':' + Number(options.volume || 1))
    .digest('hex');
  const file = path.join(CACHE_DIR, signature + '.wav');

  if (fs.existsSync(file)) return file;
  if (synthInFlight.has(file)) return synthInFlight.get(file);

  const promise = (async () => {
    try {
      const buffer = await synthesize(voice, text, options);
      const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, file);
      return file;
    } finally {
      synthInFlight.delete(file);
    }
  })();

  synthInFlight.set(file, promise);
  return promise;
}

const audioStates = new Map();

function audioState(guildId) {
  if (!audioStates.has(guildId)) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const s = { connection: null, player, queue: [], playing: false, dropped: 0 };
    player.on(AudioPlayerStatus.Idle, () => {
      s.playing = false;
      playNext(guildId).catch(console.error);
    });
    player.on('error', err => {
      console.error('Audio player error:', err);
      s.playing = false;
      playNext(guildId).catch(console.error);
    });
    audioStates.set(guildId, s);
  }
  return audioStates.get(guildId);
}

async function connectTo(member) {
  const channel = member.voice && member.voice.channel;
  if (!channel) throw new Error('先にボイスチャンネルへ参加してください。');

  const s = audioState(member.guild.id);
  if (s.connection) {
    try { s.connection.destroy(); } catch {}
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  s.connection = connection;
  connection.subscribe(s.player);
  await entersState(connection, VoiceConnectionStatus.Ready, 15000);
  return channel;
}

function disconnect(guildId) {
  const s = audioState(guildId);
  s.queue = [];
  s.player.stop(true);
  if (s.connection) {
    try { s.connection.destroy(); } catch {}
    s.connection = null;
  }
}

function isConnected(guildId) {
  return !!(audioStates.get(guildId) && audioStates.get(guildId).connection);
}

function enqueue(guildId, file, interrupt) {
  const s = audioState(guildId);
  if (!s.connection) throw new Error('BOTがVCに接続していません。');

  if (interrupt) {
    s.queue.unshift(file);
    s.player.stop(true);
    return true;
  }

  if (s.queue.length >= MAX_AUDIO_QUEUE) {
    s.dropped++;
    return false;
  }

  s.queue.push(file);
  if (!s.playing) playNext(guildId).catch(console.error);
  return true;
}

async function playNext(guildId) {
  const s = audioState(guildId);
  if (s.playing || !s.connection) return;
  const next = s.queue.shift();
  if (!next) return;
  s.playing = true;
  s.player.play(createAudioResource(next));
}

function skip(guildId) {
  audioState(guildId).player.stop(true);
}

function audioStats(guildId) {
  const s = audioState(guildId);
  return { connected: !!s.connection, queued: s.queue.length, playing: s.playing, dropped: s.dropped };
}

class TaskPool {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ fn, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const task = this.waiting.shift();
      this.active++;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

const synthPool = new TaskPool(SYNTH_CONCURRENCY);
const pipelineGuilds = new Map();

function pipelineGuild(guildId) {
  if (!pipelineGuilds.has(guildId)) {
    pipelineGuilds.set(guildId, { tail: Promise.resolve(), pending: 0, accepted: 0, rejected: 0, lastError: null });
  }
  return pipelineGuilds.get(guildId);
}

function cleanText(input) {
  return String(input || '')
    .replace(/```[\s\S]*?```/g, ' コード ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' URL ')
    .replace(/<@!?(\d+)>/g, ' メンション ')
    .replace(/<#[0-9]+>/g, ' チャンネル ')
    .replace(/<a?:[^:>]+:[0-9]+>/g, ' 絵文字 ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function splitText(input) {
  let text = cleanText(input);
  const out = [];
  while (text.length) {
    if (text.length <= CHUNK_CHARS) {
      out.push(text);
      break;
    }
    const min = Math.floor(CHUNK_CHARS * 0.45);
    let cut = -1;
    for (const token of ['。', '！', '？', '、', ',', ' ', '\n']) {
      const idx = text.lastIndexOf(token, CHUNK_CHARS);
      if (idx >= min) cut = Math.max(cut, idx + token.length);
    }
    if (cut < 1) cut = CHUNK_CHARS;
    const part = text.slice(0, cut).trim();
    if (part) out.push(part);
    text = text.slice(cut).trim();
  }
  return out;
}

function queueMessage(guildId, voiceId, text, speed, volume) {
  const g = pipelineGuild(guildId);
  if (g.pending >= MAX_PENDING_MESSAGES) {
    g.rejected++;
    return false;
  }

  const chunks = splitText(text);
  if (!chunks.length) return false;

  g.pending++;
  g.accepted++;

  const generated = chunks.map(chunk => synthPool.run(() => ensureAudio(voiceId, chunk, { speed, volume })));
  const previous = g.tail.catch(() => {});

  g.tail = previous.then(async () => {
    try {
      for (const filePromise of generated) {
        const file = await filePromise;
        enqueue(guildId, file, false);
      }
    } catch (e) {
      g.lastError = e.message || String(e);
      console.error('TTS pipeline error:', e);
    } finally {
      g.pending = Math.max(0, g.pending - 1);
    }
  });

  return true;
}

function pipelineStats(guildId) {
  const g = pipelineGuild(guildId);
  return {
    active: synthPool.active,
    waiting: synthPool.waiting.length,
    concurrency: synthPool.concurrency,
    pending: g.pending,
    accepted: g.accepted,
    rejected: g.rejected,
    lastError: g.lastError
  };
}

function voiceLabel(settings) {
  const v = getVoice(settings.voice_id);
  if (!v) return '未選択';
  return v.name + (v.style ? ' / ' + v.style : '');
}

function controlPanel(guildId) {
  const g = guildSettings(guildId);
  const embed = new EmbedBuilder()
    .setTitle('🔊 読み上げBOT')
    .setDescription('コマンド不要。下のボタンだけで操作できます。')
    .addFields(
      { name: 'VC', value: isConnected(guildId) ? '🟢 接続中' : '⚫ 未接続', inline: true },
      { name: '読み上げ', value: g.tts_enabled ? '🟢 ON' : '⚫ OFF', inline: true },
      { name: '現在の声', value: voiceLabel(g), inline: false },
      { name: '読み上げ対象', value: g.source_channel_id ? '<#' + g.source_channel_id + '>' : '未設定', inline: true },
      { name: '速度', value: Number(g.speed).toFixed(2) + 'x', inline: true },
      { name: '音量', value: Math.round(Number(g.volume) * 100) + '%', inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tts:join').setLabel('VC接続').setEmoji('🔊').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tts:leave').setLabel('切断').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tts:toggle').setLabel(g.tts_enabled ? '読み上げOFF' : '読み上げON').setEmoji('📢').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tts:skip').setLabel('スキップ').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:status').setLabel('混雑状況').setEmoji('⚡').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tts:library').setLabel('ボイス一覧').setEmoji('🎙️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tts:favorites').setLabel('お気に入り').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:search').setLabel('ボイス検索').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:setchannel').setLabel('読み上げCH変更').setEmoji('📖').setStyle(ButtonStyle.Success)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tts:speeddown').setLabel('速度 −').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:speedup').setLabel('速度 ＋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:voldown').setLabel('音量 −').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:volup').setLabel('音量 ＋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tts:admin').setLabel('管理').setEmoji('⚙️').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

function searchModal() {
  const modal = new ModalBuilder().setCustomId('modal:search').setTitle('ボイス検索');
  const q = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('声名・スタイル・エンジン名')
    .setPlaceholder('例：女性 / アニメ / ずんだもん / Aivis')
    .setRequired(true)
    .setMaxLength(80)
    .setStyle(TextInputStyle.Short);
  modal.addComponents(new ActionRowBuilder().addComponents(q));
  return modal;
}

function dictAddModal() {
  const modal = new ModalBuilder().setCustomId('modal:dict:add').setTitle('読み上げ辞書に追加');
  const a = new TextInputBuilder().setCustomId('word').setLabel('元の表記').setRequired(true).setMaxLength(80).setStyle(TextInputStyle.Short);
  const b = new TextInputBuilder().setCustomId('reading').setLabel('読み方').setRequired(true).setMaxLength(120).setStyle(TextInputStyle.Short);
  modal.addComponents(new ActionRowBuilder().addComponents(a), new ActionRowBuilder().addComponents(b));
  return modal;
}

function dictRemoveModal() {
  const modal = new ModalBuilder().setCustomId('modal:dict:remove').setTitle('読み上げ辞書から削除');
  const a = new TextInputBuilder().setCustomId('word').setLabel('削除する表記').setRequired(true).setMaxLength(80).setStyle(TextInputStyle.Short);
  modal.addComponents(new ActionRowBuilder().addComponents(a));
  return modal;
}

function adminPanel() {
  const embed = new EmbedBuilder().setTitle('⚙️ 管理者メニュー').setDescription('ここもボタン操作です。');
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:refreshvoices').setLabel('ボイス再読込').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin:dictadd').setLabel('辞書追加').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:dictremove').setLabel('辞書削除').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:dictlist').setLabel('辞書一覧').setEmoji('📚').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:reinstall').setLabel('このチャンネルに操作パネルを再設置').setEmoji('📌').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row1, row2] };
}

const sessions = new Map();

function createSession(guildId, userId, items, label) {
  const id = crypto.randomBytes(4).toString('hex');
  const s = { id, guildId, userId, items, index: 0, label: label || '', createdAt: Date.now() };
  sessions.set(id, s);
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const pair of sessions.entries()) {
    if (pair[1].createdAt < cutoff) sessions.delete(pair[0]);
  }
}, 5 * 60 * 1000).unref();

function libraryCard(session) {
  const count = session.items.length;
  const voice = count ? session.items[session.index] : null;
  const embed = new EmbedBuilder().setTitle('🎙️ ボイスライブラリ');

  if (!voice) {
    embed.setDescription('条件に一致するボイスがありません。');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('voice:empty:all').setLabel('全ボイス').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('voice:empty:search').setLabel('検索をやり直す').setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row] };
  }

  const fav = isFavorite(session.guildId, session.userId, voice.id);
  embed.setDescription('## ' + voice.name + (voice.style ? '\n' + voice.style : ''))
    .addFields(
      { name: '音声エンジン', value: voice.engine_label || 'Unknown', inline: true },
      { name: '位置', value: (session.index + 1) + ' / ' + count, inline: true },
      { name: 'お気に入り', value: fav ? '⭐ 登録済み' : '—', inline: true }
    )
    .setFooter({ text: session.label || '全ボイス' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('voice:' + session.id + ':prev').setLabel('◀ 前へ').setStyle(ButtonStyle.Secondary).setDisabled(count <= 1),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':preview').setLabel('VCで試聴').setEmoji('🔊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':file').setLabel('音声で試聴').setEmoji('🎧').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':select').setLabel('この声にする').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':next').setLabel('次へ ▶').setStyle(ButtonStyle.Secondary).setDisabled(count <= 1)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('voice:' + session.id + ':fav').setLabel(fav ? 'お気に入り解除' : 'お気に入り').setEmoji('⭐').setStyle(fav ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':search').setLabel('検索').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':all').setLabel('全ボイス').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('voice:' + session.id + ':favorites').setLabel('お気に入りだけ').setEmoji('⭐').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function isAdmin(interaction) {
  return !!(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild));
}

async function memberFor(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

function canSend(channel) {
  if (!channel || !channel.isTextBased?.() || channel.isDMBased?.()) return false;
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return !!(perms && perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages));
}

function pickPanelChannel(guild) {
  const envId = process.env.PANEL_CHANNEL_ID;
  if (envId) {
    const c = guild.channels.cache.get(envId);
    if (canSend(c)) return c;
  }

  const g = guildSettings(guild.id);
  if (g.panel_channel_id) {
    const c = guild.channels.cache.get(g.panel_channel_id);
    if (canSend(c)) return c;
  }

  if (canSend(guild.systemChannel)) return guild.systemChannel;

  const channels = Array.from(guild.channels.cache.values())
    .filter(c => c.type === ChannelType.GuildText && canSend(c))
    .sort((a, b) => a.rawPosition - b.rawPosition);

  const preferred = ['読み上げ', 'tts', 'bot', 'bot操作'];
  for (const name of preferred) {
    const c = channels.find(x => x.name.toLowerCase().includes(name.toLowerCase()));
    if (c) return c;
  }

  return channels[0] || null;
}

async function installPanel(guild, requestedChannel) {
  const channel = requestedChannel || pickPanelChannel(guild);
  if (!channel) return null;

  const g = guildSettings(guild.id);
  if (g.panel_channel_id === channel.id && g.panel_message_id) {
    try {
      const old = await channel.messages.fetch(g.panel_message_id);
      await old.edit(controlPanel(guild.id));
      return old;
    } catch {}
  }

  const msg = await channel.send(controlPanel(guild.id));
  patchGuild(guild.id, { panel_channel_id: channel.id, panel_message_id: msg.id });
  return msg;
}

async function refreshPanel(guild) {
  const g = guildSettings(guild.id);
  if (!g.panel_channel_id || !g.panel_message_id) return false;
  try {
    const c = await guild.channels.fetch(g.panel_channel_id);
    const msg = await c.messages.fetch(g.panel_message_id);
    await msg.edit(controlPanel(guild.id));
    return true;
  } catch {
    return false;
  }
}

async function showLibrary(interaction, query, favoritesOnly, edit) {
  const items = listVoices({
    query: query || '',
    favoritesOnly: !!favoritesOnly,
    guildId: interaction.guildId,
    userId: interaction.user.id
  });
  const label = query || (favoritesOnly ? '⭐ お気に入り' : '');
  const session = createSession(interaction.guildId, interaction.user.id, items, label);
  const payload = libraryCard(session);
  if (edit) return interaction.update(payload);
  return interaction.reply(Object.assign({}, payload, { ephemeral: true }));
}

async function previewVoice(interaction, voice, asFile) {
  const g = guildSettings(interaction.guildId);
  const file = await ensureAudio(voice.id, PREVIEW_TEXT, { speed: g.speed, volume: g.volume });

  if (asFile) {
    const name = (voice.name + '-' + (voice.style || 'voice')).replace(/[\\/:*?"<>|]/g, '_');
    return interaction.followUp({
      content: '🎧 **' + voice.name + (voice.style ? ' / ' + voice.style : '') + '** のサンプル',
      files: [new AttachmentBuilder(file, { name: name + '.wav' })],
      ephemeral: true
    });
  }

  if (!isConnected(interaction.guildId)) await connectTo(await memberFor(interaction));
  enqueue(interaction.guildId, file, true);
}

client.once(Events.ClientReady, async ready => {
  console.log('Ready as ' + ready.user.tag);

  try {
    await ready.application.commands.set([]);
    for (const guild of ready.guilds.cache.values()) {
      try { await guild.commands.set([]); } catch {}
    }
  } catch (e) {
    console.warn('Command cleanup skipped:', e.message);
  }

  const found = await discoverAll();
  console.log('Voice discovery:', found);

  for (const guild of ready.guilds.cache.values()) {
    try {
      if (!await refreshPanel(guild)) await installPanel(guild);
    } catch (e) {
      console.error('Panel install failed for ' + guild.id + ':', e.message);
    }
  }
});

client.on(Events.GuildCreate, async guild => {
  try {
    await discoverAll();
    await installPanel(guild);
  } catch (e) {
    console.error('Guild setup failed:', e);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.guildId) return;

    if (interaction.isChatInputCommand()) {
      return interaction.reply(Object.assign(
        { content: 'このBOTはコマンド不要です。ボタンを使ってください。', ephemeral: true },
        controlPanel(interaction.guildId)
      ));
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal:search') {
        const q = interaction.fields.getTextInputValue('query').trim();
        return showLibrary(interaction, q, false, false);
      }

      if (interaction.customId === 'modal:dict:add') {
        if (!isAdmin(interaction)) return interaction.reply({ content: '管理者だけが変更できます。', ephemeral: true });
        const word = interaction.fields.getTextInputValue('word').trim();
        const reading = interaction.fields.getTextInputValue('reading').trim();
        dictFor(interaction.guildId)[word] = reading;
        saveStateSoon();
        return interaction.reply({ content: '✅ 辞書に追加しました：**' + word + ' → ' + reading + '**', ephemeral: true });
      }

      if (interaction.customId === 'modal:dict:remove') {
        if (!isAdmin(interaction)) return interaction.reply({ content: '管理者だけが変更できます。', ephemeral: true });
        const word = interaction.fields.getTextInputValue('word').trim();
        const d = dictFor(interaction.guildId);
        const existed = Object.prototype.hasOwnProperty.call(d, word);
        delete d[word];
        saveStateSoon();
        return interaction.reply({ content: existed ? '🗑️ **' + word + '** を削除しました。' : 'その単語は辞書にありません。', ephemeral: true });
      }

      return;
    }

    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === 'tts:channelselect') {
        const selected = interaction.values && interaction.values[0];
        if (!selected) return interaction.reply({ content: 'チャンネルを選択してください。', ephemeral: true });

        const channel = await interaction.guild.channels.fetch(selected).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'テキストチャンネルを選択してください。', ephemeral: true });
        }

        patchGuild(interaction.guildId, { source_channel_id: channel.id });
        await refreshPanel(interaction.guild);
        return interaction.update({
          content: '✅ 読み上げ対象を <#' + channel.id + '> に変更しました。',
          components: []
        });
      }
      return;
    }

    if (!interaction.isButton()) return;

    if (interaction.customId === 'voice:empty:all') return showLibrary(interaction, '', false, false);
    if (interaction.customId === 'voice:empty:search') return interaction.showModal(searchModal());

    if (interaction.customId.startsWith('tts:')) {
      const action = interaction.customId.split(':')[1];

      if (action === 'join') {
        await interaction.deferUpdate();
        await connectTo(await memberFor(interaction));
        return interaction.editReply(controlPanel(interaction.guildId));
      }

      if (action === 'leave') disconnect(interaction.guildId);
      else if (action === 'toggle') patchGuild(interaction.guildId, { tts_enabled: !guildSettings(interaction.guildId).tts_enabled });
      else if (action === 'skip') skip(interaction.guildId);
      else if (action === 'status') {
        const p = pipelineStats(interaction.guildId);
        const a = audioStats(interaction.guildId);
        return interaction.reply({
          content:
            '⚡ **現在の処理状況**\n' +
            '生成中: **' + p.active + '/' + p.concurrency + '**\n' +
            '生成待ち: **' + p.waiting + '**\n' +
            'メッセージ処理待ち: **' + p.pending + '**\n' +
            'VC再生待ち: **' + a.queued + '**\n' +
            'キャッシュ: 同じ文章・声・速度・音量なら再生成しません。',
          ephemeral: true
        });
      } else if (action === 'library') return showLibrary(interaction, '', false, false);
      else if (action === 'favorites') return showLibrary(interaction, '', true, false);
      else if (action === 'search') return interaction.showModal(searchModal());
      else if (action === 'setchannel') {
        const picker = new ChannelSelectMenuBuilder()
          .setCustomId('tts:channelselect')
          .setPlaceholder('読み上げるテキストチャンネルを選択')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1);

        const row = new ActionRowBuilder().addComponents(picker);
        return interaction.reply({
          content: '📖 **読み上げるチャンネルを選んでください**',
          components: [row],
          ephemeral: true
        });
      }
      else if (action === 'speeddown' || action === 'speedup') {
        const g = guildSettings(interaction.guildId);
        const next = Math.max(0.5, Math.min(2, Number(g.speed) + (action === 'speedup' ? 0.1 : -0.1)));
        patchGuild(interaction.guildId, { speed: Number(next.toFixed(2)) });
      } else if (action === 'voldown' || action === 'volup') {
        const g = guildSettings(interaction.guildId);
        const next = Math.max(0.1, Math.min(2, Number(g.volume) + (action === 'volup' ? 0.1 : -0.1)));
        patchGuild(interaction.guildId, { volume: Number(next.toFixed(2)) });
      } else if (action === 'admin') {
        if (!isAdmin(interaction)) return interaction.reply({ content: '管理者だけが開けます。', ephemeral: true });
        return interaction.reply(Object.assign({}, adminPanel(), { ephemeral: true }));
      }

      await refreshPanel(interaction.guild);
      return interaction.update(controlPanel(interaction.guildId));
    }

    if (interaction.customId.startsWith('admin:')) {
      if (!isAdmin(interaction)) return interaction.reply({ content: '管理者だけが使えます。', ephemeral: true });
      const action = interaction.customId.split(':')[1];

      if (action === 'refreshvoices') {
        await interaction.deferReply({ ephemeral: true });
        const result = await discoverAll();
        const lines = result.length ? result.map(x => x.ok ? '✅ ' + x.engine + ': ' + x.count + 'ボイス' : '❌ ' + x.engine + ': ' + x.error) : ['音声エンジンが未設定です。'];
        return interaction.editReply(lines.join('\n'));
      }

      if (action === 'dictadd') return interaction.showModal(dictAddModal());
      if (action === 'dictremove') return interaction.showModal(dictRemoveModal());

      if (action === 'dictlist') {
        const rows = Object.entries(dictFor(interaction.guildId));
        const txt = rows.length ? rows.slice(0, 80).map(x => '• **' + x[0] + '** → ' + x[1]).join('\n') : '辞書は空です。';
        return interaction.reply({ content: '📚 **読み上げ辞書**\n' + txt, ephemeral: true });
      }

      if (action === 'reinstall') {
        const msg = await installPanel(interaction.guild, interaction.channel);
        return interaction.reply({ content: msg ? '✅ このチャンネルに操作パネルを設置しました。' : '設置できませんでした。', ephemeral: true });
      }

      return;
    }

    if (interaction.customId.startsWith('voice:')) {
      const parts = interaction.customId.split(':');
      const session = sessions.get(parts[1]);
      const action = parts[2];

      if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
        return interaction.reply(Object.assign(
          { content: 'このボイス画面は期限切れです。メインパネルから開き直してください。', ephemeral: true },
          controlPanel(interaction.guildId)
        ));
      }

      if (!session.items.length) return interaction.update(libraryCard(session));

      const voice = session.items[session.index];

      if (action === 'prev') session.index = (session.index - 1 + session.items.length) % session.items.length;
      else if (action === 'next') session.index = (session.index + 1) % session.items.length;
      else if (action === 'select') {
        patchGuild(interaction.guildId, { voice_id: voice.id });
        await refreshPanel(interaction.guild);
      } else if (action === 'fav') toggleFavorite(interaction.guildId, interaction.user.id, voice.id);
      else if (action === 'search') return interaction.showModal(searchModal());
      else if (action === 'all') return showLibrary(interaction, '', false, true);
      else if (action === 'favorites') return showLibrary(interaction, '', true, true);
      else if (action === 'preview' || action === 'file') {
        await interaction.deferUpdate();
        await previewVoice(interaction, voice, action === 'file');
        return;
      }

      return interaction.update(libraryCard(session));
    }
  } catch (e) {
    console.error('Interaction error:', e);
    const content = '⚠️ ' + (e.message || 'エラーが発生しました。');
    if (interaction.deferred || interaction.replied) {
      try { await interaction.followUp({ content, ephemeral: true }); } catch {}
    } else {
      try { await interaction.reply({ content, ephemeral: true }); } catch {}
    }
  }
});

client.on(Events.MessageCreate, message => {
  try {
    if (!message.guild || message.author.bot || !message.content.trim()) return;

    const g = guildSettings(message.guild.id);
    if (!g.tts_enabled) return;
    if (!g.source_channel_id || message.channel.id !== g.source_channel_id) return;
    if (!g.voice_id || !isConnected(message.guild.id)) return;
    if (!getVoice(g.voice_id)) return;

    const text = applyDictionary(message.guild.id, message.content.trim());
    const accepted = queueMessage(message.guild.id, g.voice_id, text, g.speed, g.volume);
    if (!accepted) console.warn('TTS queue rejected a message in guild ' + message.guild.id);
  } catch (e) {
    console.error('Message TTS error:', e);
  }
});

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const payload = {
      ok: true,
      discordConfigured: !!process.env.DISCORD_TOKEN,
      discordReady: client.isReady(),
      bot: client.user ? client.user.tag : null,
      engines: engines.map(e => e.label),
      voices: Object.keys(state.voices).length
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload));
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('TTS Voice Library Bot is online.\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Health server listening on :' + PORT);
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch(e => {
    console.error('Discord login failed:', e);
  });
} else {
  console.warn('DISCORD_TOKEN is not set. Health server is online; Discord bot is waiting for configuration.');
}
