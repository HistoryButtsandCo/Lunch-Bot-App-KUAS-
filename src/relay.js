/**
 * src/relay.js
 *
 * Path C — Standalone Discord → WhatsApp Channel Relay Service.
 *
 * Runs completely independently of the upstream PostgreSQL database and n8n
 * scraper. Logs into your Discord server, watches your menu channel for daily
 * posts from the upstream Lunch Bot, converts the Discord message(s) into
 * WhatsApp Markdown, and posts them to your WhatsApp Channel via WAHA.
 *
 * Also monitors the WAHA WhatsApp connection every 20 seconds:
 *   - Updates the Discord bot's live status to "🟢 WhatsApp: Online" or "🔴 WhatsApp: Offline"
 *   - DMs the bot owner if WhatsApp is offline at 7:00 AM, 8:00 AM, 9:00 AM,
 *     and every 20 minutes after 9:00 AM (9:20, 9:40, 10:00, 10:20...) until turned back on.
 *
 * Usage:
 *   npm run relay
 */

require('dotenv').config();

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const logger = require('./utils/logger');
const whatsappPublisher = require('./publishers/whatsappPublisher');
const {
  attachRelayListener,
  extractLatestMenuFromMessages,
  convertDiscordMenuToWhatsapp,
  wasAlreadyRelayed,
  markRelayed,
  isWhatsappOfflineAlertSlot,
} = require('./publishers/discordToWhatsappRelay');
const { todayCampus } = require('./utils/campusDate');

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ Missing required environment variable: DISCORD_BOT_TOKEN');
  process.exit(1);
}

if (!process.env.WAHA_API_URL) {
  process.env.WAHA_API_URL = 'http://localhost:3001';
}

const cfg = whatsappPublisher.getConfig();
if (cfg.targets.length === 0) {
  console.error('❌ Missing WhatsApp Channel target: set WHATSAPP_CHANNEL_ID in your .env file.');
  console.error('   Tip: run `npm run whatsapp:channels` to discover your Channel ID.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let resolvedAdminUserId = process.env.BOT_ADMIN_ID || null;
let lastKnownWhatsappOnline = null;
let lastAlertSlotKey = null;
let hadOfflineAlertSent = false;

/**
 * Resolve the Discord User ID to DM on WhatsApp offline alerts.
 * Uses BOT_ADMIN_ID from .env if set; otherwise auto-detects the owner of the
 * Discord Bot Application from the Discord API.
 */
async function resolveOwnerUserId() {
  if (resolvedAdminUserId) return resolvedAdminUserId;
  try {
    await client.application?.fetch();
    const owner = client.application?.owner;
    // owner can be a User (owner.id) or a Team (owner.ownerId)
    resolvedAdminUserId = owner?.id || owner?.ownerId || null;
    if (resolvedAdminUserId) {
      logger.info(`👤 Auto-detected Discord bot owner for WhatsApp status alerts: ${resolvedAdminUserId}`);
    }
  } catch (err) {
    logger.warn(`Could not auto-detect Discord application owner: ${err.message}`);
  }
  return resolvedAdminUserId;
}

/**
 * Send a DM to the bot owner.
 */
async function notifyOwner(content) {
  const userId = await resolveOwnerUserId();
  if (!userId) return;
  try {
    const user = await client.users.fetch(userId);
    if (user) {
      await user.send({ content });
    }
  } catch (err) {
    logger.warn(`Could not send WhatsApp status DM to ${userId}: ${err.message}`);
  }
}

/**
 * Check whether WAHA is reachable and the WhatsApp session is WORKING.
 * Updates the Discord bot's status bar and triggers scheduled offline DMs.
 */
async function checkWhatsappHealth() {
  let isOnline = false;
  let detail = 'Offline';

  try {
    const session = await whatsappPublisher.getSession();
    if (session && session.status === 'WORKING') {
      isOnline = true;
      detail = 'Online';
    } else {
      detail = session?.status || 'Disconnected';
    }
  } catch {
    isOnline = false;
    detail = 'WAHA not running';
  }

  // Update Discord bot presence/status whenever it changes (or on first check)
  if (client.user && isOnline !== lastKnownWhatsappOnline) {
    try {
      client.user.setPresence({
        status: isOnline ? 'online' : 'dnd',
        activities: [
          {
            name: isOnline ? '🟢 WhatsApp: Online' : `🔴 WhatsApp: Offline (${detail})`,
            type: ActivityType.Watching,
          },
        ],
      });
    } catch {
      // ignore presence error
    }

    if (isOnline && hadOfflineAlertSent) {
      hadOfflineAlertSent = false;
      await notifyOwner('🟢 **WhatsApp Connection Restored!**\nThe WhatsApp Channel bridge (`waha`) is back online and ready to post menus.');
    }

    lastKnownWhatsappOnline = isOnline;
  }

  if (isOnline) return;

  // Check current local time for scheduled offline alerts:
  // 7:00 AM, 8:00 AM, 9:00 AM, and every 20 mins after 9:00 AM (9:20, 9:40, 10:00, 10:20...)
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const slotKey = `${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  if (isWhatsappOfflineAlertSlot(hour, minute) && lastAlertSlotKey !== slotKey) {
    lastAlertSlotKey = slotKey;
    hadOfflineAlertSent = true;
    const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    logger.warn(`🚨 WhatsApp is offline (${detail}) at ${timeLabel} — sending alert DM to owner`);
    await notifyOwner(
      `🔴 **WhatsApp Channel Connection is OFFLINE** (${timeLabel})\n` +
        `Status: \`${detail}\`\n` +
        `To turn it back on, run \`Start-Lunch-Relay.bat\` (or \`npm run waha\`).\n` +
        `*(Alerts run at 7:00 AM, 8:00 AM, 9:00 AM, and every 20 minutes after 9:00 AM until WhatsApp is back online.)*`
    );
  }
}

