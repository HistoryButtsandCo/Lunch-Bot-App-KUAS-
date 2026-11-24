/**
 * src/dashboard/publishRunner.js
 *
 * State-changing actions initiated from the admin dashboard: manually
 * dispatching a menu (for all subscribers, a single campus, a single Discord
 * server/channel, a specific date, or forced re-delivery).
 *
 * Two deliberate choices here.
 *
 * It does not await the publish. Posting to eight guilds takes long enough
 * that holding the HTTP request open invites a proxy or browser timeout to
 * report a failure for a run that actually succeeded. The request starts the
 * run and returns; the dashboard polls /api/overview, which carries the run
 * state, to see how it went.
 *
 * It reuses publishMenu() rather than reimplementing delivery. By default the
 * existing `hasSuccessfulDelivery` guard applies, so retrying a day skips
 * guilds that already succeeded and retries only the failed/missing ones. When
 * an operator explicitly passes `force: true` (e.g. after fixing a bad scrape
 * or replacing a deleted post), only the selected target is re-sent.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const menuPublisher = require('../publishers/menuPublisher');
const { KNOWN_CAMPUSES } = require('../utils/dataQuality');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNOWFLAKE_RE = /^\d{1,24}$/;

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  triggeredBy: null,
  target: null,
  summary: null,
};

/** Whether the trigger is configured at all. Without a token it stays off. */
function isEnabled() {
  return Boolean(process.env.DASHBOARD_TOKEN);
}

/**
 * Constant-time comparison of the supplied token against DASHBOARD_TOKEN.
 *
 * Returns false when no token is configured — the endpoint is opt-in, so an
 * unset DASHBOARD_TOKEN must never authorise anything. Length is compared
 * first because timingSafeEqual throws on a length mismatch.
 */
function isAuthorised(supplied) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected || typeof supplied !== 'string' || supplied.length === 0) return false;

  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/** A snapshot of the last/current run, for the overview payload. */
function getState() {
  return { enabled: isEnabled(), ...state };
}

/**
 * Validate and normalise optional dispatch targeting parameters supplied by the
 * dashboard (`campus`, `channelId`, `guildId`, `date`, `force`).
 *
 * @param {object} [raw]
 * @returns {{ok: true, options: object} | {ok: false, reason: string}}
 */
function normaliseDispatchOptions(raw = {}) {
  const out = { manual: true };

  if (raw.campus) {
    const campus = String(raw.campus).trim();
    if (!KNOWN_CAMPUSES.includes(campus)) {
      return { ok: false, reason: `Unknown campus "${campus}" (expected ${KNOWN_CAMPUSES.join(' or ')})` };
    }
    out.campus = campus;
  }

  if (raw.channelId) {
    const channelId = String(raw.channelId).trim();
    if (!SNOWFLAKE_RE.test(channelId)) {
      return { ok: false, reason: 'Invalid channelId (expected numeric Discord channel ID)' };
    }
    out.channelId = channelId;
  }

  if (raw.guildId) {
    const guildId = String(raw.guildId).trim();
    if (!SNOWFLAKE_RE.test(guildId)) {
      return { ok: false, reason: 'Invalid guildId (expected numeric Discord server ID)' };
    }
    out.guildId = guildId;
  }

  if (raw.date) {
    const date = String(raw.date).trim();
    if (!DATE_RE.test(date)) {
      return { ok: false, reason: 'Invalid date (expected YYYY-MM-DD)' };
    }
    out.date = date;
  }

  if (raw.force === true) {
    out.force = true;
  }

  return { ok: true, options: out };
}

/**
 * Kick off a publisher run.
 * @param {import('discord.js').Client} client
 * @param {string} [triggeredBy]
 * @param {{campus?: string, channelId?: string, guildId?: string, date?: string, force?: boolean}} [dispatchOptions]
 * @returns {{started: boolean, reason?: string}}
 */
function trigger(client, triggeredBy = 'dashboard', dispatchOptions = {}) {
  if (state.running) {
    return { started: false, reason: 'A publish run is already in progress' };
  }
  if (!client?.isReady?.()) {
    return { started: false, reason: 'Discord client is not connected' };
  }

  const parsed = normaliseDispatchOptions(dispatchOptions);
  if (!parsed.ok) {
    return { started: false, reason: parsed.reason };
  }

  const runOptions = parsed.options;

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.triggeredBy = triggeredBy;
  state.target = {
    campus: runOptions.campus || null,
    channelId: runOptions.channelId || null,
    guildId: runOptions.guildId || null,
    date: runOptions.date || null,
    force: Boolean(runOptions.force),
  };
  state.summary = null;

  const targetDesc = [
    runOptions.campus || 'all campuses',
    runOptions.channelId ? `channel=${runOptions.channelId}` : runOptions.guildId ? `guild=${runOptions.guildId}` : 'all servers',
    runOptions.date ? `date=${runOptions.date}` : 'today',
    runOptions.force ? 'force=true' : null,
  ]
    .filter(Boolean)
    .join(', ');

  logger.info(`🖥️  Manual publish triggered from ${triggeredBy} (${targetDesc})`);

  // Detached on purpose — see the module comment. publishMenu already handles
  // and logs its own errors, so the catch here is for anything it rethrows.
  menuPublisher
    .publishMenu(client, runOptions)
    .then((summary) => {
      if (summary) {
        state.summary = summary;
        if (summary.error) state.error = summary.error;
      }
    })
    .catch((err) => {
      state.error = err.message;
      logger.error(`Manual publish failed: ${err.message}`);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    });

  return { started: true };
}

module.exports = { trigger, getState, isAuthorised, isEnabled, normaliseDispatchOptions };
