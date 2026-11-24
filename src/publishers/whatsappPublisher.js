/**
 * src/publishers/whatsappPublisher.js
 *
 * Publishes daily campus menus to a WhatsApp Channel (@newsletter) via a
 * self-hosted WAHA (WhatsApp HTTP API) instance.
 *
 * Zero new dependencies — uses Node's built-in http/https modules.
 *
 * Configure in .env:
 *   WAHA_API_URL              — e.g. http://localhost:3001
 *   WAHA_API_KEY              — optional X-Api-Key secret configured on WAHA
 *   WAHA_SESSION              — WAHA session name (default: 'default')
 *   WHATSAPP_CHANNEL_ID       — target channel JID, e.g. 120363...@newsletter
 *   WHATSAPP_CAMPUSES         — comma-separated campuses (default: 'Uzumasa')
 *   WHATSAPP_CHANNEL_ID_UZUMASA / WHATSAPP_CHANNEL_ID_KAMEOKA — optional per-campus overrides
 */

const http = require('http');
const https = require('https');
const db = require('../db');
const logger = require('../utils/logger');
const { formatMenuForWhatsapp } = require('../utils/formatMenu');
const { todayCampus } = require('../utils/campusDate');
const { MIN_ITEMS_PER_DAY } = require('../utils/dataQuality');

// Sentinel numeric guild_id used in bot_delivery_log for WhatsApp Channel posts.
// The live bot_delivery_log table uses BIGINT for guild_id and channel_id
// (Discord snowflakes are 18-digit integers), so '0' fits the column type
// without a schema migration and never collides with a Discord snowflake.
const WHATSAPP_GUILD_ID = '0';
const MAX_PG_BIGINT = 9223372036854775807n;

/**
 * Ensure a channel ID carries the `@newsletter` suffix (unless another suffix
 * like `@c.us` or `@g.us` was explicitly provided).
 *
 * @param {string|null|undefined} rawId
 * @returns {string|null}
 */
