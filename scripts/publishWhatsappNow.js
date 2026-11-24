#!/usr/bin/env node
/**
 * scripts/publishWhatsappNow.js
 *
 * Publishes campus menus (Uzumasa, Kameoka, or both) directly to your
 * configured WhatsApp Channel(s) via WAHA.
 *
 * Flags:
 *   (default)                    — publishes today's menu from PostgreSQL
 *   --next                       — publishes the next available weekday menu from PostgreSQL
 *   --date YYYY-MM-DD            — publishes a specific date's menu from PostgreSQL
 *   --sample                     — publishes a realistic sample menu (no DB required)
 *   --campus Uzumasa|Kameoka|all — override which campus(es) to post
 *   --force                      — send even if today's menu is already logged as delivered
 *   --dry-run                    — print the formatted WhatsApp message without sending
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const db = require('../src/db');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const { formatMenuForWhatsapp } = require('../src/utils/formatMenu');
const { todayCampus } = require('../src/utils/campusDate');

const SAMPLE_MENUS = {
  Uzumasa: [
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
  ],
  Kameoka: [
    {
      campus: 'Kameoka',
      menu_date: todayCampus(),
      day_name: 'Sample Day',
      category: 'Set',
      subcategory: 'A',
      dish_name: 'Pork Loin Tonkatsu Set',
      calories: 690,
      protein: 27.1,
      fat: 28.0,
      sodium: 2.6,
      allergens: 'Egg, Wheat, Pork, Soy',
      price: 500,
    },
    {
      campus: 'Kameoka',
      menu_date: todayCampus(),
      day_name: 'Sample Day',
      category: 'Live Kitchen',
      subcategory: 'Live Kitchen',
      dish_name: 'Sizzling Beef Pepper Rice Bowl',
      calories: 640,
      protein: 24.5,
      fat: 22.0,
      sodium: 2.9,
      allergens: 'Beef, Wheat, Soy',
      price: 520,
    },
    {
      campus: 'Kameoka',
      menu_date: todayCampus(),
      day_name: 'Sample Day',
      category: 'Curry',
      subcategory: 'A',
      dish_name: 'Original Beef Curry',
      calories: 560,
      protein: 16.2,
      fat: 15.8,
      sodium: 3.1,
      allergens: 'Milk, Wheat, Beef, Soy',
      price: 350,
    },
    {
      campus: 'Kameoka',
      menu_date: todayCampus(),
      day_name: 'Sample Day',
      category: 'Ramen',
      subcategory: 'Ramen',
      dish_name: 'Kyoto Shoyu Ramen',
      calories: 470,
      protein: 16.8,
      fat: 12.4,
      sodium: 4.9,
      allergens: 'Egg, Wheat, Pork, Chicken, Soy',
      price: 380,
    },
  ],
};

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

function resolveTargets(campusOverride, dryRun = false) {
  const cfg = whatsappPublisher.getConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:3001';

  if (campusOverride) {
    const requested =
      campusOverride.toLowerCase() === 'all' || campusOverride.toLowerCase() === 'both'
        ? ['Uzumasa', 'Kameoka']
        : [campusOverride.toLowerCase() === 'kameoka' ? 'Kameoka' : campusOverride.toLowerCase() === 'uzumasa' ? 'Uzumasa' : campusOverride];
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
        .filter((t) => dryRun || Boolean(t.chatId)),
    };
  }

  return {
    apiUrl,
    targets: cfg.targets.length > 0 ? cfg.targets : dryRun ? [{ campus: 'Uzumasa', chatId: null }] : [],
  };
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const { apiUrl, targets } = resolveTargets(opts.campus, opts.dryRun);

  if (!opts.dryRun && targets.length === 0) {
    console.error('❌ No WhatsApp Channel target configured.');
    console.error('   Set WAHA_API_URL and WHATSAPP_CHANNEL_ID (or WHATSAPP_CHANNEL_ID_UZUMASA / WHATSAPP_CHANNEL_ID_KAMEOKA) in .env.');
    console.error('   Tip: run `npm run whatsapp:channels` to see your Channel IDs.');
    process.exit(1);
  }

  if (opts.sample) {
    for (const target of targets) {
      const sampleItems = SAMPLE_MENUS[target.campus] || SAMPLE_MENUS.Uzumasa;
      const text = `🧪 *[TEST POST — Sample ${target.campus} Menu]*\n\n${formatMenuForWhatsapp(sampleItems, new Map(), target.campus)}`;
      if (opts.dryRun) {
        console.log(text);
        continue;
      }
      console.log(`Sending sample ${target.campus} menu to ${target.chatId} via ${apiUrl} ...`);
      await whatsappPublisher.sendText(target.chatId, text, { apiUrl });
      console.log(`✅ Sample ${target.campus} menu posted to WhatsApp Channel!`);
    }
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
    for (const target of targets) {
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
        console.warn('   Tip: try `npm run whatsapp:publish -- --next` or `--sample`');
        continue;
      }

      if (opts.dryRun) {
        const dishNames = [...new Set(items.map((d) => d.dish_name))];
        const ratings = await db.getRatingsForDishes(dishNames, campus);
        const fallbackPrices = await db.getLastKnownPrices(campus, menuDate);
        console.log(formatMenuForWhatsapp(items, ratings, campus, fallbackPrices));
        continue;
      }

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
