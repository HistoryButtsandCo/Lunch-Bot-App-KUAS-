/**
 * src/server.js
 *
 * The bot's HTTP surface: the Uptime Kuma health endpoint, and the local admin
 * dashboard. Uses Node's built-in http module — no Express dependency.
 *
 * Health returns 503 only for unambiguous failures: the database being
 * unreachable, or Discord being disconnected. Delivery staleness is reported as
 * data rather than failed on, because zero deliveries is legitimate while the
 * cafeteria is closed — that judgement needs menu-availability context the
 * publisher has and this endpoint does not.
 *
 * `/` and `/api/status` are load-bearing for monitoring and their core fields
 * are unchanged by the dashboard, with additive connection telemetry (latency,
 * gateway ping, pool counters, scheduler horizon) layered alongside them.
 *
 * Access control: the read endpoints are open when DASHBOARD_TOKEN is unset,
 * which suits a bot reachable only on a home LAN. Setting DASHBOARD_TOKEN locks
 * every dashboard endpoint behind it. State-changing actions (`/api/publish`
 * and `/api/repair`) always require the token and are disabled entirely without
 * one — an unset token must never authorise a write.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./db');
const logger = require('./utils/logger');
const { todayCampus, datesBetween, shiftDate, isWeekday } = require('./utils/campusDate');
const { formatMenuMessage } = require('./utils/formatMenu');
const { checkMenuData, publishingDays, KNOWN_CAMPUSES } = require('./utils/dataQuality');
const { buildOverview } = require('./dashboard/overview');
const logTail = require('./dashboard/logTail');
const publishRunner = require('./dashboard/publishRunner');
const dashboardAuth = require('./dashboard/auth');
const menuPublisher = require('./publishers/menuPublisher');

let startTime = null; // set when the bot comes online
let clientRef = null; // reference to Discord client for guild count

const PORT = parseInt(process.env.HEALTH_PORT, 10) || 3000;

const DASHBOARD_HTML = path.join(__dirname, 'dashboard', 'index.html');

/** Clamped so a stray ?days=100000 cannot ask Postgres for the whole table. */
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 120;
const MAX_JSON_BODY_BYTES = 16 * 1024;