function normaliseChannelId(rawId) {
  if (!rawId) return null;
  const trimmed = String(rawId).trim();
  if (!trimmed) return null;
  const inviteMatch = trimmed.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (inviteMatch) return `invite:${inviteMatch[1]}`;
  if (trimmed.startsWith('invite:')) return trimmed;
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@newsletter`;
}

/**
 * Extract the numeric portion of a WhatsApp JID if it fits inside a PostgreSQL
 * signed 64-bit BIGINT (for bot_delivery_log.channel_id). Returns null when it
 * cannot be represented as a BIGINT — channel_id is nullable in the schema.
 *
 * @param {string|null|undefined} chatId
 * @returns {string|null}
 */
function channelIdToDbBigint(chatId) {
  if (!chatId) return null;
  const prefix = String(chatId).split('@')[0].trim();
  if (!/^\d+$/.test(prefix)) return null;
  try {
    const val = BigInt(prefix);
    return val <= MAX_PG_BIGINT ? prefix : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current WAHA + WhatsApp Channel configuration from environment
 * variables.
 *
 * @returns {{
 *   apiUrl: string,
 *   apiKey: string|null,
 *   session: string,
 *   targets: Array<{campus: string, chatId: string}>
 * }}
 */
function canonicalCampusName(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (lower === 'uzumasa') return 'Uzumasa';
  if (lower === 'kameoka') return 'Kameoka';
  return String(raw || '').trim();
}

function getConfig() {
  const apiUrl = (process.env.WAHA_API_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.WAHA_API_KEY || '').trim() || null;
  const session = (process.env.WAHA_SESSION || 'default').trim() || 'default';

  const defaultChannel = normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID);
  const rawCampuses = (process.env.WHATSAPP_CAMPUSES || '').trim();

  const campusSet = new Set();
  if (rawCampuses.toLowerCase() === 'all' || rawCampuses.toLowerCase() === 'both') {
    campusSet.add('Uzumasa');
    campusSet.add('Kameoka');
  } else if (rawCampuses) {
    for (const part of rawCampuses.split(',')) {
      const c = canonicalCampusName(part);
      if (c) campusSet.add(c);
    }
  }

  // Always auto-enable a campus when its dedicated WHATSAPP_CHANNEL_ID_<CAMPUS>
  // env var is explicitly configured, even if WHATSAPP_CAMPUSES only listed Uzumasa.
  if (normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID_UZUMASA)) {
    campusSet.add('Uzumasa');
  }
  if (normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID_KAMEOKA)) {
    campusSet.add('Kameoka');
  }

  // Fallback when WHATSAPP_CAMPUSES is unset and only WHATSAPP_CHANNEL_ID is set
  if (campusSet.size === 0 && defaultChannel) {
    campusSet.add('Uzumasa');
  }

  const targets = [];
  if (apiUrl) {
    for (const campus of campusSet) {
      const envKey = `WHATSAPP_CHANNEL_ID_${campus.toUpperCase()}`;
      const chatId = normaliseChannelId(process.env[envKey]) || defaultChannel;
      if (chatId) {
        targets.push({ campus, chatId });
      }
    }
  }

  return { apiUrl, apiKey, session, targets };
}

/** Whether WAHA and at least one target WhatsApp Channel are configured. */
function isConfigured() {
  const cfg = getConfig();
  return Boolean(cfg.apiUrl && cfg.targets.length > 0);
}

/**
 * Low-level HTTP/HTTPS JSON request helper for WAHA endpoints.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} endpointPath e.g. '/api/sendText'
 * @param {object|null} [body]
 * @param {{apiUrl?: string, apiKey?: string|null, timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
async function requestWaha(method, endpointPath, body = null, options = {}) {
  const cfg = getConfig();
  const baseUrl = (options.apiUrl || cfg.apiUrl || 'http://localhost:3001').replace(/\/+$/, '');
  const apiKey = options.apiKey !== undefined ? options.apiKey : cfg.apiKey;
  const timeoutMs = options.timeoutMs || 15_000;

  const url = new URL(`${baseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`);
  const client = url.protocol === 'https:' ? https : http;

  const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
  const headers = {
    Accept: 'application/json',
  };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              // keep raw string
            }
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const detail =
              typeof parsed === 'object' && parsed !== null
                ? parsed.message || parsed.error || JSON.stringify(parsed)
                : raw || res.statusMessage;
            const err = new Error(`WAHA ${method} ${endpointPath} failed (HTTP ${res.statusCode}): ${detail}`);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`WAHA ${method} ${endpointPath} timed out after ${timeoutMs}ms`));
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Send a text message to a WhatsApp Channel (or chat) via WAHA `POST /api/sendText`.
 *
 * @param {string} chatId e.g. '120363...@newsletter'
 * @param {string} text   WhatsApp-formatted message body
 * @param {{apiUrl?: string, apiKey?: string|null, session?: string}} [options]
 */
async function sendText(chatId, text, options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  const normalisedId = normaliseChannelId(chatId);
  if (!normalisedId) {
    throw new Error('WhatsApp chatId is required');
  }

  return whatsappPublisher.requestWaha(
    'POST',
    '/api/sendText',
    {
      session,
      chatId: normalisedId,
      text,
    },
    options
  );
}

/**
 * List WhatsApp Channels accessible to the linked WAHA session.
 *
 * @param {'OWNER'|'ADMIN'|'SUBSCRIBER'|null} [role] optional role filter
 * @param {{apiUrl?: string, apiKey?: string|null, session?: string}} [options]
 */
async function listChannels(role = null, options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (options.invite) params.set('invite', options.invite);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return whatsappPublisher.requestWaha(
    'GET',
    `/api/${encodeURIComponent(session)}/channels${qs}`,
    null,
    options
  );
}

/**
 * Fetch the current WAHA session status (e.g. WORKING, SCAN_QR_CODE, STOPPED).
 */
async function getSession(options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  return whatsappPublisher.requestWaha(
    'GET',
    `/api/sessions/${encodeURIComponent(session)}`,
    null,
    options
  );
}

/**
 * Create/start the configured WAHA session if it is stopped or missing.
 */
async function startSession(options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  try {
    return await whatsappPublisher.requestWaha(
      'POST',
      `/api/sessions/${encodeURIComponent(session)}/start`,
      {},
      options
    );
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 422) {
      return whatsappPublisher.requestWaha(
        'POST',
        '/api/sessions',
        { name: session, start: true },
        options
      );
    }
    throw err;
  }
}

/**
 * Request an 8-character phone pairing code from WAHA so the operator can link
 * WhatsApp from a remote SSH terminal without scanning a QR code.
 *
 * @param {string} phoneNumber international format, e.g. '819012345678'
 */
async function requestPairingCode(phoneNumber, options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  const cleaned = String(phoneNumber || '').replace(/[^\d]/g, '');
  if (!cleaned) {
    throw new Error('A phone number in international format (digits only, e.g. 819012345678) is required');
  }

  return whatsappPublisher.requestWaha(
    'POST',
    `/api/${encodeURIComponent(session)}/auth/request-code`,
    { phoneNumber: cleaned },
    options
  );
}

/**
 * Fetch the raw QR code payload for linking a device.
 */
async function getQrCode(format = 'raw', options = {}) {
  const cfg = getConfig();
  const session = options.session || cfg.session;
  return whatsappPublisher.requestWaha(
    'GET',
    `/api/${encodeURIComponent(session)}/auth/qr?format=${encodeURIComponent(format)}`,
    null,
    options
  );
}

/**
 * Publish one campus's menu to a WhatsApp Channel via WAHA, using the same
 * incomplete-scrape and duplicate-delivery guards as Discord delivery.
 *
 * @param {string} campus 'Uzumasa' or 'Kameoka'
 * @param {string} chatId target WhatsApp Channel JID ('120363...@newsletter')
 * @param {{
 *   today?: string,
 *   menuItems?: object[],
 *   ratingsMap?: Map,
 *   fallbackPrices?: Map,
 *   force?: boolean,
 *   skipDbLog?: boolean
 * }} [options]
 * @returns {Promise<{status: 'success'|'skipped'|'failed', anyMenuAvailable: boolean, reason?: string, error?: string, message?: string}>}
 */
async function publishCampusToWhatsapp(campus, chatId, options = {}) {
  const today = options.today || todayCampus();
  const normalisedChatId = normaliseChannelId(chatId);
  const channelDbId = channelIdToDbBigint(normalisedChatId);
  const skipDbLog = options.skipDbLog === true;

  try {
    const menuItems = options.menuItems !== undefined
      ? options.menuItems
      : await db.getTodayMenu(campus);

    if (!menuItems || menuItems.length === 0) {
      logger.warn(`⚠️ [WhatsApp] No menu items found for ${campus} Campus (${today}) — skipping`);
      if (!skipDbLog) {
        await db
          .logDelivery(WHATSAPP_GUILD_ID, channelDbId, campus, today, 'skipped', 'No menu published for this date')
          .catch((err) => logger.error(`Failed to log WhatsApp skip: ${err.message}`));
      }
      return { status: 'skipped', reason: 'no_menu', anyMenuAvailable: false };
    }

    if (menuItems.length < MIN_ITEMS_PER_DAY) {
      logger.warn(
        `⚠️ [WhatsApp] Only ${menuItems.length} item(s) for ${campus} Campus (${today}, expected at least ${MIN_ITEMS_PER_DAY}) — skipping incomplete scrape`
      );
      if (!skipDbLog) {
        await db
          .logDelivery(
            WHATSAPP_GUILD_ID,
            channelDbId,
            campus,
            today,
            'skipped',
            `Only ${menuItems.length} item(s) for this date — suspected incomplete scrape`
          )
          .catch((err) => logger.error(`Failed to log WhatsApp skip: ${err.message}`));
      }
      return { status: 'skipped', reason: 'incomplete_scrape', anyMenuAvailable: false };
    }

    if (!options.force && !skipDbLog) {
      const alreadySent = await db.hasSuccessfulDelivery(WHATSAPP_GUILD_ID, campus, today);
      if (alreadySent) {
        logger.info(`⏭️  Skipped WhatsApp Channel (${campus}): already sent today`);
        return { status: 'skipped', reason: 'already_sent', anyMenuAvailable: true };
      }
    }

    const dishNames = [...new Set(menuItems.map((d) => d.dish_name))];
    const ratingsMap = options.ratingsMap !== undefined
      ? options.ratingsMap
      : await db.getRatingsForDishes(dishNames, campus);
    const fallbackPrices = options.fallbackPrices !== undefined
      ? options.fallbackPrices
      : await db.getLastKnownPrices(campus);

    const message = formatMenuForWhatsapp(menuItems, ratingsMap, campus, fallbackPrices);

    await whatsappPublisher.sendText(normalisedChatId, message);

    if (!skipDbLog) {
      await db.logDelivery(WHATSAPP_GUILD_ID, channelDbId, campus, today, 'success', null);
    }
    logger.info(`✅ Sent ${campus} Campus menu to WhatsApp Channel (${normalisedChatId})`);
    return { status: 'success', anyMenuAvailable: true, message };
  } catch (error) {
    logger.error(`❌ Error sending ${campus} menu to WhatsApp Channel (${normalisedChatId}): ${error.message}`);
    if (!skipDbLog) {
      await db
        .logDelivery(WHATSAPP_GUILD_ID, channelDbId, campus, today, 'failed', error.message)
        .catch((err) => logger.error(`Failed to log WhatsApp delivery error: ${err.message}`));
    }
    return { status: 'failed', anyMenuAvailable: true, error: error.message };
  }
}

const whatsappPublisher = {
  WHATSAPP_GUILD_ID,
  normaliseChannelId,
  channelIdToDbBigint,
  getConfig,
  isConfigured,
  requestWaha,
  sendText,
  listChannels,
  getSession,
  startSession,
  requestPairingCode,
  getQrCode,
  publishCampusToWhatsapp,
};

module.exports = whatsappPublisher;
