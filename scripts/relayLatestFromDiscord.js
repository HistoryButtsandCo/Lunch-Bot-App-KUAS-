#!/usr/bin/env node
/**
 * scripts/relayLatestFromDiscord.js
 *
 * One-shot command for Path C (Discord → WhatsApp Channel Relay):
 * Reads the most recent menu message(s) posted in your Discord server
 * (both Uzumasa and Kameoka, or a specific campus), converts them to WhatsApp
 * Markdown, and posts them immediately to your WhatsApp Channel(s) via WAHA.
 *
 * Usage:
 *   npm run relay:latest                     — Relay all configured campuses (Uzumasa & Kameoka)
 *   npm run relay:latest -- --campus Kameoka — Relay latest Kameoka menu only
 *   npm run relay:latest -- --campus Uzumasa — Relay latest Uzumasa menu only
 *   npm run relay:latest -- --campus all     — Relay both Uzumasa and Kameoka
 *   npm run relay:latest -- --dry-run        — Preview WhatsApp format in terminal without sending
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const {
  extractLatestMenuFromMessages,
  convertDiscordMenuToWhatsapp,
  markRelayed,
  discoverCandidateChannelIds,
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

function buildTargets(campusOverride) {
  const cfg = whatsappPublisher.getConfig();
  const defaultChannel = whatsappPublisher.normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID);

  if (campusOverride) {
    const campuses =
      campusOverride.toLowerCase() === 'all' || campusOverride.toLowerCase() === 'both'
        ? ['Uzumasa', 'Kameoka']
        : [campusOverride];
    return campuses.map((c) => {
      const normalized = c.toLowerCase() === 'kameoka' ? 'Kameoka' : c.toLowerCase() === 'uzumasa' ? 'Uzumasa' : c;
      return {
        campus: normalized,
        chatId:
          whatsappPublisher.normaliseChannelId(
            process.env[`WHATSAPP_CHANNEL_ID_${normalized.toUpperCase()}`]
          ) || defaultChannel,
      };
    });
  }

  return cfg.targets.length > 0 ? cfg.targets : [{ campus: 'Uzumasa', chatId: null }];
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('❌ Missing DISCORD_BOT_TOKEN in .env');
    process.exit(1);
  }

  if (!process.env.WAHA_API_URL) {
    process.env.WAHA_API_URL = 'http://localhost:3001';
  }

  const cfg = whatsappPublisher.getConfig();
  const targets = buildTargets(opts.campus);

  if (!opts.dryRun && targets.some((t) => !t.chatId)) {
    console.error('❌ Missing WhatsApp Channel ID in .env for one or more campuses (or pass --dry-run to preview).');
    console.error('   Set WHATSAPP_CHANNEL_ID (shared) or WHATSAPP_CHANNEL_ID_UZUMASA / WHATSAPP_CHANNEL_ID_KAMEOKA.');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('clientReady', async () => {
    console.log(`Logged into Discord as ${client.user.tag}`);

    try {
      for (const target of targets) {
        const candidateIds = discoverCandidateChannelIds(client, target.campus);
        if (candidateIds.length === 0) {
          console.error(`❌ No Discord channel IDs configured or discovered for ${target.campus}.`);
          console.error('   Set RELAY_DISCORD_CHANNEL_ID (or RELAY_DISCORD_CHANNEL_ID_KAMEOKA) in .env.');
          continue;
        }

        let found = null;
        let foundChannelName = null;

        for (const channelId of candidateIds) {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.messages) continue;

          const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!fetched) continue;
          const messages = [...fetched.values()];

          if (messages.length > 0 && messages.every((m) => !m.content)) {
            console.error('⚠️ Fetched messages have empty content!');
            console.error('   Make sure "Message Content Intent" is enabled for your bot in the Discord Developer Portal.');
          }

          found = extractLatestMenuFromMessages(messages, target.campus);
          if (found) {
            foundChannelName = channel.name || channelId;
            break;
          }
        }

        if (!found) {
          console.warn(`⚠️ No recent ${target.campus} Campus menu post found in channel(s): ${candidateIds.join(', ')}`);
          continue;
        }

        const { campus, dayName, menuDate } = found.header;
        console.log(`✅ Found ${campus} Campus menu (${dayName}, ${menuDate}) in #${foundChannelName} (${found.chunks.length} chunk(s))`);

        const whatsappText = convertDiscordMenuToWhatsapp(found.chunks);

        if (opts.dryRun) {
          console.log(`\n--- WhatsApp Preview (${campus}) ---\n`);
          console.log(whatsappText);
          console.log('\n------------------------------------\n');
          continue;
        }

        console.log(`Sending ${campus} menu to WhatsApp Channel (${target.chatId}) via WAHA (${cfg.apiUrl})...`);
        await whatsappPublisher.sendText(target.chatId, whatsappText);
        markRelayed(campus, menuDate, found.messageId);
        if (found.messageObj && typeof found.messageObj.react === 'function') {
          await found.messageObj.react('✅').catch(() => {});
        }
        const ownerId = process.env.BOT_ADMIN_ID || '747445428731117679';
        const ownerUser = await client.users.fetch(ownerId).catch(() => null);
        if (ownerUser) {
          await ownerUser
            .send({ content: `✅ **Sent ${campus} Campus menu (${menuDate}) to WhatsApp Channel!**` })
            .catch(() => {});
        }
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