/**
 * On startup, check watched Discord channels to see if today's menu was
 * already posted while the relay was offline, and forward it if not yet sent.
 */
async function catchUpFromDiscordHistory() {
  const channelIds = (process.env.RELAY_DISCORD_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (channelIds.length === 0) return;

  const today = todayCampus();

  for (const channelId of channelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.messages) {
      logger.warn(`⚠️ [Relay] Could not fetch Discord channel ${channelId} — check RELAY_DISCORD_CHANNEL_ID and bot permissions`);
      continue;
    }

    const fetched = await channel.messages.fetch({ limit: 25 }).catch((err) => {
      logger.warn(`⚠️ [Relay] Could not read message history in #${channel.name || channelId}: ${err.message}`);
      return null;
    });
    if (!fetched) continue;

    const messages = [...fetched.values()];

    for (const target of whatsappPublisher.getConfig().targets) {
      if (wasAlreadyRelayed(target.campus, today)) continue;

      const found = extractLatestMenuFromMessages(messages, target.campus);
      if (found && found.header.menuDate === today) {
        logger.info(`⏰ [Relay] Found today's ${target.campus} menu (${today}) in Discord history — relaying now`);
        const whatsappText = convertDiscordMenuToWhatsapp(found.chunks);
        try {
          await whatsappPublisher.sendText(target.chatId, whatsappText);
          markRelayed(target.campus, today, found.messageId);
          logger.info(`✅ [Relay] Startup catch-up sent ${target.campus} menu (${today}) to WhatsApp Channel (${target.chatId})`);
        } catch (err) {
          logger.error(`❌ [Relay] Startup catch-up failed for ${target.campus}: ${err.message}`);
        }
      }
    }
  }
}

client.once('clientReady', async () => {
  const watchIds = (process.env.RELAY_DISCORD_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  logger.info(`🤖 Discord → WhatsApp Relay logged in as ${client.user.tag}`);
  logger.info(
    `👀 Watching Discord channel(s): ${watchIds.length > 0 ? watchIds.join(', ') : 'ALL accessible channels'}`
  );
  logger.info(
    `📱 Forwarding to WhatsApp target(s): ${cfg.targets.map((t) => `${t.campus} → ${t.chatId}`).join(', ')}`
  );

  await resolveOwnerUserId();
  attachRelayListener(client);

  // Start WhatsApp health check & Discord status/alert loop (every 20 seconds)
  await checkWhatsappHealth();
  setInterval(checkWhatsappHealth, 20 * 1000);

  await catchUpFromDiscordHistory();
});

process.on('SIGINT', () => {
  logger.info('📴 Shutting down Discord → WhatsApp Relay...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('📴 Shutting down Discord → WhatsApp Relay (SIGTERM)...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  logger.error(`❌ Failed to log in to Discord: ${err.message}`);
  process.exit(1);
});
