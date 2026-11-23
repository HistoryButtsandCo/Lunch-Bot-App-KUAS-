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
 * Usage:
 *   npm run relay
 */

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./utils/logger');
const whatsappPublisher = require('./publishers/whatsappPublisher');
const {
  attachRelayListener,
  extractLatestMenuFromMessages,
  convertDiscordMenuToWhatsapp,
  wasAlreadyRelayed,
  markRelayed,
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

  attachRelayListener(client);
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
