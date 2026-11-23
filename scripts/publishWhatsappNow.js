#!/usr/bin/env node
/**
 * scripts/publishWhatsappNow.js
 *
 * Publishes the campus menu directly to your configured WhatsApp Channel via
 * WAHA — without waiting for 6:00 AM JST and without posting to Discord.
 *
 * Flags:
 *   (default)              — publishes today's menu from PostgreSQL
 *   --next                 — publishes the next available weekday menu from PostgreSQL
 *                            (ideal when testing at night or on a weekend)
 *   --date YYYY-MM-DD      — publishes a specific date's menu from PostgreSQL
 *   --sample               — publishes a realistic sample Uzumasa menu (no DB required)
 *   --campus Uzumasa|Kameoka|all — override which campus(es) to post
 *   --force                — send even if today's menu is already logged as delivered
 *   --dry-run              — print the formatted WhatsApp message without sending
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const db = require('../src/db');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const { formatMenuForWhatsapp } = require('../src/utils/formatMenu');
const { todayCampus } = require('../src/utils/campusDate');

const SAMPLE_UZUMASA_MENU = [
  {
    campus: 'Uzumasa',
    menu_date: todayCampus(),
    day_name: 'Sample Day',
    category: 'Set Meals',
    subcategory: 'Campus Lunch (1)',
    dish_name: 'Chicken Nanban with Tartar Sauce',
    calories: 645,
    protein: 26.4,
    fat: 24.1,
    sodium: 2.8,
    allergens: 'Egg, Milk, Wheat, Chicken, Soy',
    price: 430,
  },
  {
    campus: 'Uzumasa',
    menu_date: todayCampus(),
    day_name: 'Sample Day',
    category: 'Set Meals',
    subcategory: 'Campus Lunch (2)',
    dish_name: 'Miso-Glazed Grilled Mackerel',
    calories: 540,
    protein: 23.0,
    fat: 18.5,
    sodium: 2.4,
    allergens: 'Mackerel, Soy, Wheat',
    price: 430,
  },
  {
    campus: 'Uzumasa',
    menu_date: todayCampus(),
    day_name: 'Sample Day',
    category: 'Halal',
    subcategory: 'Halal',
    dish_name: 'Butter Chicken Curry & Rice',
    calories: 610,
    protein: 22.0,
    fat: 19.0,
    sodium: 2.2,
    allergens: 'Milk, Chicken',
    price: 400,
  },
  {
    campus: 'Uzumasa',
    menu_date: todayCampus(),
    day_name: 'Sample Day',
    category: 'Noodles',
    subcategory: 'Ramen',
    dish_name: 'Tonkotsu Shoyu Ramen',
    calories: 490,
    protein: 17.5,
    fat: 14.2,
    sodium: 5.1,
    allergens: 'Egg, Wheat, Pork, Soy',
    price: 300,
  },
];

function parseArgs(argv) {
  const opts = {
    next: false,
    sample: false,
    force: false,
    dryRun: false,
    date: null,
    campus: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--next') opts.next = true;
    else if (arg === '--sample') opts.sample = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date' && argv[i + 1]) opts.date = argv[++i];
    else if (arg === '--campus' && argv[i + 1]) opts.campus = argv[++i];
  }
  return opts;
}

function resolveTargets(campusOverride) {
  const cfg = whatsappPublisher.getConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:3001';

  if (campusOverride) {
    const requested =
      campusOverride.toLowerCase() === 'all'
        ? ['Uzumasa', 'Kameoka']
        : [campusOverride];
    const defaultChannel = whatsappPublisher.normaliseChannelId(process.env.WHATSAPP_CHANNEL_ID);
    return {
      apiUrl,
      targets: requested
        .map((campus) => ({
          campus,
          chatId:
            whatsappPublisher.normaliseChannelId(process.env[`WHATSAPP_CHANNEL_ID_${campus.toUpperCase()}`]) ||
            defaultChannel,
        }))
        .filter((t) => Boolean(t.chatId)),
    };
  }

  return { apiUrl, targets: cfg.targets };
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const { apiUrl, targets } = resolveTargets(opts.campus);

  if (!opts.dryRun && targets.length === 0) {
    console.error('❌ No WhatsApp Channel target configured.');
    console.error('   Set WAHA_API_URL and WHATSAPP_CHANNEL_ID in your .env file.');
    console.error('   Tip: run `npm run whatsapp:channels` to see your Channel IDs.');
    process.exit(1);
  }

  if (opts.sample) {
    const target = targets[0] || { campus: 'Uzumasa', chatId: process.env.WHATSAPP_CHANNEL_ID };
    const text = `🧪 *[TEST POST — Sample Menu]*\n\n${formatMenuForWhatsapp(SAMPLE_UZUMASA_MENU, new Map(), 'Uzumasa')}`;
    if (opts.dryRun) {
      console.log(text);
      return;
    }
    console.log(`Sending sample Uzumasa menu to ${target.chatId} via ${apiUrl} ...`);
    await whatsappPublisher.sendText(target.chatId, text, { apiUrl });
    console.log('✅ Sample menu posted to WhatsApp Channel!');
    return;
  }

  try {
    await db.initConnection();
  } catch (err) {
    console.error('❌ DB init failed:', err.message);
    console.error('   (Tip: pass `--sample` to test WhatsApp posting without a database connection)');
    process.exit(1);
  }

  try {
    const runTargets = targets.length > 0 ? targets : [{ campus: opts.campus || 'Uzumasa', chatId: null }];

    for (const target of runTargets) {
      const { campus, chatId } = target;
      let menuDate = opts.date || todayCampus();
      let items = [];

      if (opts.next) {
        const nextMenu = await db.getNextMenu(campus);
        menuDate = nextMenu.menuDate || menuDate;
        items = nextMenu.items;
      } else if (opts.date) {
        items = await db.getMenuByDate(opts.date, campus);
      } else {
        items = await db.getTodayMenu(campus);
      }

      if (!items || items.length === 0) {
        console.warn(`⚠️ No menu items found in DB for ${campus} on ${menuDate}.`);
        console.warn('   Tip: try `npm run whatsapp:publish -- --next` (next weekday in DB)');
        console.warn('        or  `npm run whatsapp:publish -- --sample` (sample menu)');
        continue;
      }

      if (opts.dryRun) {
        const dishNames = [...new Set(items.map((d) => d.dish_name))];
        const ratings = await db.getRatingsForDishes(dishNames, campus);
        const fallbackPrices = await db.getLastKnownPrices(campus, menuDate);
        console.log(formatMenuForWhatsapp(items, ratings, campus, fallbackPrices));
        continue;
      }

      // Only write to bot_delivery_log when publishing today's live menu
      const isLiveToday = !opts.next && !opts.date;
      const res = await whatsappPublisher.publishCampusToWhatsapp(campus, chatId, {
        today: menuDate,
        menuItems: items,
        force: opts.force || !isLiveToday,
        skipDbLog: !isLiveToday,
      });

      console.log(`Result for ${campus} (${menuDate}): ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
    }
  } finally {
    await db.closeConnection().catch(() => {});
  }
}

run();
