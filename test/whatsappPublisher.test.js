const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const db = require('../src/db');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const { publishMenu } = require('../src/publishers/menuPublisher');
const { buildOverview } = require('../src/dashboard/overview');

const SIX_AM_JST = new Date('2026-08-12T21:00:00Z');
const JST_DATE = '2026-08-13';

function menuItems(campus = 'Uzumasa') {
  return [
    { subcategory: 'Campus Lunch (1)', dish_name: 'Beef Cutlet' },
    { subcategory: 'Campus Lunch (2)', dish_name: 'Grilled Salmon' },
    { category: 'Curry', subcategory: 'Curry', dish_name: 'Original Curry' },
    { category: 'Noodles', subcategory: 'Ramen', dish_name: 'Soy Sauce Ramen' },
  ].map((row) => ({
    campus,
    menu_date: JST_DATE,
    day_name: 'Thursday',
    category: 'Set Meals',
    calories: 498,
    ...row,
  }));
}

function clearWhatsappEnv() {
  delete process.env.WAHA_API_URL;
  delete process.env.WAHA_API_KEY;
  delete process.env.WAHA_SESSION;
  delete process.env.WHATSAPP_CHANNEL_ID;
  delete process.env.WHATSAPP_CAMPUSES;
  delete process.env.WHATSAPP_CHANNEL_ID_UZUMASA;
  delete process.env.WHATSAPP_CHANNEL_ID_KAMEOKA;
  delete process.env.UPTIME_KUMA_MENU_PUSH_URL;
  delete process.env.BOT_ADMIN_ID;
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: SIX_AM_JST.getTime() });
  clearWhatsappEnv();
});

test.afterEach(() => {
  clearWhatsappEnv();
  mock.timers.reset();
  mock.restoreAll();
});

test('normaliseChannelId appends @newsletter to bare numeric IDs', () => {
  assert.strictEqual(
    whatsappPublisher.normaliseChannelId('120363123456789012'),
    '120363123456789012@newsletter'
  );
  assert.strictEqual(
    whatsappPublisher.normaliseChannelId('120363123456789012@newsletter'),
    '120363123456789012@newsletter'
  );
  assert.strictEqual(whatsappPublisher.normaliseChannelId(''), null);
  assert.strictEqual(whatsappPublisher.normaliseChannelId(null), null);
});

test('channelIdToDbBigint extracts 64-bit integer prefix and rejects non-numeric strings', () => {
  assert.strictEqual(
    whatsappPublisher.channelIdToDbBigint('120363123456789012@newsletter'),
    '120363123456789012'
  );
  assert.strictEqual(whatsappPublisher.channelIdToDbBigint('invalid@newsletter'), null);
  // 99999999999999999999 exceeds signed 64-bit BIGINT max
  assert.strictEqual(whatsappPublisher.channelIdToDbBigint('99999999999999999999@newsletter'), null);
});

test('getConfig defaults to Uzumasa Campus when WHATSAPP_CHANNEL_ID is configured', () => {
  process.env.WAHA_API_URL = 'http://localhost:3001/';
  process.env.WHATSAPP_CHANNEL_ID = '120363111222333444';

  const cfg = whatsappPublisher.getConfig();
  assert.strictEqual(cfg.apiUrl, 'http://localhost:3001');
  assert.strictEqual(cfg.session, 'default');
  assert.deepStrictEqual(cfg.targets, [
    { campus: 'Uzumasa', chatId: '120363111222333444@newsletter' },
  ]);
  assert.strictEqual(whatsappPublisher.isConfigured(), true);
});

test('getConfig supports posting both campuses to the same WhatsApp Channel', () => {
  process.env.WAHA_API_URL = 'http://localhost:3001';
  process.env.WHATSAPP_CHANNEL_ID = '120363111222333444@newsletter';
  process.env.WHATSAPP_CAMPUSES = 'Uzumasa, Kameoka';

  const cfg = whatsappPublisher.getConfig();
  assert.deepStrictEqual(cfg.targets, [
    { campus: 'Uzumasa', chatId: '120363111222333444@newsletter' },
    { campus: 'Kameoka', chatId: '120363111222333444@newsletter' },
  ]);
});

test('getConfig auto-enables Kameoka when WHATSAPP_CHANNEL_ID_KAMEOKA is set even if WHATSAPP_CAMPUSES=Uzumasa', () => {
  process.env.WAHA_API_URL = 'http://localhost:3001';
  process.env.WHATSAPP_CHANNEL_ID = '120363432234120398@newsletter';
  process.env.WHATSAPP_CAMPUSES = 'Uzumasa';
  process.env.WHATSAPP_CHANNEL_ID_KAMEOKA = '120363999888777666@newsletter';

  const cfg = whatsappPublisher.getConfig();
  assert.deepStrictEqual(cfg.targets, [
    { campus: 'Uzumasa', chatId: '120363432234120398@newsletter' },
    { campus: 'Kameoka', chatId: '120363999888777666@newsletter' },
  ]);
});

