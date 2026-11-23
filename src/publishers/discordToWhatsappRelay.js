/**
 * src/publishers/discordToWhatsappRelay.js
 *
 * Path C — Independent Discord → WhatsApp Channel Relay.
 *
 * Watches a Discord channel where the upstream Lunch Bot already posts daily
 * menus, reassembles multi-chunk Discord messages, strips Discord-only UI
 * prompts/mentions, converts Discord Markdown into WhatsApp Markdown, and
 * forwards the menu to a WhatsApp Channel via WAHA.
 *
 * Requires NO connection to the upstream PostgreSQL database or n8n server.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const whatsappPublisher = require('./whatsappPublisher');

const DEFAULT_STATE_FILE = path.resolve(__dirname, '..', '..', '.relay-state.json');
const FOOTER_SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━';

// Matches `# Uzumasa Campus — Tuesday, 2026-08-18` (after optional role mention)
const HEADER_REGEX = /^#\s+([A-Za-z]+)\s+Campus\s+—\s+([^,\n]+),\s*(\d{4}-\d{2}-\d{2})/m;

/**
 * Strip leading Discord role/user mentions (`<@&123456>`, `<@123456>`) and
 * the Discord-only interactive rating button prompt (`## **Tap below to rate the menu**`).
 *
 * @param {string} rawText
 * @returns {string}
 */
