#!/usr/bin/env node
/**
 * scripts/localWahaServer.js
 *
 * Built-in Zero-Docker WAHA-compatible local HTTP server powered by
 * `@whiskeysockets/baileys` (the same engine WAHA's NOWEB uses under the hood).
 *
 * Listens on http://localhost:3001 (or WAHA_API_URL port) and implements:
 *   - GET  /dashboard                        (Browser UI with status & QR instructions)
 *   - GET  /api/sessions/:session            (Session status: WORKING, SCAN_QR_CODE, STARTING)
 *   - POST /api/sessions/:session/start      (Start/restart session)
 *   - POST /api/:session/auth/request-code   (8-character phone pairing code)
 *   - GET  /api/:session/channels            (List subscribed/owned WhatsApp Channels)
 *   - POST /api/sendText                     (Post text to @newsletter or channel invite link)
 *
 * Usage:
 *   npm run waha
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const qrcode = require('qrcode-terminal');
const pino = require('pino');

const SESSION_DIR = path.resolve(__dirname, '..', '.waha-session');
const PORT = (() => {
  try {
    const u = new URL(process.env.WAHA_API_URL || 'http://localhost:3001');
    return Number(u.port) || 3001;
  } catch {
    return 3001;
  }
})();

let sock = null;
let baileysMod = null;
let sessionStatus = 'STARTING'; // 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED'
let latestQr = null;
let meInfo = null;
let reconnecting = false;
const knownChannels = new Map(); // id -> { id, name, role, invite }
const inviteToJidCache = new Map(); // inviteCode -> 120363...@newsletter

function extractInviteCode(input) {
  if (!input) return null;
  const str = String(input).trim();
  const urlMatch = str.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) return urlMatch[1];
  if (str.startsWith('invite:')) return str.slice('invite:'.length).trim();
  return null;
}

async function resolveChannelJid(chatIdOrInvite) {
  if (!sock) throw new Error('WhatsApp session is not connected yet');
  const inviteCode = extractInviteCode(chatIdOrInvite);
  if (!inviteCode) {
    const trimmed = String(chatIdOrInvite).trim();
    return trimmed.includes('@') ? trimmed : `${trimmed}@newsletter`;
  }

  if (inviteToJidCache.has(inviteCode)) {
    return inviteToJidCache.get(inviteCode);
  }

  const meta = await sock.newsletterMetadata('invite', inviteCode);
  if (!meta || !meta.id) {
    throw new Error(`Could not resolve WhatsApp Channel invite code "${inviteCode}"`);
  }
  const jid = meta.id.includes('@') ? meta.id : `${meta.id}@newsletter`;
  inviteToJidCache.set(inviteCode, jid);
  knownChannels.set(jid, {
    id: jid,
    name: meta.thread_metadata?.name?.text || meta.name || 'WhatsApp Channel',
    role: meta.viewer_metadata?.role || 'OWNER',
    invite: inviteCode,
  });
  console.log(`📢 Resolved Channel link (${inviteCode}) → ${jid} (${knownChannels.get(jid).name})`);
  return jid;
}

async function fetchSubscribedChannels() {
  if (!sock || sessionStatus !== 'WORKING') return [...knownChannels.values()];

  // Query subscribed/owned newsletters via WhatsApp MEX GraphQL if supported
  try {
    const { getBinaryNodeChild, S_WHATSAPP_NET } = baileysMod;
    const res = await sock.query({
      tag: 'iq',
      attrs: {
        id: sock.generateMessageTag(),
        type: 'get',
        to: S_WHATSAPP_NET,
        xmlns: 'w:mex',
      },
      content: [
        {
          tag: 'query',
          attrs: { query_id: '6388546374527196' }, // xwa2_newsletter_subscribed
          content: Buffer.from(JSON.stringify({ variables: {} }), 'utf-8'),
        },
      ],
    });
    const child = getBinaryNodeChild(res, 'result');
    if (child?.content) {
      const parsed = JSON.parse(child.content.toString());
      const list = parsed?.data?.xwa2_newsletter_subscribed;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item?.id) {
            knownChannels.set(item.id, {
              id: item.id,
              name: item.thread_metadata?.name?.text || item.name || '(unnamed)',
              role: item.viewer_metadata?.role || 'OWNER',
              invite: item.thread_metadata?.invite || null,
            });
          }
        }
      }
    }
  } catch {
    // Fallback: if WHATSAPP_CHANNEL_ID is a channel invite link, resolve it
  }

  if (process.env.WHATSAPP_CHANNEL_ID && extractInviteCode(process.env.WHATSAPP_CHANNEL_ID)) {
    try {
      await resolveChannelJid(process.env.WHATSAPP_CHANNEL_ID);
    } catch {
      // ignore
    }
  }

  return [...knownChannels.values()];
}

async function startWhatsappSocket() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    if (!baileysMod) {
      baileysMod = await import('@whiskeysockets/baileys');
    }

    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = baileysMod;

    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    let version;
    try {
      const vRes = await fetchLatestBaileysVersion();
      version = vRes.version;
    } catch {
      // use built-in version if offline
    }

    sessionStatus = 'STARTING';
    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Lunch Bot WAHA', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats || []) {
        if (c?.id && String(c.id).endsWith('@newsletter')) {
          knownChannels.set(c.id, {
            id: c.id,
            name: c.name || c.subject || 'WhatsApp Channel',
            role: 'OWNER',
          });
        }
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        sessionStatus = 'SCAN_QR_CODE';
        console.log('\n============================================================');
        console.log('📱 Scan this QR code with WhatsApp (Linked Devices → Link a Device):');
        console.log('============================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n(Or run `npm run whatsapp:pair -- <your_phone_number>` in another Command Prompt window)');
      }

      if (connection === 'open') {
        latestQr = null;
        sessionStatus = 'WORKING';
        meInfo = sock.user
          ? { id: sock.user.id, pushName: sock.user.name || 'Linked WhatsApp' }
          : null;
        console.log('\n✅ WhatsApp is CONNECTED and WORKING!');
        if (meInfo) {
          console.log(`   Logged in as: ${meInfo.pushName} (${meInfo.id})`);
        }
        console.log('   Keep this window open while using the WhatsApp relay/publisher.');
        console.log('   Open another Command Prompt window in this folder to run:');
        console.log('     npm run whatsapp:channels');
        console.log('     npm run relay:latest -- --force');
        console.log('     npm run relay\n');
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.warn(`⚠️ WhatsApp connection closed (code=${statusCode || 'unknown'}).`);
        if (shouldReconnect) {
          sessionStatus = 'STARTING';
          setTimeout(() => {
            reconnecting = false;
            startWhatsappSocket();
          }, 3000);
        } else {
          sessionStatus = 'STOPPED';
          console.log('Session logged out. Delete .waha-session folder and restart `npm run waha` to re-link.');
        }
      }
    });
  } catch (err) {
    console.error('Failed to start WhatsApp socket:', err.message);
  } finally {
    reconnecting = false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // GET /dashboard
    if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Local WAHA Gateway (No-Docker)</title>
  <meta http-equiv="refresh" content="5" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; background: #0f172a; color: #f8fafc; }
    .card { background: #1e293b; border-radius: 12px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; background: ${sessionStatus === 'WORKING' ? '#16a34a' : '#d97706'}; }
    code { background: #0f172a; padding: 3px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📱 Lunch Bot — Local WAHA Gateway (No Docker)</h2>
    <p>Status: <span class="badge">${sessionStatus}</span></p>
    ${meInfo ? `<p>Account: <strong>${meInfo.pushName}</strong> (<code>${meInfo.id}</code>)</p>` : ''}
    ${
      sessionStatus === 'SCAN_QR_CODE'
        ? `<p>Check your <strong>Command Prompt window</strong> where <code>npm run waha</code> is running to scan the QR code, or run <code>npm run whatsapp:pair -- &lt;phone&gt;</code> in a second Command Prompt window.</p>`
        : ''
    }
  </div>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /api/sessions/:session
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
      return sendJson(res, 200, {
        name: 'default',
        status: sessionStatus,
        me: meInfo,
      });
    }

    // POST /api/sessions/:session/start or POST /api/sessions
    if (
      req.method === 'POST' &&
      (pathname === '/api/sessions' || /^\/api\/sessions\/[^/]+\/start$/.test(pathname))
    ) {
      if (!sock || sessionStatus === 'STOPPED') {
        startWhatsappSocket();
      }
      return sendJson(res, 200, { name: 'default', status: sessionStatus });
    }

    // POST /api/:session/auth/request-code
    if (req.method === 'POST' && /^\/api\/[^/]+\/auth\/request-code$/.test(pathname)) {
      const body = await readJsonBody(req);
      const phone = String(body.phoneNumber || '').replace(/[^\d]/g, '');
      if (!phone) {
        return sendJson(res, 400, { message: 'phoneNumber is required' });
      }
      if (!sock) {
        return sendJson(res, 503, { message: 'WhatsApp socket is still starting, try again in 3 seconds' });
      }
      const code = await sock.requestPairingCode(phone);
      return sendJson(res, 200, { code });
    }

    // GET /api/:session/auth/qr
    if (req.method === 'GET' && /^\/api\/[^/]+\/auth\/qr$/.test(pathname)) {
      return sendJson(res, 200, { value: latestQr });
    }

    // GET /api/:session/channels
    if (req.method === 'GET' && /^\/api\/[^/]+\/channels$/.test(pathname)) {
      const inviteParam = parsedUrl.searchParams.get('invite');
      if (inviteParam) {
        await resolveChannelJid(`invite:${inviteParam}`);
      }
      const channels = await fetchSubscribedChannels();
      return sendJson(res, 200, channels);
    }

    // POST /api/sendText
    if (req.method === 'POST' && pathname === '/api/sendText') {
      if (!sock || sessionStatus !== 'WORKING') {
        return sendJson(res, 503, {
          message: `WhatsApp session is currently "${sessionStatus}" (must be WORKING before sending). Scan the QR code in the npm run waha window first.`,
        });
      }
      const body = await readJsonBody(req);
      if (!body.chatId || !body.text) {
        return sendJson(res, 400, { message: 'chatId and text are required' });
      }

      const targetJid = await resolveChannelJid(body.chatId);
      const result = await sock.sendMessage(targetJid, { text: String(body.text) });
      console.log(`📤 Sent message to ${targetJid} (${String(body.text).length} chars)`);
      return sendJson(res, 201, {
        id: result?.key?.id || 'sent',
        chatId: targetJid,
      });
    }

    return sendJson(res, 404, { message: `Not found: ${req.method} ${pathname}` });
  } catch (err) {
    console.error(`❌ [Local WAHA] ${req.method} ${req.url} error:`, err.message);
    return sendJson(res, 500, { message: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Local WAHA Gateway (No-Docker mode) listening on http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log('   Starting WhatsApp WebSocket session...');
  startWhatsappSocket();
});
