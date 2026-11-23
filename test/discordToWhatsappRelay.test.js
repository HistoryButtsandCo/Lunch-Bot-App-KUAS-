const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const { formatMenuMessage, formatMenuForWhatsapp } = require('../src/utils/formatMenu');
const whatsappPublisher = require('../src/publishers/whatsappPublisher');
const {
  parseMenuHeader,
  convertDiscordMenuToWhatsapp,
  extractLatestMenuFromMessages,
  attachRelayListener,
  isWhatsappOfflineAlertSlot,
} = require('../src/publishers/discordToWhatsappRelay');

function sampleDishes(campus = 'Uzumasa') {
  return [
    {
      campus,
      menu_date: '2026-08-18',
      day_name: 'Tuesday',
      category: 'Set Meals',
      subcategory: 'Campus Lunch (1)',
      dish_name: 'Beef Cutlet',
      calories: 498,
      protein: 15.0,
      fat: 23.7,
      sodium: 2.7,
      allergens: 'Milk, Wheat',
      price: null,
    },
    {
      campus,
      menu_date: '2026-08-18',
      day_name: 'Tuesday',
      category: 'Noodles',
      subcategory: 'Ramen',
      dish_name: 'Soy Sauce Ramen',
      calories: 410,
      protein: 14.0,
      fat: 10.2,
      sodium: 4.5,
      allergens: 'Wheat, Soy',
      price: null,
    },
  ];
}

test('parseMenuHeader detects Uzumasa and Kameoka headers even with a leading role mention', () => {
  const discordChunk =
    '<@&123456789012345678>\n' +
    '# Uzumasa Campus — Tuesday, 2026-08-18\n\n' +
    '## 🍱 Set Meals  ·  ¥330 (+ 1 side/salad)\n' +
    '\n\n## **Tap below to rate the menu**';

  assert.deepStrictEqual(parseMenuHeader(discordChunk), {
    campus: 'Uzumasa',
    dayName: 'Tuesday',
    menuDate: '2026-08-18',
  });

  assert.strictEqual(parseMenuHeader('Hello everyone, what is for lunch?'), null);
});

test('convertDiscordMenuToWhatsapp reproduces formatMenuForWhatsapp from a Discord post', () => {
  const items = sampleDishes('Uzumasa');
  const ratings = new Map([['Beef Cutlet', { avg: 4.2, count: 5 }]]);

  // Simulate what menuPublisher sends to Discord: role ping + chunks + rate prompt
  const discordChunks = formatMenuMessage(items, ratings, 'Uzumasa');
  const decoratedFirst = `<@&999888777666>\n${discordChunks[0]}\n\n## **Tap below to rate the menu**`;

  const converted = convertDiscordMenuToWhatsapp([decoratedFirst, ...discordChunks.slice(1)]);
  const directWhatsapp = formatMenuForWhatsapp(items, ratings, 'Uzumasa').trim();

  assert.strictEqual(converted, directWhatsapp);
  assert.doesNotMatch(converted, /<@&/);
  assert.doesNotMatch(converted, /Tap below to rate the menu/);
});

test('extractLatestMenuFromMessages reassembles a 2-chunk menu from Discord history', () => {
  const chunk1 =
    '<@&111>\n# Uzumasa Campus — Tuesday, 2026-08-18\n\n## 🍱 Set Meals\n> 🥘 **Beef Cutlet**\n\n## **Tap below to rate the menu**';
  const chunk2 =
    '## 🍜 Noodles\n> 🍜 **Soy Sauce Ramen**\n\n━━━━━━━━━━━━━━━━━━━━━━\n🎫 Tickets from **10:00 AM**';

  // channel.messages.fetch returns newest first
  const messagesNewestFirst = [
    { id: 'm4', content: 'Looks tasty!', author: { id: 'user1' }, createdTimestamp: 1005000 },
    { id: 'm3', content: chunk2, author: { id: 'bot1' }, createdTimestamp: 1001000 },
    { id: 'm2', content: chunk1, author: { id: 'bot1' }, createdTimestamp: 1000000 },
    { id: 'm1', content: '# Kameoka Campus — Tuesday, 2026-08-18\n...', author: { id: 'bot1' }, createdTimestamp: 990000 },
  ];

  const found = extractLatestMenuFromMessages(messagesNewestFirst, 'Uzumasa');
  assert.ok(found);
  assert.strictEqual(found.header.campus, 'Uzumasa');
  assert.strictEqual(found.header.menuDate, '2026-08-18');
  assert.strictEqual(found.chunks.length, 2);

  const whatsappText = convertDiscordMenuToWhatsapp(found.chunks);
  assert.match(whatsappText, /🍽️ \*Uzumasa Campus — Tuesday, 2026-08-18\*/);
  assert.match(whatsappText, /\*Beef Cutlet\*/);
  assert.match(whatsappText, /\*Soy Sauce Ramen\*/);
  assert.doesNotMatch(whatsappText, /Tap below to rate/);
});

