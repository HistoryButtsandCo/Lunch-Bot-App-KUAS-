#!/usr/bin/env node
/**
 * scripts/whatsappSetup.js
 *
 * Remote-friendly CLI helper for setting up WAHA and discovering your WhatsApp
 * Channel (@newsletter) ID over SSH — no local browser required.
 *
 * Usage:
 *   npm run whatsapp:status                 — Check WAHA connection & session status
 *   npm run whatsapp:pair -- 819012345678   — Get an 8-char phone pairing code in terminal
 *   npm run whatsapp:channels               — List owned/admin WhatsApp Channels & .env config
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const whatsappPublisher = require('../src/publishers/whatsappPublisher');

async function ensureSessionStarted(apiUrl) {
  try {
    const session = await whatsappPublisher.getSession({ apiUrl });
    if (session && session.status === 'STOPPED') {
      console.log(`Session "${session.name}" is STOPPED — starting it now...`);
      await whatsappPublisher.startSession({ apiUrl });
      return whatsappPublisher.getSession({ apiUrl });
    }
    return session;
  } catch (err) {
    if (err.statusCode === 404) {
      console.log('Session not found — creating and starting session...');
      await whatsappPublisher.startSession({ apiUrl });
      return whatsappPublisher.getSession({ apiUrl });
    }
    throw err;
  }
}

async function cmdStatus(apiUrl) {
  console.log(`Checking WAHA at ${apiUrl} ...`);
  const session = await ensureSessionStarted(apiUrl);
  console.log(`✅ WAHA is reachable!`);
  console.log(`   Session : ${session.name || 'default'}`);
  console.log(`   Status  : ${session.status}`);
  if (session.me) {
    console.log(`   Account : ${session.me.pushName || ''} (${session.me.id || ''})`);
  }

  if (session.status === 'SCAN_QR_CODE') {
    console.log('\n📱 Your session is waiting to be linked to WhatsApp.');
    console.log('   Option A (No QR / Remote SSH):');
    console.log('     Run: npm run whatsapp:pair -- <your_phone_number_with_country_code>');
    console.log('     (e.g. npm run whatsapp:pair -- 819012345678)');
    console.log('   Option B (QR Code in Docker logs):');
    console.log('     Run: docker logs -f campus-lunch-waha');
    console.log('   Option C (WAHA Web Dashboard via SSH port forward):');
    console.log('     From your laptop: ssh -L 3001:127.0.0.1:3001 <user>@<server>');
    console.log('     Then open http://localhost:3001/dashboard');
  } else if (session.status === 'WORKING') {
    console.log('\n🎉 Session is WORKING! Run `npm run whatsapp:channels` to get your Channel ID.');
  }
}

async function cmdPair(apiUrl, phoneArg) {
  if (!phoneArg) {
    console.error('❌ Please provide your phone number in international format (digits only, no +).');
    console.error('   Example: npm run whatsapp:pair -- 819012345678');
    process.exit(1);
  }

  await ensureSessionStarted(apiUrl);
  console.log(`Requesting pairing code for ${phoneArg} from WAHA (${apiUrl})...`);
  const res = await whatsappPublisher.requestPairingCode(phoneArg, { apiUrl });
  const code = res?.code || res;

  console.log('\n========================================================');
  console.log(`🔑 WhatsApp Pairing Code:  ${typeof code === 'string' ? code : JSON.stringify(code)}`);
  console.log('========================================================');
  console.log('On your phone:');
  console.log('  1. Open WhatsApp → Linked Devices → Link a Device');
  console.log('  2. Tap "Link with phone number instead" at the bottom');
  console.log('  3. Enter the code shown above');
  console.log('\nOnce linked, run: npm run whatsapp:channels');
}

async function cmdChannels(apiUrl, inviteArg) {
  const session = await ensureSessionStarted(apiUrl);
  if (session.status !== 'WORKING') {
    console.warn(`⚠️ Session status is "${session.status}" (expected "WORKING").`);
    console.warn('   Scan the QR code in the `npm run waha` window or run `npm run whatsapp:pair -- <phone>` first.');
  }

  let inviteCode = null;
  if (inviteArg) {
    const match = String(inviteArg).match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
    inviteCode = match ? match[1] : String(inviteArg).trim();
  }

  console.log(`Fetching WhatsApp Channels from WAHA (${apiUrl})...`);
  const channels = await whatsappPublisher.listChannels(null, { apiUrl, invite: inviteCode });

  if (!Array.isArray(channels) || channels.length === 0) {
    console.log('ℹ️ No WhatsApp Channels automatically listed yet.');
    console.log('   👉 Easy shortcut: Copy your WhatsApp Channel Share Link from your phone');
    console.log('      (e.g. https://whatsapp.com/channel/0029Va...) and either:');
    console.log('      1) Run: npm run whatsapp:channels -- https://whatsapp.com/channel/YOUR_CODE');
    console.log('      2) Or paste the link directly as WHATSAPP_CHANNEL_ID in your .env file!');
    return;
  }

  console.log(`\n📢 Found ${channels.length} WhatsApp Channel(s):\n`);
  for (const ch of channels) {
    const role = ch.role || ch.viewerMetadata?.role || 'UNKNOWN';
    console.log(`  • Name : ${ch.name || '(unnamed)'}`);
    console.log(`    ID   : ${ch.id}`);
    console.log(`    Role : ${role}`);
    console.log('');
  }

  const writable = channels.filter((c) => {
    const r = String(c.role || c.viewerMetadata?.role || '').toUpperCase();
    return r === 'OWNER' || r === 'ADMIN' || !r;
  });
  const picked = writable[0] || channels[0];

  console.log('Add these lines to your .env file to start with Uzumasa Campus:');
  console.log('---------------------------------------------------------------');
  console.log(`WAHA_API_URL=${apiUrl}`);
  if (process.env.WAHA_API_KEY) {
    console.log(`WAHA_API_KEY=${process.env.WAHA_API_KEY}`);
  }
  console.log(`WHATSAPP_CHANNEL_ID=${picked.id}`);
  console.log('WHATSAPP_CAMPUSES=Uzumasa');
  console.log('---------------------------------------------------------------');
}

async function main() {
  const action = (process.argv[2] || 'status').toLowerCase();
  const arg = process.argv[3];
  const apiUrl = (process.env.WAHA_API_URL || 'http://localhost:3001').trim().replace(/\/+$/, '');

  try {
    if (action === 'status') {
      await cmdStatus(apiUrl);
    } else if (action === 'pair') {
      await cmdPair(apiUrl, arg);
    } else if (action === 'channels') {
      await cmdChannels(apiUrl, arg);
    } else {
      console.error(`Unknown action "${action}". Expected: status | pair | channels`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error(`   Make sure the local WAHA gateway is running in another Command Prompt window:`);
    console.error(`     npm run waha`);
    process.exit(1);
  }
}

main();