async function buildStatus() {
  const discordConnected = clientRef?.isReady?.() ?? false;
  const rawPing = clientRef?.ws?.ping;
  const wsPingMs =
    discordConnected && typeof rawPing === 'number' && Number.isFinite(rawPing) && rawPing >= 0
      ? Math.round(rawPing)
      : null;

  let databaseConnected = true;
  let dbLatencyMs = null;
  try {
    const pingRes = await db.ping();
    if (pingRes && typeof pingRes.latencyMs === 'number') {
      dbLatencyMs = pingRes.latencyMs;
    }
  } catch (err) {
    databaseConnected = false;
    logger.warn(`Health check: database unreachable — ${err.message}`);
  }

  let lastDelivery = null;
  let daysSinceLastDelivery = null;
  let pipelineHorizon = [];
  if (databaseConnected) {
    const [row, horizon] = await Promise.all([
      db.getLastSuccessfulDelivery(),
      typeof db.getPipelineHorizon === 'function' ? db.getPipelineHorizon() : Promise.resolve([]),
    ]);
    pipelineHorizon = horizon;
    if (row) {
      lastDelivery = { menuDate: row.menu_date, deliveredAt: row.delivered_at };
      const today = todayCampus();
      const msPerDay = 24 * 60 * 60 * 1000;
      daysSinceLastDelivery = Math.round(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.menu_date}T00:00:00Z`)) / msPerDay
      );
    }
  }

  const healthy = discordConnected && databaseConnected;
  const mem = process.memoryUsage();

  return {
    status: healthy ? 'online' : 'degraded',
    healthy,
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    guilds: clientRef?.guilds?.cache?.size ?? 0,
    discordConnected,
    databaseConnected,
    lastDelivery,
    daysSinceLastDelivery,
    // Extended connection & runtime telemetry for the admin dashboard
    botUser: clientRef?.user?.tag || null,
    wsPingMs,
    dbLatencyMs,
    dbPool: typeof db.getPoolStats === 'function' ? db.getPoolStats() : null,
    pipelineHorizon,
    scheduler: typeof menuPublisher.getSchedulerInfo === 'function' ? menuPublisher.getSchedulerInfo() : null,
    host: {
      hostname: os.hostname(),
      nodeVersion: process.version,
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      serverTime: new Date().toISOString(),
      todayJst: todayCampus(),
    },
  };
}

/**
 * Inspect live Discord cache state for a subscribed guild/channel so the
 * dashboard can surface broken permissions or deleted channels before 06:00 JST.
 */
function inspectSubscriptionConnection(client, sub) {
  const guildId = String(sub.guild_id);
  const channelId = String(sub.channel_id);
  const base = {
    guildId,
    guildName: sub.guild_name,
    channelId,
    channelName: sub.channel_name,
    roleId: sub.role_id ? String(sub.role_id) : null,
    campus: sub.campus,
    subscribedAt: sub.subscribed_at,
  };

  if (!client?.isReady?.()) {
    return {
      ...base,
      botInGuild: false,
      channelReachable: false,
      canSend: false,
      connectionStatus: 'offline',
      connectionDetail: 'Discord bot is disconnected',
    };
  }

  const guild = client.guilds?.cache?.get?.(guildId) || null;
  if (!guild) {
    return {
      ...base,
      botInGuild: false,
      channelReachable: false,
      canSend: false,
      connectionStatus: 'missing-guild',
      connectionDetail: 'Bot is no longer in this Discord server',
    };
  }

  const channel = guild.channels?.cache?.get?.(channelId) || client.channels?.cache?.get?.(channelId) || null;
  if (!channel) {
    return {
      ...base,
      guildName: guild.name || base.guildName,
      botInGuild: true,
      channelReachable: false,
      canSend: false,
      connectionStatus: 'missing-channel',
      connectionDetail: 'Target channel not found or hidden from bot',
    };
  }

  const me = guild.members?.me;
  const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  const canView = perms ? perms.has('ViewChannel') : true;
  const canSend = perms ? perms.has('SendMessages') : Boolean(me);

  if (!canView || !canSend) {
    return {
      ...base,
      guildName: guild.name || base.guildName,
      channelName: channel.name || base.channelName,
      botInGuild: true,
      channelReachable: true,
      canSend: false,
      connectionStatus: 'missing-permission',
      connectionDetail: !canView ? 'Missing ViewChannel permission' : 'Missing SendMessages permission',
    };
  }

  return {
    ...base,
    guildName: guild.name || base.guildName,
    channelName: channel.name || base.channelName,
    botInGuild: true,
    channelReachable: true,
    canSend: true,
    connectionStatus: 'ready',
    connectionDetail: 'Connected & permitted to post',
  };
}

// ─── Dashboard payloads ──────────────────────────────────────────────────────

async function buildDashboardOverview(days) {
  const today = todayCampus();
  // Inclusive of today, so `days=14` means "the last fortnight up to now".
  const from = shiftDate(today, -(days - 1));

  const [subscriptions, menuCounts, deliveries, nextMenus] = await Promise.all([
    db.getActiveSubscriptions(),
    db.getMenuCountsBetween(from, today),
    db.getDeliveriesBetween(from, today),
    Promise.all(
      KNOWN_CAMPUSES.map(async (campus) => {
        try {
          const next = await db.getNextMenu(campus);
          return { campus, menuDate: next.menuDate, itemCount: next.items.length };
        } catch {
          return { campus, menuDate: null, itemCount: 0 };
        }
      })
    ),
  ]);

  const overview = buildOverview({
    // Newest first — the dashboard reads top-down and today is what you came for.
    dates: datesBetween(from, today).reverse(),
    today,
    subscriptions,
    menuCounts,
    deliveries,
  });

  return {
    ...overview,
    publish: publishRunner.getState(),
    nextMenus,
    subscriptions: subscriptions.map((sub) => inspectSubscriptionConnection(clientRef, sub)),
  };
}

async function buildDataHealth() {
  const windowDays = Math.min(Math.max(parseInt(process.env.DATA_CHECK_WINDOW_DAYS, 10) || 21, 1), 90);
  const today = todayCampus();
  const to = shiftDate(today, windowDays);

  const [repairPreview, rows] = await Promise.all([
    db.repairUnknownCampus(today, to, { apply: false }).catch((err) => ({
      examined: 0,
      relabelled: 0,
      deleted: 0,
      skipped: 0,
      groups: [],
      error: err.message,
    })),
    db.getMenuItemsBetween(today, to),
  ]);

  const publishedWeekdays = publishingDays(rows).filter(isWeekday);
  const quality = checkMenuData(rows, publishedWeekdays);

  // Build upcoming per-day coverage matrix so the operator sees every date at a glance
  const coverageByDate = publishedWeekdays.map((date) => {
    const perCampus = {};
    for (const campus of KNOWN_CAMPUSES) {
      const items = rows.filter((r) => r.campus === campus && r.menu_date === date);
      const priced = items.filter((r) => r.price !== null && r.price !== undefined && r.price !== '').length;
      perCampus[campus] = { count: items.length, priced };
    }
    return { date, campuses: perCampus };
  });

  return {
    from: today,
    to,
    windowDays,
    ok: quality.ok && repairPreview.relabelled === 0 && repairPreview.skipped === 0,
    problems: quality.problems,
    checked: quality.checked,
    repairPreview,
    coverage: coverageByDate,
  };
}

async function buildMenuPreview(campus, date) {
  const safeCampus = KNOWN_CAMPUSES.includes(campus) ? campus : 'Uzumasa';
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todayCampus();

  const items = await db.getMenuByDate(targetDate, safeCampus);
  if (!items || items.length === 0) {
    return {
      campus: safeCampus,
      date: targetDate,
      itemCount: 0,
      chunks: [],
      totalChars: 0,
    };
  }

  const dishNames = [...new Set(items.map((d) => d.dish_name))];
  const [ratingsMap, fallbackPrices] = await Promise.all([
    db.getRatingsForDishes(dishNames, safeCampus),
    db.getLastKnownPrices(safeCampus, targetDate),
  ]);

  const chunks = formatMenuMessage(items, ratingsMap, safeCampus, fallbackPrices);
  return {
    campus: safeCampus,
    date: targetDate,
    itemCount: items.length,
    chunks,
    totalChars: chunks.reduce((sum, c) => sum + c.length, 0),
  };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

/** Header or query string — the header for the page, the query for curl. */
function suppliedToken(req, url) {
  return req.headers['x-dashboard-token'] || url.searchParams.get('token') || '';
}

function isAuthConfigured() {
  return publishRunner.isEnabled() || dashboardAuth.isRoleAuthEnabled();
}

/**
 * Resolve the authenticated admin actor from either a valid DASHBOARD_TOKEN
 * or a signed Discord-role session cookie issued via `/dashboard`.
 *
 * @returns {{type: 'token'|'discord', username: string, userId?: string, guildId?: string|null}|null}
 */
function resolveActor(req, url) {
  if (publishRunner.isEnabled() && publishRunner.isAuthorised(suppliedToken(req, url))) {
    return { type: 'token', username: 'Token Admin' };
  }
  const session = dashboardAuth.getSessionFromRequest(req, clientRef);
  if (session) {
    return {
      type: 'discord',
      userId: session.userId,
      username: session.username,
      guildId: session.guildId,
    };
  }
  return null;
}

function formatActorLabel(actor, req) {
  if (actor?.type === 'discord') {
    return `dashboard (@${actor.username} / ${actor.userId})`;
  }
  return `dashboard (${req.socket?.remoteAddress || 'token'})`;
}

/**
 * Gate for the dashboard's read endpoints. Open when neither DASHBOARD_TOKEN
 * nor DASHBOARD_ADMIN_ROLE_ID is configured; strict when either is set.
 * Returns the actor (or `{ type: 'open' }`) if allowed, or null if rejected.
 */
function guardRead(req, res, url) {
  if (!isAuthConfigured()) return { type: 'open', username: 'LAN Guest' };
  const actor = resolveActor(req, url);
  if (actor) return actor;

  sendJson(res, 401, {
    error: 'Unauthorised',
    roleAuthEnabled: dashboardAuth.isRoleAuthEnabled(),
    tokenAuthEnabled: publishRunner.isEnabled(),
    hint: dashboardAuth.isRoleAuthEnabled()
      ? 'Run /dashboard in Discord with an authorised Admin role, or supply X-Dashboard-Token'
      : 'Supply the X-Dashboard-Token header',
  });
  return null;
}

/**
 * Gate for state-changing endpoints (`/api/publish`, `/api/repair`, `/api/command`).
 * Disabled completely when neither DASHBOARD_TOKEN nor DASHBOARD_ADMIN_ROLE_ID is set.
 */
function guardWrite(req, res, url) {
  if (!isAuthConfigured()) {
    sendJson(res, 503, {
      error: 'Dashboard write actions are disabled',
      hint: 'Set DASHBOARD_ADMIN_ROLE_ID or DASHBOARD_TOKEN in .env and restart the bot',
    });
    return null;
  }
  const actor = resolveActor(req, url);
  if (!actor) {
    logger.warn(`🔒 Rejected unauthorised dashboard write attempt on ${url.pathname} from ${req.socket?.remoteAddress}`);
    sendJson(res, 401, {
      error: 'Unauthorised',
      roleAuthEnabled: dashboardAuth.isRoleAuthEnabled(),
      tokenAuthEnabled: publishRunner.isEnabled(),
    });
    return null;
  }
  return actor;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // ── Health: unchanged contract, no auth, monitored by Uptime Kuma ─────────
  if (route === '/' || route === '/api/status') {
    const body = await buildStatus();
    sendJson(res, body.healthy ? 200 : 503, body);
    return;
  }

  // ── 1-click Discord admin ticket exchange ─────────────────────────────────
  if (route === '/dashboard/auth') {
    const ticket = url.searchParams.get('ticket') || '';
    const identity = dashboardAuth.consumeLoginTicket(ticket);
    if (!identity) {
      const html =
        '<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:460px;margin:72px auto;padding:24px;line-height:1.5">' +
        '<h2>🔒 Login link expired or already used</h2>' +
        '<p>Run <code>/dashboard</code> in Discord again to get a fresh 1-click admin login link.</p>' +
        '<p><a href="/dashboard">Return to Control Center</a></p>' +
        '</body></html>';
      res.writeHead(401, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    const sessionToken = dashboardAuth.createSessionToken(identity);
    logger.info(`✅ Admin dashboard session started for @${identity.username} (${identity.userId})`);
    res.writeHead(302, {
      Location: '/dashboard',
      'Set-Cookie': dashboardAuth.buildSetCookieHeader(sessionToken, req),
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  // ── Auth session introspection & logout ───────────────────────────────────
  if (route === '/api/me') {
    const authRequired = isAuthConfigured();
    const actor = authRequired ? resolveActor(req, url) : { type: 'open', username: 'LAN Guest' };
    sendJson(res, 200, {
      authenticated: Boolean(actor),
      authRequired,
      roleAuthEnabled: dashboardAuth.isRoleAuthEnabled(),
      tokenAuthEnabled: publishRunner.isEnabled(),
      writeEnabled: authRequired && Boolean(actor),
      adminRoleIds: dashboardAuth.getAllowedRoleIds(),
      actor: actor
        ? { type: actor.type, username: actor.username, userId: actor.userId || null }
        : null,
    });
    return;
  }

  if (route === '/api/logout') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return;
    }
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Set-Cookie': dashboardAuth.buildClearCookieHeader(req),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
    return;
  }

  // ── The dashboard page itself ─────────────────────────────────────────────
  // Served unauthenticated even when auth is enabled: it is a static shell with
  // no data in it, and it renders the admin sign-in prompt if /api/overview returns 401.
  if (route === '/dashboard') {
    const html = await fs.promises.readFile(DASHBOARD_HTML);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  if (route === '/api/overview') {
    if (!guardRead(req, res, url)) return;
    const requested = parseInt(url.searchParams.get('days'), 10);
    const days = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_WINDOW_DAYS)
      : DEFAULT_WINDOW_DAYS;
    sendJson(res, 200, await buildDashboardOverview(days));
    return;
  }

  if (route === '/api/menu') {
    if (!guardRead(req, res, url)) return;
    const date = url.searchParams.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      sendJson(res, 400, { error: 'A ?date=YYYY-MM-DD parameter is required' });
      return;
    }
    // Repair provable labels for the day before showing it. The dashboard is
    // where a mislabelled week gets noticed, and a row the bot can prove should
    // not be presented as an unrepairable 'Unknown' — a read is also a good
    // moment to fix it, because the admin is looking at exactly that day. A
    // failed repair is logged and the view still renders what the table holds.
    await db
      .repairUnknownCampus(date, date)
      .catch((err) => logger.warn(`Campus label repair skipped for dashboard ${date}: ${err.message}`));
    sendJson(res, 200, { date, items: await db.getMenuItemsForDate(date) });
    return;
  }

  if (route === '/api/preview') {
    if (!guardRead(req, res, url)) return;
    const campus = url.searchParams.get('campus') || 'Uzumasa';
    const date = url.searchParams.get('date') || todayCampus();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { error: 'Invalid ?date=YYYY-MM-DD parameter' });
      return;
    }
    sendJson(res, 200, await buildMenuPreview(campus, date));
    return;
  }

  if (route === '/api/data-health') {
    if (!guardRead(req, res, url)) return;
    sendJson(res, 200, await buildDataHealth());
    return;
  }

  if (route === '/api/ratings') {
    if (!guardRead(req, res, url)) return;
    sendJson(res, 200, await db.getRatingsSummary());
    return;
  }

  if (route === '/api/logs') {
    if (!guardRead(req, res, url)) return;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
    const level = url.searchParams.get('level') || 'WARN';
    sendJson(res, 200, await logTail.readRecent({ minLevel: level, limit }));
    return;
  }

  // ── Write endpoints (require Admin role session OR DASHBOARD_TOKEN) ───────
  if (route === '/api/publish') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return;
    }
    const actor = guardWrite(req, res, url);
    if (!actor) return;

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const result = publishRunner.trigger(clientRef, formatActorLabel(actor, req), body);
    const statusCode = result.started ? 202 : /already in progress|not connected/i.test(result.reason || '') ? 409 : 400;
    sendJson(res, statusCode, {
      ...result,
      publish: { ...publishRunner.getState(), enabled: isAuthConfigured() },
    });
    return;
  }

  if (route === '/api/repair') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return;
    }
    const actor = guardWrite(req, res, url);
    if (!actor) return;

    const windowDays = Math.min(Math.max(parseInt(process.env.DATA_CHECK_WINDOW_DAYS, 10) || 21, 1), 90);
    const today = todayCampus();
    const to = shiftDate(today, windowDays);
    logger.info(`🧹 Campus label repair triggered by ${formatActorLabel(actor, req)}`);
    const report = await db.repairUnknownCampus(today, to, { apply: true });
    sendJson(res, 200, { ok: true, report });
    return;
  }

  if (route === '/api/command') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return;
    }
    const actor = guardWrite(req, res, url);
    if (!actor) return;

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const command = String(body.command || '').trim().toLowerCase();
    const actorLabel = formatActorLabel(actor, req);

    if (command === 'check-data') {
      logger.info(`🔎 Admin command "check-data" triggered by ${actorLabel}`);
      const health = await buildDataHealth();
      sendJson(res, 200, {
        ok: health.ok,
        command,
        summary: health.ok
          ? `All upcoming checks passed (${health.checked.rows} rows across ${health.checked.weekdays.length} weekdays)`
          : `${health.problems.length} issue(s) found; ${health.repairPreview.relabelled} row(s) auto-repairable`,
        result: health,
      });
      return;
    }

    if (command === 'repair-campus') {
      logger.info(`🧹 Admin command "repair-campus" triggered by ${actorLabel}`);
      const windowDays = Math.min(Math.max(parseInt(process.env.DATA_CHECK_WINDOW_DAYS, 10) || 21, 1), 90);
      const today = todayCampus();
      const to = shiftDate(today, windowDays);
      const report = await db.repairUnknownCampus(today, to, { apply: true });
      sendJson(res, 200, {
        ok: true,
        command,
        summary: `Repaired ${report.relabelled} mislabelled row(s), removed ${report.deleted} duplicate(s)`,
        result: report,
      });
      return;
    }

    if (command === 'verify-channels') {
      logger.info(`📡 Admin command "verify-channels" triggered by ${actorLabel}`);
      const subs = await db.getActiveSubscriptions();
      const checked = subs.map((sub) => inspectSubscriptionConnection(clientRef, sub));
      const ready = checked.filter((c) => c.canSend).length;
      sendJson(res, 200, {
        ok: ready === checked.length,
        command,
        summary: `${ready}/${checked.length} subscribed channel(s) reachable with SendMessages permission`,
        result: checked,
      });
      return;
    }

    if (command === 'ping-test') {
      logger.info(`🩺 Admin command "ping-test" triggered by ${actorLabel}`);
      const status = await buildStatus();
      sendJson(res, 200, {
        ok: status.healthy,
        command,
        summary: `DB ${status.databaseConnected ? `${status.dbLatencyMs}ms` : 'DOWN'} · Discord ${status.discordConnected ? `${status.wsPingMs ?? '—'}ms` : 'OFFLINE'} · Next post ${status.scheduler?.postingTime || '06:00 JST'}`,
        result: status,
      });
      return;
    }

    if (command === 'publish') {
      const result = publishRunner.trigger(clientRef, actorLabel, body.options || {});
      const statusCode = result.started ? 202 : /already in progress|not connected/i.test(result.reason || '') ? 409 : 400;
      sendJson(res, statusCode, {
        ok: result.started,
        command,
        summary: result.started ? 'Manual menu dispatch started' : result.reason,
        result,
        publish: { ...publishRunner.getState(), enabled: isAuthConfigured() },
      });
      return;
    }

    sendJson(res, 400, {
      error: `Unknown command "${command}"`,
      supportedCommands: ['check-data', 'repair-campus', 'verify-channels', 'ping-test', 'publish'],
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

function start(client) {
  clientRef = client;
  startTime = Date.now();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error(`HTTP ${req.method} ${req.url} failed: ${err.message}`);
      if (!res.headersSent) {
        // The health paths must still fail closed with 503 so Uptime Kuma sees
        // the same hard failure it saw before the dashboard existed, rather
        // than a 500 it might be configured to treat differently.
        const route = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
        const isHealth = route === '/' || route === '/api/status';
        sendJson(res, isHealth ? 503 : 500, { status: 'error', healthy: false, error: err.message });
      } else {
        res.end();
      }
    });
  });

  server.listen(PORT, () => {
    logger.info(`🩺 Health endpoint listening on port ${PORT}`);
    logger.info(`🖥️  Admin dashboard at http://<host>:${PORT}/dashboard`);
    if (dashboardAuth.isRoleAuthEnabled()) {
      logger.info(`🔐 Role-based admin dashboard access enabled for role(s): ${dashboardAuth.getAllowedRoleIds().join(', ')}`);
    } else if (!publishRunner.isEnabled()) {
      logger.info('ℹ️  DASHBOARD_TOKEN and DASHBOARD_ADMIN_ROLE_ID unset — dashboard is read-only');
    }
  });

  server.on('error', (err) => {
    logger.warn(`Health server error: ${err.message}`);
  });
}

function setClientForTesting(client) {
  clientRef = client;
  if (!startTime) startTime = Date.now();
}

module.exports = {
  start,
  handleRequest,
  buildStatus,
  buildDashboardOverview,
  buildDataHealth,
  buildMenuPreview,
  inspectSubscriptionConnection,
  setClientForTesting,
};