test('publishMenu posts both to Discord and to the WhatsApp Channel via WAHA', async () => {
  process.env.WAHA_API_URL = 'http://localhost:3001';
  process.env.WHATSAPP_CHANNEL_ID = '120363111222333444@newsletter';

  const logged = [];
  const wahaCalls = [];

  mock.method(db, 'repairUnknownCampus', async () => ({
    examined: 0,
    groups: [],
    relabelled: 0,
    deleted: 0,
    skipped: 0,
  }));
  mock.method(db, 'getActiveSubscriptions', async () => [
    {
      guild_id: '111',
      guild_name: 'Test Guild',
      channel_id: '222',
      campus: 'Uzumasa',
      role_id: null,
    },
  ]);
  mock.method(db, 'getTodayMenu', async () => menuItems('Uzumasa'));
  mock.method(db, 'getRatingsForDishes', async () => new Map());
  mock.method(db, 'getLastKnownPrices', async () => new Map());
  mock.method(db, 'hasSuccessfulDelivery', async () => false);
  mock.method(db, 'logDelivery', async (guildId, channelId, campus, menuDate, status, error) => {
    logged.push({ guildId, channelId, campus, menuDate, status, error });
  });

  mock.method(whatsappPublisher, 'requestWaha', async (method, endpoint, body) => {
    wahaCalls.push({ method, endpoint, body });
    return { id: 'waha-msg-1' };
  });

  const discordSent = [];
  const client = {
    channels: {
      fetch: async () => ({
        name: 'lunch',
        guild: { members: { me: {} } },
        permissionsFor: () => ({ has: () => true }),
        send: async (payload) => discordSent.push(payload),
      }),
    },
  };

  await publishMenu(client);

  assert.strictEqual(discordSent.length, 1, 'Discord still receives its menu');
  assert.strictEqual(wahaCalls.length, 1, 'WAHA receives the WhatsApp Channel post');
  assert.strictEqual(wahaCalls[0].method, 'POST');
  assert.strictEqual(wahaCalls[0].endpoint, '/api/sendText');
  assert.strictEqual(wahaCalls[0].body.chatId, '120363111222333444@newsletter');
  assert.strictEqual(wahaCalls[0].body.session, 'default');
  assert.match(wahaCalls[0].body.text, /🍽️ \*Uzumasa Campus/);

  assert.deepStrictEqual(logged, [
    {
      guildId: '111',
      channelId: '222',
      campus: 'Uzumasa',
      menuDate: JST_DATE,
      status: 'success',
      error: null,
    },
    {
      guildId: '0',
      channelId: '120363111222333444',
      campus: 'Uzumasa',
      menuDate: JST_DATE,
      status: 'success',
      error: null,
    },
  ]);
});

test('WhatsApp duplicate guard skips re-sending when already delivered today', async () => {
  process.env.WAHA_API_URL = 'http://localhost:3001';
  process.env.WHATSAPP_CHANNEL_ID = '120363111222333444@newsletter';

  mock.method(db, 'getTodayMenu', async () => menuItems('Uzumasa'));
  mock.method(db, 'hasSuccessfulDelivery', async (guildId, campus, date) => {
    return guildId === '0' && campus === 'Uzumasa' && date === JST_DATE;
  });
  const sendMock = mock.method(whatsappPublisher, 'sendText', async () => {});

  const result = await whatsappPublisher.publishCampusToWhatsapp(
    'Uzumasa',
    '120363111222333444@newsletter',
    { today: JST_DATE }
  );

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'already_sent');
  assert.strictEqual(sendMock.mock.calls.length, 0);
});

test('dashboard overview labels sentinel guild_id 0 as WhatsApp Channel', () => {
  const overview = buildOverview({
    dates: [JST_DATE],
    today: JST_DATE,
    subscriptions: [],
    menuCounts: [{ menu_date: JST_DATE, campus: 'Uzumasa', item_count: 10 }],
    deliveries: [
      {
        guild_id: '0',
        channel_id: '120363111222333444',
        campus: 'Uzumasa',
        menu_date: JST_DATE,
        status: 'success',
        error_message: null,
        delivered_at: '2026-08-12T21:00:05.000Z',
        guild_name: null,
      },
    ],
  });

  const uzumasa = overview.days[0].campuses.find((c) => c.campus === 'Uzumasa');
  assert.strictEqual(uzumasa.deliveries[0].guildName, 'WhatsApp Channel');
});
