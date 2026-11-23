#!/usr/bin/env node
/**
 * scripts/relayLatestFromDiscord.js
 *
 * One-shot command for Path C (Discord → WhatsApp Channel Relay):
 * Reads the most recent menu message already posted in your Discord channel
 * (`RELAY_DISCORD_CHANNEL_ID`), converts it to WhatsApp Markdown, and posts it
 * immediately to your WhatsApp Channel via WAHA.
 *
 * Ideal for testing tonight without waiting for tomorrow's 6:00 AM JST post!
 *
 * Usage:
 *   npm run relay:latest                     — Fetch latest Uzumasa menu from Discord & post to WhatsApp
 *   npm run relay:latest -- --dry-run        — Fetch from Discord & preview WhatsApp format in terminal
 *   npm run relay:latest -- --force          — Send even if that date was already relayed
 *   npm run relay:latest -- --campus Kameoka — Fetch latest Kameoka menu instead
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const {
  extractLatestMenuFromMessages,
  convertDiscordMenuToWhatsapp,
  wasAlreadyRelayed,
  markRelayed,
} = require('../src/publishers/discordToWhatsappRelay');

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, campus: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--campus' && argv[i + 1]) opts.campus = argv[++i];
  }
  return opts;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('❌ Missing DISCORD_BOT_TOKEN in .env');
    process.exit(1);
  }

  const channelIds = (process.env.RELAY_DISCORD_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    console.error('❌ Missing RELAY_DISCORD_CHANNEL_ID in .env');
    console.error('   Right-click your Discord #lunch channel → Copy Channel ID, and set:');
    console.error('   RELAY_DISCORD_CHANNEL_ID=your_discord_channel_id');
    process.exit(1);
  }

  if (!process.env.WAHA_API_URL) {
    process.env.WAHA_API_URL = 'http://localhost:3001';
  }

  const cfg = whatsappPublisher.getConfig();
  const targets = opts.campus
    ? [
        {
          campus: opts.campus,
          chatId:
            whatsappPublisher.normaliseChannelId(
              process.env[`WHATSAPP_CHANNEL_ID_${opts.campus.toUpperCase()}`]
            ) || whatsappPublisher.normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID),
        },
      ]
    : cfg.targets.length > 0
      ? cfg.targets
      : [{ campus: 'Uzumasa', chatId: null }];

  if (!opts.dryRun && targets.some((t) => !t.chatId)) {
    console.error('❌ Missing WHATSAPP_CHANNEL_ID in .env (or pass --dry-run to preview in terminal).');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', async () => {
    console.log(`Logged into Discord as ${client.user.tag}`);

    try {
      for (const target of targets) {
        let found = null;
        let foundChannelName = null;

        for (const channelId of channelIds) {
          const channel = await client.channels.fetch(channelId).catch((err) => {
            console.error(`❌ Could not access Discord channel ${channelId}: ${err.message}`);
            return null;
          });
          if (!channel || !channel.messages) continue;

          const fetched = await channel.messages.fetch({ limit: 50 });
          const messages = [...fetched.values()];

          // Hint if Message Content Intent wasn't toggled on in Discord Dev Portal
          if (messages.length > 0 && messages.every((m) => !m.content)) {
            console.error('⚠️ Fetched messages have empty content!');
            console.error('   Make sure "Message Content Intent" is enabled for your bot in the Discord Developer Portal (Bot → Privileged Gateway Intents).');
          }

          found = extractLatestMenuFromMessages(messages, target.campus);
          if (found) {
            foundChannelName = channel.name || channelId;
            break;
          }
        }

        if (!found) {
          console.warn(`⚠️ No recent ${target.campus} Campus menu post found in the last 50 messages of channel(s): ${channelIds.join(', ')}`);
          continue;
        }

        const { campus, dayName, menuDate } = found.header;
        console.log(`✅ Found ${campus} Campus menu (${dayName}, ${menuDate}) in #${foundChannelName} (${found.chunks.length} chunk(s))`);

        const whatsappText = convertDiscordMenuToWhatsapp(found.chunks);

        if (opts.dryRun) {
          console.log('\n--- WhatsApp Preview ---\n');
          console.log(whatsappText);
          console.log('\n------------------------\n');
          continue;
        }

        if (!opts.force && wasAlreadyRelayed(campus, menuDate)) {
          console.log(`⏭️  ${campus} menu for ${menuDate} was already relayed (pass --force to re-send).`);
          continue;
        }

        console.log(`Sending to WhatsApp Channel (${target.chatId}) via WAHA (${cfg.apiUrl})...`);
        await whatsappPublisher.sendText(target.chatId, whatsappText);
        markRelayed(campus, menuDate, found.messageId);
        console.log(`🎉 Successfully relayed ${campus} menu (${menuDate}) from Discord → WhatsApp Channel!`);
      }
    } catch (err) {
      console.error(`❌ Relay failed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      client.destroy();
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error(`❌ Discord login failed: ${err.message}`);
    process.exit(1);
  });
}

run();
