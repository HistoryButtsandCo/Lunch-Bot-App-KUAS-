#!/usr/bin/env node
/**
 * scripts/cloudWatchdog.js
 *
 * Runs on GitHub's free cloud servers (via `.github/workflows/whatsapp-watchdog.yml`)
 * at 7:00 AM, 8:00 AM, 9:00 AM, and every 20 minutes after 9:00 AM JST — even when
 * the user's laptop is completely powered OFF.
 *
 * Uses Discord's HTTP REST API (no WebSocket gateway login, so it never kicks
 * the laptop's live bot connection offline) to check the DM history with
 * Discord user 747445428731117679:
 *   - If today's menu was already sent to WhatsApp (`Sent ... menu (YYYY-MM-DD) to WhatsApp Channel`),
 *     exits quietly.
 *   - Otherwise, sends a Discord DM reminder to 747445428731117679 that today's
 *     menu has not gone out yet and the laptop/bot appears to be offline.
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

async function run() {
  if (!TOKEN) {
    console.log('ℹ️ DISCORD_BOT_TOKEN is not set in GitHub Actions Secrets yet — skipping watchdog check.');
    console.log('   To enable cloud offline alerts when your laptop is off:');
    console.log('   Go to your GitHub repo → Settings → Secrets and variables → Actions → New repository secret');
    console.log('   Name: DISCORD_BOT_TOKEN   Value: <your Discord bot token>');
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

  // Fetch recent messages in the DM channel to see if the bot is offline or today's menu was already relayed
  const messages = await discordRest('GET', `/channels/${dmChannel.id}/messages?limit=30`);
  const alreadySentPattern = new RegExp(`Sent .+ menu \\(${today}\\) to WhatsApp Channel`, 'i');

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

  const alreadySentToday =
    Array.isArray(messages) && messages.some((m) => alreadySentPattern.test(m.content || ''));

  if (alreadySentToday && !isCurrentlyMarkedOffline && !force) {
    console.log(`✅ Today's menu (${today}) was already sent and bot is not marked offline — no reminder needed.`);
    return;
  }

  const timeJst = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  console.log(`🚨 Today's menu (${today}) has not been sent to WhatsApp yet (${timeJst} JST) — sending DM reminder to ${OWNER_DISCORD_ID}`);

  await discordRest('POST', `/channels/${dmChannel.id}/messages`, {
    content:
      `🔴 **Cloud Watchdog Reminder (${timeJst} JST)**\n` +
      `Today's menu (**${today}**) has **not** been sent to your WhatsApp Channel yet — your laptop or WhatsApp bridge appears to be **OFFLINE**.\n` +
      `👉 Turn on your laptop (or double-click **\`WhatsApp Lunch Relay\`** on your Desktop) and it will automatically catch up and post today's menu!`,
  });

  console.log('✅ Reminder DM sent.');
}

run().catch((err) => {
  console.error('❌ Cloud watchdog error:', err.message);
  process.exit(1);
});