function stripDiscordArtifacts(rawText) {
  return String(rawText || '')
    // Remove leading role or user mentions on the first line
    .replace(/^(?:<@&?\d+>\s*)+/, '')
    // Remove the rating button heading appended to the first Discord chunk
    .replace(/\n*##\s+\*\*Tap below to rate the menu\*\*\s*/g, '\n')
    .trim();
}

/**
 * Parse a Discord message's content to check whether it is the opening chunk
 * of a campus lunch menu post.
 *
 * @param {string} content
 * @returns {{campus: string, dayName: string, menuDate: string}|null}
 */
function parseMenuHeader(content) {
  if (!content) return null;
  const cleaned = stripDiscordArtifacts(content);
  const match = cleaned.match(HEADER_REGEX);
  if (!match) return null;

  return {
    campus: match[1].trim(),
    dayName: match[2].trim(),
    menuDate: match[3].trim(),
  };
}

/**
 * Convert one or more Discord menu message chunks into a single WhatsApp
 * Channel post using WhatsApp Markdown (`*bold*`, `_italic_`, no `#` headers).
 *
 * @param {string|string[]} chunksOrText
 * @returns {string}
 */
function convertDiscordMenuToWhatsapp(chunksOrText) {
  const chunks = Array.isArray(chunksOrText) ? chunksOrText : [chunksOrText];
  const cleanedChunks = chunks
    .map((c) => stripDiscordArtifacts(c))
    .filter(Boolean);

  if (cleanedChunks.length === 0) return '';

  const combined = cleanedChunks.join('\n\n');

  return combined
    // Convert single-asterisk Discord italics `*text*` -> WhatsApp `_text_`
    .replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, '_$1_')
    // Convert double-asterisk Discord bold `**text**` -> WhatsApp `*text*`
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    // Convert top-level `# Uzumasa Campus — Day, YYYY-MM-DD` header
    .replace(/^#\s+(.+)$/gm, '🍽️ *$1*')
    // Convert section `## 🍱 Category  ·  ¥330` headers
    .replace(/^##\s+(.+)$/gm, '*$1*')
    .trim();
}

/**
 * Given an array of Discord messages (ordered newest-first, as returned by
 * `channel.messages.fetch()`), find the latest complete menu post for the
 * target campus (including any continuation chunks sent by the same bot).
 *
 * @param {Array<{id?: string, content: string, author?: {id?: string, bot?: boolean}, createdTimestamp?: number}>} messagesNewestFirst
 * @param {string} [targetCampus='Uzumasa']
 * @returns {{header: {campus: string, dayName: string, menuDate: string}, chunks: string[], messageId: string|null}|null}
 */
function extractLatestMenuFromMessages(messagesNewestFirst, targetCampus = 'Uzumasa') {
  if (!Array.isArray(messagesNewestFirst) || messagesNewestFirst.length === 0) {
    return null;
  }

  // Work in chronological order (oldest -> newest) so continuation chunks
  // follow their opening header chunk naturally.
  const chronological = [...messagesNewestFirst].reverse();

  let latestMatch = null;

  for (let i = 0; i < chronological.length; i++) {
    const msg = chronological[i];
    const header = parseMenuHeader(msg?.content);
    if (!header) continue;
    if (targetCampus && header.campus.toLowerCase() !== targetCampus.toLowerCase()) {
      continue;
    }

    const chunks = [msg.content];
    const authorId = msg.author?.id;
    const baseTime = msg.createdTimestamp || 0;

    // Collect subsequent continuation chunks from the same author within 60s
    // until another `# <Campus> Campus` header is encountered.
    for (let j = i + 1; j < chronological.length; j++) {
      const next = chronological[j];
      if (!next?.content) continue;
      if (parseMenuHeader(next.content)) break;
      if (authorId && next.author?.id && next.author.id !== authorId) continue;
      if (baseTime && next.createdTimestamp && next.createdTimestamp - baseTime > 60_000) break;

      chunks.push(next.content);
      if (next.content.includes(FOOTER_SEPARATOR)) break;
    }

    latestMatch = {
      header,
      chunks,
      messageId: msg.id || null,
      messageObj: msg,
    };
  }

  return latestMatch;
}

/**
 * Read local relay state file (prevents duplicate posts across restarts without a DB).
 */
function readRelayState(stateFile = DEFAULT_STATE_FILE) {
  try {
    if (!fs.existsSync(stateFile)) return {};
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save local relay state file.
 */
function writeRelayState(state, stateFile = DEFAULT_STATE_FILE) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`Could not write relay state file: ${err.message}`);
  }
}

/**
 * Check whether a campus menu for `menuDate` was already relayed to WhatsApp.
 */
function wasAlreadyRelayed(campus, menuDate, stateFile = DEFAULT_STATE_FILE) {
  const state = readRelayState(stateFile);
  return state[campus]?.menuDate === menuDate;
}

/**
 * Record that a campus menu for `menuDate` was relayed to WhatsApp.
 */
function markRelayed(campus, menuDate, messageId = null, stateFile = DEFAULT_STATE_FILE) {
  const state = readRelayState(stateFile);
  state[campus] = {
    menuDate,
    messageId,
    relayedAt: new Date().toISOString(),
  };
  writeRelayState(state, stateFile);
}

/**
 * Attach a live `messageCreate` listener to a Discord client that buffers
 * incoming Lunch Bot menu chunks and forwards them to the configured WhatsApp
 * Channel(s) via WAHA.
 *
 * @param {import('discord.js').Client} client
 * @param {{
 *   watchChannelIds?: string[],
 *   sourceBotId?: string|null,
 *   chunkWaitMs?: number,
 *   stateFile?: string,
 *   force?: boolean,
 *   onRelayed?: (info: {campus: string, menuDate: string, chatId: string}) => Promise<void>|void
 * }} [options]
 */
function attachRelayListener(client, options = {}) {
  const watchChannelIds = (
    options.watchChannelIds ||
    (process.env.RELAY_DISCORD_CHANNEL_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const sourceBotId = options.sourceBotId || (process.env.RELAY_SOURCE_BOT_ID || '').trim() || null;
  const chunkWaitMs = options.chunkWaitMs ?? 2500;
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;

  // Active multi-chunk buffers keyed by `${channelId}:${authorId}`
  const pendingBuffers = new Map();

  async function flushBuffer(bufferKey) {
    const entry = pendingBuffers.get(bufferKey);
    if (!entry) return;
    pendingBuffers.delete(bufferKey);
    if (entry.timer) clearTimeout(entry.timer);

    const { header, chunks, messageId, firstMessage } = entry;
    const { campus, menuDate } = header;

    const cfg = whatsappPublisher.getConfig();
    const target = cfg.targets.find((t) => t.campus.toLowerCase() === campus.toLowerCase());
    if (!target) {
      logger.info(`⏭️  [Relay] Detected ${campus} menu in Discord, but ${campus} is not in WHATSAPP_CAMPUSES — ignoring`);
      return;
    }

    const whatsappText = convertDiscordMenuToWhatsapp(chunks);
    try {
      await whatsappPublisher.sendText(target.chatId, whatsappText);
      markRelayed(campus, menuDate, messageId, stateFile);
      if (firstMessage && typeof firstMessage.react === 'function') {
        await firstMessage.react('✅').catch(() => {});
      }
      if (typeof options.onRelayed === 'function') {
        await Promise.resolve(options.onRelayed({ campus, menuDate, chatId: target.chatId })).catch(() => {});
      }
      logger.info(`✅ [Relay] Forwarded ${campus} Campus menu (${menuDate}) from Discord → WhatsApp Channel (${target.chatId})`);
    } catch (err) {
      logger.error(`❌ [Relay] Failed to forward ${campus} menu to WhatsApp Channel: ${err.message}`);
    }
  }

  const handler = async (message) => {
    try {
      if (!message || !message.content) return;
      // Ignore our own messages if the relay shares a bot user that posts other things
      if (client.user && message.author?.id === client.user.id) return;

      if (watchChannelIds.length > 0 && !watchChannelIds.includes(message.channelId)) {
        return;
      }
      if (sourceBotId && message.author?.id !== sourceBotId) {
        return;
      }

      const bufferKey = `${message.channelId}:${message.author?.id || 'unknown'}`;
      const header = parseMenuHeader(message.content);

      if (header) {
        // If there was a previous unfinished buffer from this author, flush it first
        if (pendingBuffers.has(bufferKey)) {
          await flushBuffer(bufferKey);
        }

        logger.info(`📥 [Relay] Detected ${header.campus} Campus menu (${header.menuDate}) in Discord channel ${message.channelId}`);

        const entry = {
          header,
          chunks: [message.content],
          messageId: message.id || null,
          firstMessage: message,
          timer: null,
        };
        pendingBuffers.set(bufferKey, entry);

        // Wait briefly in case the menu was split across 2+ Discord messages
        entry.timer = setTimeout(() => {
          flushBuffer(bufferKey);
        }, chunkWaitMs);
        return;
      }

      // Check if this message is a continuation chunk for an active menu buffer
      if (pendingBuffers.has(bufferKey)) {
        const entry = pendingBuffers.get(bufferKey);
        entry.chunks.push(message.content);
        if (entry.timer) clearTimeout(entry.timer);

        // If the chunk contains the footer separator, it's the final chunk
        const delay = message.content.includes(FOOTER_SEPARATOR) ? Math.min(chunkWaitMs, 500) : chunkWaitMs;
        entry.timer = setTimeout(() => {
          flushBuffer(bufferKey);
        }, delay);
      }
    } catch (err) {
      logger.error(`❌ [Relay] Error handling Discord message: ${err.message}`);
    }
  };

  client.on('messageCreate', handler);
  return { handler, flushBuffer, pendingBuffers };
}

/**
 * Determine whether the current (hour, minute) matches the WhatsApp offline
 * alert schedule:
 *   - 7:00 AM
 *   - 8:00 AM
 *   - 9:00 AM, and every 20 minutes from 9:00 AM onward (9:00, 9:20, 9:40, 10:00, 10:20, ...)
 *
 * @param {number} hour   0–23
 * @param {number} minute 0–59
 * @returns {boolean}
 */
function isWhatsappOfflineAlertSlot(hour, minute) {
  if (hour === 7 && minute === 0) return true;
  if (hour === 8 && minute === 0) return true;
  if (hour >= 9 && hour <= 23 && minute % 20 === 0) return true;
  return false;
}

module.exports = {
  stripDiscordArtifacts,
  parseMenuHeader,
  convertDiscordMenuToWhatsapp,
  extractLatestMenuFromMessages,
  wasAlreadyRelayed,
  markRelayed,
  attachRelayListener,
  isWhatsappOfflineAlertSlot,
};
