/**
 * src/dashboard/auth.js
 *
 * Zero-dependency Discord-role-based authentication for the admin dashboard.
 *
 * How it works:
 *   1. Server admins with any role listed in `DASHBOARD_ADMIN_ROLE_ID` run
 *      `/dashboard` inside Discord.
 *   2. The bot verifies their Discord role live and mints a 5-minute,
 *      single-use login ticket URL (`/dashboard/auth?ticket=...`).
 *   3. Clicking the link exchanges the ticket for a 24-hour HMAC-SHA256 signed
 *      HttpOnly cookie (`wfl_admin_session`) — no OAuth2 redirect-URI setup
 *      required, and no shared secret token to copy-paste.
 *
 * Works seamlessly alongside the existing `DASHBOARD_TOKEN` header auth.
 */

const crypto = require('crypto');
const { PermissionsBitField } = require('discord.js');

const COOKIE_NAME = 'wfl_admin_session';
const TICKET_TTL_MS = 5 * 60 * 1000;       // 5 minutes (one-time use)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PENDING_TICKETS = 200;

/** @type {Map<string, {userId: string, username: string, guildId: string|null, roleIds: string[], expiresAt: number}>} */
const pendingTickets = new Map();

// Process-scoped fallback secret only used when no env secret is available (e.g. unit tests)
const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

/**
 * Return configured Discord admin role IDs from `DASHBOARD_ADMIN_ROLE_ID`
 * (supports a single ID or comma-separated list of IDs).
 *
 * @returns {string[]}
 */
function getAllowedRoleIds() {
  const raw = (process.env.DASHBOARD_ADMIN_ROLE_ID || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d{17,20}$/.test(id));
}

/** Whether Discord role-based dashboard access is configured. */
function isRoleAuthEnabled() {
  return getAllowedRoleIds().length > 0;
}

/**
 * Resolve the public base URL used in `/dashboard` login links.
 * Falls back to `http://localhost:<HEALTH_PORT>`.
 */
function getPublicDashboardUrl() {
  const configured = (process.env.DASHBOARD_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const port = parseInt(process.env.HEALTH_PORT, 10) || 3000;
  return `http://localhost:${port}`;
}

/**
 * Check whether a Discord GuildMember is allowed to open the dashboard and
 * push admin commands.
 *
 * - When `DASHBOARD_ADMIN_ROLE_ID` is set: requires at least one matching role
 *   (or `BOT_ADMIN_ID` match as an owner override).
 * - When `DASHBOARD_ADMIN_ROLE_ID` is unset: falls back to Discord's built-in
 *   `Administrator` permission (or `BOT_ADMIN_ID`).
 *
 * @param {object} member Discord.js GuildMember (or test stub)
 * @returns {boolean}
 */
function memberHasDashboardAccess(member) {
  if (!member) return false;

  const userId = String(member.id || member.user?.id || '');
  const botAdminId = (process.env.BOT_ADMIN_ID || '').trim();
  if (botAdminId && userId && userId === botAdminId) return true;

  const allowedRoles = getAllowedRoleIds();
  if (allowedRoles.length > 0) {
    const cache = member.roles?.cache;
    if (cache && typeof cache.has === 'function') {
      return allowedRoles.some((roleId) => cache.has(roleId));
    }
    if (Array.isArray(member.roles)) {
      return allowedRoles.some((roleId) => member.roles.includes(roleId));
    }
    return false;
  }

  // Fallback when DASHBOARD_ADMIN_ROLE_ID is not configured
  const perms = member.permissions;
  if (perms && typeof perms.has === 'function') {
    return perms.has(PermissionsBitField.Flags.Administrator) || perms.has('Administrator');
  }
  return false;
}

function signingKey() {
  const material =
    (process.env.DASHBOARD_SESSION_SECRET || '').trim() ||
    (process.env.DASHBOARD_TOKEN || '').trim() ||
    (process.env.DISCORD_BOT_TOKEN || '').trim() ||
    EPHEMERAL_FALLBACK_SECRET;
  return crypto.createHash('sha256').update(`wfl-dashboard-session:${material}`).digest();
}

function pruneExpiredTickets(now = Date.now()) {
  for (const [key, entry] of pendingTickets.entries()) {
    if (entry.expiresAt <= now) pendingTickets.delete(key);
  }
}

/**
 * Mint a single-use, short-lived login ticket for an authenticated Discord admin.
 *
 * @param {{userId: string, username: string, guildId?: string|null, roleIds?: string[]}} identity
 * @returns {{ticket: string, expiresAt: string, url: string}}
 */
function createLoginTicket({ userId, username, guildId = null, roleIds = [] }) {
  const now = Date.now();
  pruneExpiredTickets(now);

  // Guard against unbounded memory growth if spammed
  while (pendingTickets.size >= MAX_PENDING_TICKETS) {
    const oldestKey = pendingTickets.keys().next().value;
    if (!oldestKey) break;
    pendingTickets.delete(oldestKey);
  }

  const ticket = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + TICKET_TTL_MS;
  pendingTickets.set(ticket, {
    userId: String(userId),
    username: String(username || 'Admin'),
    guildId: guildId ? String(guildId) : null,
    roleIds: Array.isArray(roleIds) ? roleIds.map(String) : [],
    expiresAt,
  });

  const baseUrl = getPublicDashboardUrl();
  return {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
    url: `${baseUrl}/dashboard/auth?ticket=${encodeURIComponent(ticket)}`,
  };
}

/**
 * Consume a single-use login ticket. Returns the admin identity on first valid
 * use, or null if unknown/expired/already used.
 *
 * @param {string} ticket
 */
function consumeLoginTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return null;
  const now = Date.now();
  pruneExpiredTickets(now);

  const entry = pendingTickets.get(ticket.trim());
  if (!entry) return null;
  pendingTickets.delete(ticket.trim());

  if (entry.expiresAt <= now) return null;
  return {
    userId: entry.userId,
    username: entry.username,
    guildId: entry.guildId,
    roleIds: entry.roleIds,
  };
}

