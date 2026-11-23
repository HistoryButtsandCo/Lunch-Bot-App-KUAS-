#!/usr/bin/env node
/**
 * scripts/startAll.js
 *
 * All-in-one launcher that starts BOTH:
 *   1. The local Zero-Docker WAHA WhatsApp gateway (`scripts/localWahaServer.js`)
 *   2. The Discord → WhatsApp Channel Relay (`src/relay.js`)
 * in a single window, automatically restarting either process if it crashes.
 *
 * Usage:
 *   npm run start:all
 *   (or double-click Start-Lunch-Relay.bat on Windows)
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let shuttingDown = false;
const children = new Set();

function launchManaged(label, scriptRelPath, delayMs = 0) {
  setTimeout(() => {
    if (shuttingDown) return;

    const scriptPath = path.join(ROOT, scriptRelPath);
    console.log(`▶️  [${label}] Starting (${scriptRelPath})...`);

    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    children.add(child);

    child.on('exit', (code, signal) => {
      children.delete(child);
      if (shuttingDown) return;
      console.warn(`⚠️ [${label}] Exited (code=${code}, signal=${signal}). Restarting in 5 seconds...`);
      launchManaged(label, scriptRelPath, 5000);
    });
  }, delayMs);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n📴 Stopping WhatsApp gateway and Discord relay...');
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('============================================================');
console.log('🍱 Lunch Bot — All-in-One WhatsApp Gateway + Discord Relay');
console.log('============================================================');

// Start WAHA first, then start the Discord Relay 3 seconds later
launchManaged('WAHA', 'scripts/localWahaServer.js', 0);
launchManaged('RELAY', 'src/relay.js', 3000);
