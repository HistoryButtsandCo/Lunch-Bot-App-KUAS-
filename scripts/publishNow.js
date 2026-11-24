#!/usr/bin/env node
const path = require('path');
// Load .env from the project root (one level above scripts/)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../src/db');
const menuPublisher = require('../src/publishers/menuPublisher');

const args = process.argv.slice(2);
/**
 * --campus <Uzumasa|Kameoka>, --channel <CHANNEL_ID>, --date <YYYY-MM-DD>,
 * and --force narrow or force the run, e.g.
 *   node scripts/publishNow.js --campus Uzumasa --channel 1504156157600600197 --force
 * Without them this still publishes to every active subscription.
 */
const options = { manual: true };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--campus' || args[i] === '-k') options.campus = args[++i];
  else if (args[i] === '--channel' || args[i] === '-c') options.channelId = args[++i];
  else if (args[i] === '--date' || args[i] === '-d') options.date = args[++i];
  else if (args[i] === '--force' || args[i] === '-f') options.force = true;
}

async function run() {
  // Show what we're working with
  console.log('Env loaded from:', path.resolve(__dirname, '..', '.env'));
  console.log('DB Host:', process.env.POSTGRES_HOST || '(not set)');
  console.log('DB Name:', process.env.POSTGRES_DB || '(not set)');
  console.log('DB User:', process.env.POSTGRES_USER || '(not set)');
  console.log('DB Port:', process.env.POSTGRES_PORT || '(not set)');
  if (options.campus || options.channelId || options.date || options.force) {
    console.log(
      'Target:',
      options.campus || 'any campus',
      '/',
      options.channelId || 'all channels',
      options.date ? `/ date=${options.date}` : '',
      options.force ? '(force re-send)' : ''
    );
  }

  try {
    await db.initConnection();
  } catch (err) {
    console.error('DB init failed:', err.message);
    console.error('Full error:', err);
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}, running publisher now...`);
    try {
      await menuPublisher.publishMenu(client, options);
      console.log('Publish run complete');
    } catch (err) {
      console.error('Publish failed:', err.message);
    } finally {
      await db.closeConnection().catch(() => {});
      client.destroy();
      process.exit(0);
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error('Discord login failed:', err.message);
    process.exit(1);
  });
}

run();