function signPayload(encodedPayload) {
  return crypto.createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
}

/**
 * Create a signed session cookie value for an authenticated Discord admin.
 *
 * @param {{userId: string, username: string, guildId?: string|null}} identity
 * @returns {string}
 */
function createSessionToken({ userId, username, guildId = null }) {
  const payload = {
    uid: String(userId),
    name: String(username || 'Admin'),
    gid: guildId ? String(guildId) : null,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

/**
 * Parse a `Cookie` header into a key/value map.
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

/**
 * Verify a signed `wfl_admin_session` token string.
 *
 * @param {string|null|undefined} token
 * @returns {{userId: string, username: string, guildId: string|null, exp: number}|null}
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const suppliedSig = token.slice(dot + 1);
  if (!encoded || !suppliedSig) return null;

  const expectedSig = signPayload(encoded);
  const a = Buffer.from(suppliedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) return null;
    if (!parsed.uid) return null;
    return {
      userId: String(parsed.uid),
      username: String(parsed.name || 'Admin'),
      guildId: parsed.gid ? String(parsed.gid) : null,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Extract and verify the admin session from an incoming HTTP request.
 * If the bot has the member in cache and their admin role was revoked, deny access.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('discord.js').Client|null} [client]
 */
function getSessionFromRequest(req, client = null) {
  const cookies = parseCookies(req?.headers?.cookie);
  const raw = cookies[COOKIE_NAME];
  const session = verifySessionToken(raw);
  if (!session) return null;

  // Live role revocation check when the member is cached in Discord.js
  if (client?.isReady?.() && session.guildId && isRoleAuthEnabled()) {
    const guild = client.guilds?.cache?.get?.(session.guildId);
    const cachedMember = guild?.members?.cache?.get?.(session.userId);
    if (cachedMember && !memberHasDashboardAccess(cachedMember)) {
      return null;
    }
  }

  return session;
}

function isSecureRequest(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  return proto === 'https' || Boolean(req?.socket?.encrypted) || getPublicDashboardUrl().startsWith('https://');
}

function buildSetCookieHeader(token, req) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function buildClearCookieHeader(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function _resetForTesting() {
  pendingTickets.clear();
}

module.exports = {
  COOKIE_NAME,
  getAllowedRoleIds,
  isRoleAuthEnabled,
  getPublicDashboardUrl,
  memberHasDashboardAccess,
  createLoginTicket,
  consumeLoginTicket,
  createSessionToken,
  verifySessionToken,
  getSessionFromRequest,
  buildSetCookieHeader,
  buildClearCookieHeader,
  _resetForTesting,
};