test('attachRelayListener buffers incoming Discord menu chunks and forwards to WAHA', async () => {
  process.env.WAHA_API_URL = 'http://localhost:3001';
  process.env.WHATSAPP_CHANNEL_ID = '120363999888777666@newsletter';
  process.env.WHATSAPP_CAMPUSES = 'Uzumasa';

  const tmpStateFile = path.join(os.tmpdir(), `relay-test-${Date.now()}.json`);
  const sentToWaha = [];
  mock.method(whatsappPublisher, 'sendText', async (chatId, text) => {
    sentToWaha.push({ chatId, text });
    return { id: 'msg-1' };
  });

  try {
    const client = new EventEmitter();
    client.user = { id: 'relay-bot-id' };

    attachRelayListener(client, {
      watchChannelIds: ['lunch-channel-1'],
      chunkWaitMs: 30,
      stateFile: tmpStateFile,
    });

    // Emit chunk 1 and chunk 2 from the upstream Lunch Bot
    client.emit('messageCreate', {
      id: '101',
      channelId: 'lunch-channel-1',
      author: { id: 'friend-lunch-bot' },
      content: '<@&555>\n# Uzumasa Campus — Wednesday, 2026-08-19\n\n## 🍱 Set Meals\n> 🥘 **Chicken Cutlet**\n\n## **Tap below to rate the menu**',
    });

    client.emit('messageCreate', {
      id: '102',
      channelId: 'lunch-channel-1',
      author: { id: 'friend-lunch-bot' },
      content: '## 🍜 Noodles\n> 🍜 **Udon**\n\n━━━━━━━━━━━━━━━━━━━━━━\n🎫 Tickets from **10:00 AM**',
    });

    // Wait for debounce flush
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(sentToWaha.length, 1);
    assert.strictEqual(sentToWaha[0].chatId, '120363999888777666@newsletter');
    assert.match(sentToWaha[0].text, /🍽️ \*Uzumasa Campus — Wednesday, 2026-08-19\*/);
    assert.match(sentToWaha[0].text, /\*Chicken Cutlet\*/);
    assert.match(sentToWaha[0].text, /\*Udon\*/);
  } finally {
    delete process.env.WAHA_API_URL;
    delete process.env.WHATSAPP_CHANNEL_ID;
    delete process.env.WHATSAPP_CAMPUSES;
    mock.restoreAll();
    if (fs.existsSync(tmpStateFile)) fs.unlinkSync(tmpStateFile);
  }
});

test('isWhatsappOfflineAlertSlot matches 6:00, 6:30, 7:00, 8:00, 9:00, and every 20 mins after 9:00 AM', () => {
  assert.strictEqual(isWhatsappOfflineAlertSlot(5, 30), false);
  assert.strictEqual(isWhatsappOfflineAlertSlot(6, 0), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(6, 30), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(6, 45), false);
  assert.strictEqual(isWhatsappOfflineAlertSlot(7, 0), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(7, 20), false);
  assert.strictEqual(isWhatsappOfflineAlertSlot(8, 0), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(8, 40), false);
  assert.strictEqual(isWhatsappOfflineAlertSlot(9, 0), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(9, 20), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(9, 40), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(9, 15), false);
  assert.strictEqual(isWhatsappOfflineAlertSlot(10, 0), true);
  assert.strictEqual(isWhatsappOfflineAlertSlot(10, 20), true);
});
