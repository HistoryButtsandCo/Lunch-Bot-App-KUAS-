#!/usr/bin/env node
/**
 * scripts/cloudWatchdog.js
 *
 * Runs on GitHub's free cloud servers (via `.github/workflows/whatsapp-watchdog.yml`)
 * at 6:00 AM, 6:30 AM, 7:00 AM, 8:00 AM, 9:00 AM, and every 20 minutes after
 * 9:00 AM JST — even when the user's laptop is completely powered OFF.
 *
 * Uses Discord's HTTP REST API (no WebSocket gateway login, so it never kicks
 * the laptop's live bot connection offline) to check the DM history with
 * Discord user 747445428731117679 for all active campuses (Uzumasa & Kameoka).
 */

const https = require('https');
const { todayCampus, isWeekday } = require('../src/utils/campusDate');

const OWNER_DISCORD_ID = process.env.BOT_ADMIN_ID || '747445428731117679';
const TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();

function discordRest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bot ${TOKEN}`,
      'User-Agent': 'LunchBotCloudWatchdog/1.0',
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      `https://discord.com/api/v10${endpoint}`,
      { method, headers, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // keep raw
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Discord REST ${method} ${endpoint} failed (HTTP ${res.statusCode}): ${raw}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Discord REST ${method} ${endpoint} timed out`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Determine which campuses (`Uzumasa`, `Kameoka`, or both) should be checked:
 * 1. Explicit `WATCHDOG_CAMPUSES` env var if provided
 * 2. Otherwise inferred from the latest `WhatsApp Channel Bot is ONLINE!` DM
 * 3. Fallback to `['Uzumasa']`
 */
function resolveExpectedCampuses(messages) {
  const explicit = (process.env.WATCHDOG_CAMPUSES || '').trim();
  if (explicit) {
    return explicit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (Array.isArray(messages)) {
    const latestOnlineMsg = messages.find((m) =>
      /WhatsApp Channel Bot is ONLINE/i.test(m.content || '')
    );
    if (latestOnlineMsg?.content) {
      const detected = [];
      if (/Uzumasa/i.test(latestOnlineMsg.content)) detected.push('Uzumasa');
      if (/Kameoka/i.test(latestOnlineMsg.content)) detected.push('Kameoka');
      if (detected.length > 0) return detected;
    }
  }

  return ['Uzumasa'];
}

async function run() {
  if (!TOKEN) {
    console.log('ℹ️ DISCORD_BOT_TOKEN is not set in GitHub Actions Secrets yet — skipping watchdog check.');
    return;
  }

  const today = todayCampus(); // YYYY-MM-DD in Asia/Tokyo
  const force = process.argv.includes('--force');

  if (!force && !isWeekday(today)) {
    console.log(`ℹ️ Today (${today}) is a weekend in JST — skipping watchdog check.`);
    return;
  }

  // Open or retrieve the DM channel with the owner (747445428731117679)
  const dmChannel = await discordRest('POST', '/users/@me/channels', {
    recipient_id: OWNER_DISCORD_ID,
  });

  if (!dmChannel || !dmChannel.id) {
    throw new Error('Could not open DM channel with owner');
  }

  // Fetch recent messages in the DM channel
  const messages = await discordRest('GET', `/channels/${dmChannel.id}/messages?limit=40`);
  const expectedCampuses = resolveExpectedCampuses(messages);

  // Check if the most recent status transition DM says the bot is currently OFFLINE
  const latestStatusMsg = Array.isArray(messages)
    ? messages.find((m) =>
        /WhatsApp Channel (?:Bot|Connection) is (?:now )?(?:ONLINE|OFFLINE)|WhatsApp Connection Restored/i.test(
          m.content || ''
        )
      )
    : null;
  const isCurrentlyMarkedOffline =
    latestStatusMsg && /OFFLINE/i.test(latestStatusMsg.content || '');

  const missingCampuses = expectedCampuses.filter((campus) => {
    const pattern = new RegExp(`Sent ${campus} Campus menu \\(${today}\\) to WhatsApp Channel`, 'i');
    return !(Array.isArray(messages) && messages.some((m) => pattern.test(m.content || '')));
  });

  if (missingCampuses.length === 0 && !isCurrentlyMarkedOffline && !force) {
    console.log(
      `✅ Today's menu (${today}) was already sent for [${expectedCampuses.join(', ')}] and bot is online — no reminder needed.`
    );
    return;
  }

  const timeJst = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  const missingDetail =
    missingCampuses.length > 0
      ? `Today's menu (**${today}**) has **not** been sent yet for: **${missingCampuses.join(' & ')}**.`
      : `Today's menu (**${today}**) went out earlier, and your WhatsApp relay is currently **OFFLINE**.`;

  console.log(`🚨 Watchdog alert at ${timeJst} JST — sending DM reminder to ${OWNER_DISCORD_ID}`);

  await discordRest('POST', `/channels/${dmChannel.id}/messages`, {
    content:
      `🔴 **Cloud Watchdog Reminder (${timeJst} JST)**\n` +
      `${missingDetail}\n` +
      `👉 Turn on your laptop (or double-click **\`WhatsApp Lunch Relay\`** on your Desktop) so the bot reconnects and posts any pending menus!`,
  });

  console.log('✅ Reminder DM sent.');
}

run().catch((err) => {
  console.error('❌ Cloud watchdog error:', err.message);
  process.exit(1);
});
