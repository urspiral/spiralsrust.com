require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createServer } = require('http');
const { Server: SocketIO } = require('socket.io');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const { default: RCEManager, RCEIntent, LogLevel } = require('rce.js');
const killtracker = require('./rce/killtracker');
const playtimetracker = require('./rce/playtimetracker');
let discordClient = null;
try {
  ({ client: discordClient } = require('./discord-client'));
} catch (e) {
  console.warn('Discord client module failed to load:', e.message || e);
}

// ── Paths ─────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const KILLS_PATH = path.join(DATA_DIR, 'kills.json');
const PLAYTIME_PATH = path.join(DATA_DIR, 'playtime.json');
const STORED_KITS_PATH = path.join(DATA_DIR, 'storedkits.json');
const COOLDOWNS_PATH = path.join(DATA_DIR, 'cooldowns.json');
const LINKS_PATH = path.join(DATA_DIR, 'links.json');
const JEWELS_PATH = path.join(DATA_DIR, 'jewels.json');
const JEWELSTORE_DIR = path.join(DATA_DIR, 'jewelstore');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const SHOP_CONFIG_PATH = path.join(DATA_DIR, 'shop-config.json');
const GIFT_CARDS_PATH = path.join(DATA_DIR, 'giftcards.json');
const DISCOUNTS_PATH = path.join(DATA_DIR, 'discounts.json');
const DONATION_QUEUE_PATH = path.join(DATA_DIR, 'donation-queue.json');

const PURCHASES_DIR = path.join(DATA_DIR, 'purchases');
const KITS_PURCHASES_PATH = path.join(PURCHASES_DIR, 'kits.json');
const PACKS_PURCHASES_PATH = path.join(PURCHASES_DIR, 'packs.json');
const VIPS_PURCHASES_PATH = path.join(PURCHASES_DIR, 'vips.json');
const RANKS_PURCHASES_PATH = path.join(PURCHASES_DIR, 'ranks.json');
const PENDING_CHECKOUTS_PATH = path.join(PURCHASES_DIR, 'pending.json');
const JEWEL_LOGS_PATH = path.join(DATA_DIR, 'jewellogs.json');

// ── Env ───────────────────────────────────────────────────────────────────
const {
  SESSION_SECRET,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_WEBHOOK_URL,
  DASHBOARD_ACCESS,
  PORT,
  BASE_URL,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  ADMIN_BYPASS_USER_ID,
  ADMIN_BYPASS_USER_IDS,
  TEST_PAYMENT_BYPASS_ENABLED
} = process.env;

const ADMIN_BYPASS_IDS = String(ADMIN_BYPASS_USER_IDS || ADMIN_BYPASS_USER_ID || '')
  .split(',')
  .map(id => String(id || '').trim())
  .filter(Boolean);

function isAdminBypassUser(discordId) {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(TEST_PAYMENT_BYPASS_ENABLED || '').trim().toLowerCase());
  if (!enabled || process.env.NODE_ENV === 'production') return false;

  const id = String(discordId || '').trim();
  if (!id || !hasAccess(id)) return false;

  const allowedIds = ADMIN_BYPASS_IDS.length ? ADMIN_BYPASS_IDS : getDashboardIds();
  return allowedIds.includes(id);
}

const serverPort = Number(PORT) || 3000;
const APP_BASE_URL = String(BASE_URL || `http://localhost:${serverPort}`).replace(/\/+$/, '');
const DISCORD_CALLBACK_URL = DISCORD_REDIRECT_URI || `${APP_BASE_URL}/auth/discord/callback`;

const DISCORD_OAUTH_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_ME_URL = 'https://discord.com/api/users/@me';

// ── Cooldown durations (ms) ───────────────────────────────────────────────
const COOLDOWN_DURATION_MS = {
  'doomsday-rank': 6 * 60 * 60 * 1000,
  'vanguard-rank': 6 * 60 * 60 * 1000,
  'galactic-rank': 6 * 60 * 60 * 1000,
  'dominion-rank': 6 * 60 * 60 * 1000,
  'warrior-kit': 3 * 60 * 60 * 1000,
  'raider-kit': 24 * 60 * 60 * 1000,
  'defender-kit': 3 * 60 * 60 * 1000,
  'essentials-kit': 6 * 60 * 60 * 1000
};

const KIT_COMMAND_NAMES = {
  'doomsday-rank': { weapons: 'Doomsday Weapons', resources: 'Doomsday Resources' },
  'vanguard-rank': { weapons: 'Vanguard Weapons', resources: 'Vanguard Resources' },
  'galactic-rank': { weapons: 'Galactic Weapons', resources: 'Galactic Resources' },
  'dominion-rank': { weapons: 'Dominion Weapons', resources: 'Dominion Resources' },
  'warrior-kit': { kit: 'Warrior Kit' },
  'raider-kit': { kit: 'Raider Kit' },
  'defender-kit': { kit: 'Defender Kit' },
  'essentials-kit': { kit: 'Essentials Kit' }
};

// ── Jewel earning rates ───────────────────────────────────────────────────
const JEWEL_EARN_RATES = {
  base: 10,
  dominion: 10,
  galactic: 10,
  vanguard: 10,
  doomsday: 10,
  champion: 20
};

function normalizeName(v) {
  return String(v || '').trim().toLowerCase();
}

function timeToSeconds(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return 0;

  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);

  const m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (m) return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]);

  return 0;
}

function getSecondsFromNode(node) {
  const candidates = [
    node?.totalSeconds,
    node?.playtimeSeconds,
    node?.seconds,
    node?.timeSeconds,
    node?.playtime,
    node?.timePlayed
  ];

  let best = 0;
  for (const v of candidates) best = Math.max(best, timeToSeconds(v));
  return best;
}

function findPlaytimeSeconds(data, gamertag) {
  const wanted = normalizeName(gamertag);
  let best = 0;
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const names = [
      node.gamertag,
      node.name,
      node.playerName,
      node.displayName,
      node.username
    ];

    if (names.some(n => normalizeName(n) === wanted)) {
      best = Math.max(best, getSecondsFromNode(node));
    }

    for (const value of Object.values(node)) walk(value);
  }

  walk(data);
  return best;
}

function awardJewelsFromPlaytime() {
  const playtime = readJson(PLAYTIME_PATH, {});
  const links = readJson(LINKS_PATH, {});
  const jewels = readJewels();

  let changed = false;

  for (const [discordId, link] of Object.entries(links)) {
    if (!link?.gamertag) continue;

    const totalSeconds = findPlaytimeSeconds(playtime, link.gamertag);
    
    if (!totalSeconds) continue;

    if (!jewels[discordId]) {
      jewels[discordId] = {
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        updatedAt: null,
        lastAwardedPlaytimeSeconds: 0
      };
    }

    const row = jewels[discordId];
    const alreadyAwarded = Number(row.lastAwardedPlaytimeSeconds || 0);
    const deltaSeconds = Math.max(0, totalSeconds - alreadyAwarded);

    if (deltaSeconds < 3600) continue;

    const wholeHours = Math.floor(deltaSeconds / 3600);
    const { rate, owned } = getUserEarnRate(discordId);

    // champion backend fix
    let finalRate = rate;
    if (owned.has('champion-rank')) finalRate += JEWEL_EARN_RATES.champion;

    const payout = wholeHours * finalRate;

    row.balance = (row.balance || 0) + payout;
row.totalEarned = (row.totalEarned || 0) + payout;
row.lastAwardedPlaytimeSeconds = alreadyAwarded + (wholeHours * 3600);
row.updatedAt = new Date().toISOString();

writeJewelLog({
  type: 'hourly_award',
  discordId,
  discordUsername: null,
  gamertag: link.gamertag,
  hoursAwarded: wholeHours,
  rate: finalRate,
  payout,
  balanceBefore: row.balance - payout,
  balanceAfter: row.balance
});

    changed = true;
  }

  if (changed) writeJewels(jewels);
// (don't log here — callers log with context)
}

// ── Jewel Store server restriction ───────────────────────────────────────
const JEWELSTORE_SERVER_ID = 'na3x';

// ── Load server configs ───────────────────────────────────────────────────
function loadServersConfig() {
  const filePath = path.join(DATA_DIR, 'servers.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing servers config: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.servers)) return parsed.servers;

  throw new Error('servers.json must be an array or { "servers": [] }');
}

const serversConfig = loadServersConfig();

function cleanHostname(raw) {
  let s = String(raw || '');

  const marker = '<#00000000>';
  const markerIndex = s.indexOf(marker);
  if (markerIndex !== -1) {
    s = s.slice(0, markerIndex);
  }

  return s.replace(/<[^>]*>/g, '').trim();
}
// ── Express + Socket.IO ───────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });

app.set('trust proxy', 1);
app.use('/data', express.static(DATA_DIR));

// ── Stripe price ids ──────────────────────────────────────────────────────
const STRIPE_PRICES = {
  'wipe-vip': 'price_1THRv5QTLuDJNbBvS1bIQ5oG',
  'lifetime-vip': 'price_1THRvsQTLuDJNbBvFta762tU',
  'queue-skip': 'price_1THRwHQTLuDJNbBvs6Wpjp8a',

  'doomsday-rank': 'price_1THRxgQTLuDJNbBveoSeiNYE',
  'vanguard-rank': 'price_1THRy6QTLuDJNbBv7IoJQmcN',
  'galactic-rank': 'price_1THRySQTLuDJNbBvmDgKc71Q',
  'dominion-rank': 'price_1THRynQTLuDJNbBvRWXpbVSD',
  'all-ranks-bundle': 'price_1THRx6QTLuDJNbBv9ZTP72Rk',

  'charcoal-pack': 'price_REPLACE_CHARCOAL',
  'backpack-pack': 'price_REPLACE_BACKPACK',
  'turret-pack': 'price_REPLACE_TURRET',
  'resource-pack': 'price_REPLACE_RESOURCE',
  'comps-pack': 'price_REPLACE_COMPS',
  'farmer-pack': 'price_REPLACE_FARMER',
  'airdrops-pack': 'price_REPLACE_AIRDROPS',
  'medical-pack': 'price_REPLACE_MEDICAL',
  'cards-pack': 'price_REPLACE_CARDS'
};

const PURCHASE_ROLE_MAP = {
  'doomsday-rank': ['1486003753910800484'],
  'vanguard-rank': ['1486003618447622145'],
  'galactic-rank': ['1486003815135186974'],
  'dominion-rank': ['1488938815736250548'],
  'warrior-kit': ['1488938986444685352'],
  'raider-kit': ['1488939032468787260'],
  'defender-kit': ['1488939107756540146'],
  'essentials-kit': ['1488938883268743309']
};

async function addRoleToUser(discordUserId, roleId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !discordUserId || !roleId) {
    console.warn('addRoleToUser skipped: missing token/guild/user/role', { DISCORD_BOT_TOKEN: !!DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, discordUserId, roleId });
    return;
  }
  try {
    await axios.put(
      `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {},
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`
        }
      }
    );
  } catch (error) {
    console.error(`Failed to add role ${roleId} to ${discordUserId}:`, error.response?.status, error.response?.data || error.message || error);
    throw error;
  }
}
const PURCHASE_WEBHOOK_URL = process.env.PURCHASE_WEBHOOK_URL || DISCORD_WEBHOOK_URL;

function formatTodayTime() {
  return `today at ${new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })}`;
}

async function sendPurchaseWebhook({
  item,
  discordId,
  discordUsername,
  gamertag,
  roleIds = [],
  orderId,
  serverLabel
}) {
  if (!PURCHASE_WEBHOOK_URL) return;

  const price = Number(item?.price || 0).toFixed(2);

  const userText = discordId
    ? `<@${discordId}>${gamertag ? ` (${gamertag})` : ''}`
    : `${discordUsername || 'Unknown'}${gamertag ? ` (${gamertag})` : ''}`;

  const roleText = roleIds.length
    ? `${roleIds.map(id => `<@&${id}>`).join(', ')} ✅ Given`
    : `No role given`;

  await axios.post(PURCHASE_WEBHOOK_URL, {
    allowed_mentions: { parse: ['users', 'roles'] },
    embeds: [
      {
        title: 'New Transaction',
        color: 0x22c55e,
        description: [
          `## *${item.title}* 💰`,
          `Price: **$${price}**`,
          `Role Given: ${roleText}`,
          `User: ${userText}`,
          serverLabel ? `Server: **${serverLabel}**` : null,
          orderId ? `Order ID: **${orderId}**` : null
        ].filter(Boolean).join('\n'),
        footer: {
          text: formatTodayTime()
        },
        timestamp: new Date().toISOString()
      }
    ]
  });
}
// ── Ensure directories / files ────────────────────────────────────────────
const sessionsDir = path.join(DATA_DIR, 'sessions');
[sessionsDir, PURCHASES_DIR, JEWELSTORE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── JSON helpers ──────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readProducts() {
  return readJson(PRODUCTS_PATH, []);
}

function writeProducts(products) {
  writeJson(PRODUCTS_PATH, products);
}

function readShopConfig() {
  return readJson(SHOP_CONFIG_PATH, {
    currency: 'usd',
    currencySymbol: '$',
    stripePublicKey: '',
    stripeCurrency: 'usd'
  });
}

function writeShopConfig(config) {
  writeJson(SHOP_CONFIG_PATH, {
    ...readShopConfig(),
    ...config
  });
}

function readGiftCards() {
  return readJson(GIFT_CARDS_PATH, []);
}

function writeGiftCards(cards) {
  writeJson(GIFT_CARDS_PATH, cards);
}

function readDonationQueue() {
  return readJson(DONATION_QUEUE_PATH, []);
}

function writeDonationQueue(items) {
  writeJson(DONATION_QUEUE_PATH, items);
}

function readDiscounts() {
  return readJson(DISCOUNTS_PATH, []);
}

function writeDiscounts(discounts) {
  writeJson(DISCOUNTS_PATH, discounts);
}

function getDiscountByCode(code) {
  if (!code) return null;
  const normalized = String(code || '').trim().toUpperCase();
  const discount = readDiscounts().find(d => String(d.code || '').trim().toUpperCase() === normalized && d.active !== false);
  if (discount) return discount;
  return readGiftCards().find(c => String(c.code || '').trim().toUpperCase() === normalized && c.active !== false) || null;
}

function calculateDiscountAmount(discount, total) {
  if (!discount || total <= 0) return 0;
  if (discount.type === 'percent') {
    return Math.min(total, (Number(discount.amount) || 0) / 100 * total);
  }
  return Math.min(total, Number(discount.amount) || 0);
}

function findProduct(productId) {
  const id = String(productId || '').trim();
  return readProducts().find(p => String(p.id).trim() === id) || null;
}

function getProductRoleIds(productId) {
  const product = findProduct(productId);
  if (product?.discordRoleIds && Array.isArray(product.discordRoleIds)) {
    return product.discordRoleIds.filter(Boolean);
  }
  return PURCHASE_ROLE_MAP[productId] || [];
}

async function getDiscordGuildId() {
  try {
    if (DISCORD_GUILD_ID) return String(DISCORD_GUILD_ID).trim();
    if (!DISCORD_BOT_TOKEN) return null;
    const res = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!Array.isArray(res.data) || !res.data.length) return null;
    return String(res.data[0].id).trim();
  } catch (error) {
    console.error('Failed to get Discord guild id:', error.response?.status, error.response?.data || error.message || error);
    return null;
  }
}

async function fetchDiscordChannels() {
  const guildId = await getDiscordGuildId();
  if (!DISCORD_BOT_TOKEN || !guildId) return [];
  try {
    const res = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    const messageChannelTypes = new Set([0, 5, '0', '5', 'GUILD_TEXT', 'GUILD_ANNOUNCEMENT', 'GUILD_NEWS']);
    return Array.isArray(res.data)
      ? res.data
        .filter(c => c && messageChannelTypes.has(c.type))
        .sort((a, b) => {
          const parentCompare = String(a.parent_id || '').localeCompare(String(b.parent_id || ''));
          if (parentCompare !== 0) return parentCompare;
          return (Number(a.position) || 0) - (Number(b.position) || 0);
        })
        .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null }))
      : [];
  } catch (error) {
    console.error('Failed to fetch Discord channels:', error.response?.status, error.response?.data || error.message || error);
    return [];
  }
}

async function sendDiscordMessage(channelId, content) {
  if (!DISCORD_BOT_TOKEN || !channelId || !content) return;
  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { content },
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
}

async function processCompletedPurchase(pending) {
  const links = readJson(LINKS_PATH, {});
  const linked = links[String(pending.discordId)] || {};
  const gamertag = linked?.gamertag || null;

  for (const item of pending.items || []) {
    const product = findProduct(item.id);
    const productRoleIds = getProductRoleIds(item.id);
    const productMessages = Array.isArray(product?.discordMessages) ? product.discordMessages : [];

    const grantedRoleIds = [];
    for (const roleId of productRoleIds) {
      try {
        await addRoleToUser(pending.discordId, roleId);
        grantedRoleIds.push(roleId);
      } catch (error) {
        console.error(`Failed to add role ${roleId} to ${pending.discordId}:`, error.response?.data || error.message);
      }
    }

    for (const expanded of expandBundleItem(item)) {
      savePurchasedItem({
        discordId: pending.discordId,
        discordUsername: pending.discordUsername,
        gamertag,
        item: expanded,
        orderId: pending.orderId
      });

      try {
        await sendPurchaseWebhook({
          item: expanded,
          discordId: pending.discordId,
          discordUsername: pending.discordUsername,
          gamertag,
          roleIds: grantedRoleIds,
          orderId: pending.orderId,
          serverLabel: expanded.server
        });
      } catch (error) {
        console.error('Purchase webhook failed:', error.response?.data || error.message);
      }
    }

    for (const message of productMessages) {
      try {
        await sendDiscordMessage(
          message.channelId,
          formatDiscordMessage(message.content, {
            user: pending.discordUsername || pending.discordId,
            orderId: pending.orderId,
            item: item.title
          })
        );
      } catch (error) {
        console.error('Failed to send Discord product message:', error.response?.data || error.message);
      }
    }
  }
}

function formatDiscordMessage(template, context = {}) {
  let text = String(template || '');
  for (const [key, value] of Object.entries(context)) {
    text = text.replace(new RegExp(`\{${key}\}`, 'g'), String(value));
  }
  return text;
}

function ensureJsonFile(file, fallback) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) writeJson(file, fallback);
}

// ── Bootstrap required data files ────────────────────────────────────────
ensureJsonFile(KITS_PURCHASES_PATH, []);
ensureJsonFile(PACKS_PURCHASES_PATH, []);
ensureJsonFile(VIPS_PURCHASES_PATH, []);
ensureJsonFile(RANKS_PURCHASES_PATH, []);
ensureJsonFile(PENDING_CHECKOUTS_PATH, {});
ensureJsonFile(COOLDOWNS_PATH, {});
ensureJsonFile(STORED_KITS_PATH, []);
ensureJsonFile(LINKS_PATH, {});
ensureJsonFile(JEWELS_PATH, {});
ensureJsonFile(JEWEL_LOGS_PATH, []);
ensureJsonFile(DONATION_QUEUE_PATH, []);
ensureJsonFile(PRODUCTS_PATH, [
  {
    id: 'doomsday-rank',
    title: 'Doomsday Rank',
    type: 'ranks',
    price: 59.99,
    currency: 'usd',
    stripePriceId: 'price_doomsday_rank',
    mode: 'payment',
    interval: 'month',
    allowMultiple: false,
    active: true,
    discordRoleIds: ['1486003753910800484'],
    discordMessages: [
      { channelId: '', content: 'Thanks for purchasing Doomsday Rank! Enjoy your perks.' }
    ],
    serverDiscounts: {}
  }
]);
ensureJsonFile(SHOP_CONFIG_PATH, {
  currency: 'usd',
  currencySymbol: '$',
  stripePublicKey: '',
  stripeCurrency: 'usd'
});
ensureJsonFile(GIFT_CARDS_PATH, []);
ensureJsonFile(DISCOUNTS_PATH, []);

// ── Bootstrap jewelstore example files ───────────────────────────────────
const JEWELSTORE_EXAMPLES = {
  'weapons.json': [
    { id: 'assault-rifle', displayName: 'Assault Rifle', ingameName: 'rifle.ak', category: 'Weapons', price: 150, quantity: 1, image: null },
    { id: 'thompson', displayName: 'Thompson', ingameName: 'smg.thompson', category: 'Weapons', price: 80, quantity: 1, image: null },
    { id: 'pump-shotgun', displayName: 'Pump Shotgun', ingameName: 'shotgun.pump', category: 'Weapons', price: 60, quantity: 1, image: null }
  ],
  'ammunition.json': [
    { id: 'hv-rifle-ammo', displayName: 'HV Rifle Ammo', ingameName: 'ammo.rifle.hv', category: 'Ammunition', price: 20, quantity: 128, image: null },
    { id: 'shotgun-slugs', displayName: 'Shotgun Slugs', ingameName: 'ammo.shotgun.slug', category: 'Ammunition', price: 15, quantity: 32, image: null }
  ],
  'resources.json': [
    { id: 'metal-frags', displayName: 'Metal Fragments', ingameName: 'metal.fragments', category: 'Resources', price: 10, quantity: 1000, image: null },
    { id: 'hqm', displayName: 'High Quality Metal', ingameName: 'metal.refined', category: 'Resources', price: 25, quantity: 100, image: null },
    { id: 'sulfur', displayName: 'Sulfur', ingameName: 'sulfur', category: 'Resources', price: 15, quantity: 1000, image: null }
  ],
  'components.json': [
    { id: 'rifle-body', displayName: 'Rifle Body', ingameName: 'riflebody', category: 'Components', price: 40, quantity: 1, image: null },
    { id: 'smg-body', displayName: 'SMG Body', ingameName: 'smgbody', category: 'Components', price: 30, quantity: 1, image: null }
  ],
  'construction.json': [
    { id: 'twig-floor', displayName: 'Sheet Metal', ingameName: 'metal.plate.torso', category: 'Construction', price: 20, quantity: 5, image: null }
  ],
  'medical.json': [
    { id: 'medical-syringe', displayName: 'Medical Syringe', ingameName: 'syringe.medical', category: 'Medical', price: 15, quantity: 5, image: null },
    { id: 'bandage', displayName: 'Bandage', ingameName: 'bandage', category: 'Medical', price: 5, quantity: 10, image: null }
  ],
  'attire.json': [
    { id: 'metal-facemask', displayName: 'Metal Facemask', ingameName: 'metal.facemask', category: 'Attire', price: 80, quantity: 1, image: null },
    { id: 'metal-chestplate', displayName: 'Metal Chestplate', ingameName: 'metal.plate.torso', category: 'Attire', price: 70, quantity: 1, image: null }
  ],
  'tools.json': [
    { id: 'salvaged-hammer', displayName: 'Salvaged Hammer', ingameName: 'hammer.salvaged', category: 'Tools', price: 30, quantity: 1, image: null },
    { id: 'chainsaw', displayName: 'Chainsaw', ingameName: 'chainsaw', category: 'Tools', price: 50, quantity: 1, image: null }
  ]
};

for (const [file, data] of Object.entries(JEWELSTORE_EXAMPLES)) {
  ensureJsonFile(path.join(JEWELSTORE_DIR, file), data);
}

// ── Jewels helpers ────────────────────────────────────────────────────────
function readJewels() {
  return readJson(JEWELS_PATH, {});
}

function writeJewels(data) {
  writeJson(JEWELS_PATH, data);
}

function getJewelBalance(discordId) {
  const jewels = readJewels();
  return jewels[String(discordId)]?.balance || 0;
}

function adjustJewels(discordId, delta) {
  const jewels = readJewels();
  const id = String(discordId);

  if (!jewels[id]) {
    jewels[id] = { balance: 0, totalEarned: 0, totalSpent: 0, updatedAt: null };
  }

  jewels[id].balance = Math.max(0, (jewels[id].balance || 0) + delta);
  if (delta > 0) jewels[id].totalEarned = (jewels[id].totalEarned || 0) + delta;
  if (delta < 0) jewels[id].totalSpent = (jewels[id].totalSpent || 0) + Math.abs(delta);
  jewels[id].updatedAt = new Date().toISOString();

  writeJewels(jewels);
  return jewels[id].balance;
}

function getUserEarnRate(discordId) {
  const ranks = readJson(RANKS_PURCHASES_PATH, []);
  const owned = new Set(
    ranks
      .filter(row => String(row.discordId) === String(discordId))
      .map(row => row.itemId)
  );

  let rate = JEWEL_EARN_RATES.base;
  if (owned.has('dominion-rank')) rate += JEWEL_EARN_RATES.dominion;
  if (owned.has('galactic-rank')) rate += JEWEL_EARN_RATES.galactic;
  if (owned.has('vanguard-rank')) rate += JEWEL_EARN_RATES.vanguard;
  if (owned.has('doomsday-rank')) rate += JEWEL_EARN_RATES.doomsday;

  return { rate, owned };
}

function writeJewelLog(entry) {
  const logs = readJson(JEWEL_LOGS_PATH, []);
  logs.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry
  });
  if (logs.length > 2000) logs.splice(2000);
  writeJson(JEWEL_LOGS_PATH, logs);
}

// ── Jewelstore helpers ────────────────────────────────────────────────────
function loadJewelstoreItems() {
  const files = fs.readdirSync(JEWELSTORE_DIR).filter(file => file.endsWith('.json'));
  const items = [];

  for (const file of files) {
    try {
      const data = readJson(path.join(JEWELSTORE_DIR, file), []);
      if (Array.isArray(data)) items.push(...data);
    } catch {}
  }

  return items;
}

function loadJewelstoreCategories() {
  const files = fs.readdirSync(JEWELSTORE_DIR).filter(file => file.endsWith('.json'));
  const categories = [];

  for (const file of files) {
    try {
      const data = readJson(path.join(JEWELSTORE_DIR, file), []);
      if (Array.isArray(data) && data.length > 0) {
        const categoryName = data[0]?.category || file.replace('.json', '');
        categories.push({
          file: file.replace('.json', ''),
          name: categoryName,
          items: data
        });
      }
    } catch {}
  }

  return categories;
}

// ── Purchase file helpers ─────────────────────────────────────────────────
function readStoredKits() {
  return readJson(STORED_KITS_PATH, []);
}

function writeStoredKits(data) {
  writeJson(STORED_KITS_PATH, data);
}

function readPurchaseFile(file) {
  ensureJsonFile(file, []);
  return readJson(file, []);
}

function writePurchaseFile(file, data) {
  writeJson(file, data);
}

function getPurchaseFile(item) {
  if (item?.type === 'kits') return KITS_PURCHASES_PATH;
  if (item?.type === 'packs') return PACKS_PURCHASES_PATH;
  if (item?.type === 'vip') return VIPS_PURCHASES_PATH;
  if (item?.type === 'ranks') return RANKS_PURCHASES_PATH;
  return null;
}

const ALL_SERVERS_PURCHASE_VALUE = 'all';

function normalizePurchaseServer() {
  return ALL_SERVERS_PURCHASE_VALUE;
}

function isAllServersPurchase(value) {
  return String(value || '').trim().toLowerCase() === ALL_SERVERS_PURCHASE_VALUE;
}

function purchaseServerMatches(rowServer, wantedServer = '') {
  const saved = String(rowServer || '').trim();
  const wanted = String(wantedServer || '').trim();
  return isAllServersPurchase(saved) || !wanted || saved === wanted;
}

function productAllowsMultiple(itemOrId) {
  const product = typeof itemOrId === 'object' && itemOrId
    ? findProduct(itemOrId.id)
    : findProduct(itemOrId);
  return !!product?.allowMultiple;
}

function savePurchasedItem({ discordId, discordUsername, gamertag = null, item, orderId }) {
  const file = getPurchaseFile(item);
  if (!file) return false;

  if (discordId && item?.id && !productAllowsMultiple(item) && userOwnsProduct(discordId, item.id, item.server || '')) {
    return false;
  }

  const rows = readPurchaseFile(file);
  rows.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    orderId: orderId || null,
    discordId: discordId || null,
    discordUsername: discordUsername || 'Unknown',
    gamertag: gamertag || null,
    itemId: item.id || null,
    title: item.title || 'Unknown',
    type: item.type || '',
    price: Number(item.price) || 0,
    server: normalizePurchaseServer(item.server),
    purchasedAt: new Date().toISOString(),
    claimed: false,
    claimedAt: null
  });

  writePurchaseFile(file, rows);
  return true;
}

function expandBundleItem(item) {
  if (!item || item.id !== 'all-ranks-bundle') return [item];

  return [
    { ...item, id: 'doomsday-rank', title: 'Doomsday Rank', type: 'ranks' },
    { ...item, id: 'vanguard-rank', title: 'Vanguard Rank', type: 'ranks' },
    { ...item, id: 'galactic-rank', title: 'Galactic Rank', type: 'ranks' },
    { ...item, id: 'dominion-rank', title: 'Dominion Rank', type: 'ranks' }
  ];
}
function buildDashboardOrders() {
  cleanupExpiredPurchases();

const rows = [
  ...readPurchaseFile(KITS_PURCHASES_PATH).map(row => ({ ...row, __type: 'kits' })),
  ...readPurchaseFile(PACKS_PURCHASES_PATH).map(row => ({ ...row, __type: 'packs' })),
  ...readPurchaseFile(VIPS_PURCHASES_PATH).map(row => ({ ...row, __type: 'vip' })),
  ...readPurchaseFile(RANKS_PURCHASES_PATH).map(row => ({ ...row, __type: 'ranks' }))
];

  const grouped = new Map();

  for (const row of rows) {
    const key = row.orderId || row.id || `ORDER-${Date.now()}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        orderId: key,
        timestamp: row.purchasedAt || new Date().toISOString(),
        total: 0,
        discordId: row.discordId || null,
        discordUsername: row.discordUsername || 'Unknown',
        items: []
      });
    }

    const group = grouped.get(key);

    group.total += Number(row.price) || 0;
    group.items.push({
      id: row.itemId || null,
      title: row.title || row.itemId || 'Unknown',
      type: row.type || row.__type || '',
      price: Number(row.price) || 0,
      server: row.server || '',
      _expiry: row._expiry || row.expiresAt || null,
      _gifted: !!(row._gifted || row.gifted)
    });

    if (row.purchasedAt && new Date(row.purchasedAt).getTime() > new Date(group.timestamp).getTime()) {
      group.timestamp = row.purchasedAt;
    }
  }

  return [...grouped.values()].sort(
    (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
  );
}

function removePurchasedItem({ discordId, itemId, title, serverId }) {
  const files = [KITS_PURCHASES_PATH, PACKS_PURCHASES_PATH, VIPS_PURCHASES_PATH, RANKS_PURCHASES_PATH];
  const wantedServer = String(serverId || '').trim();

  for (const file of files) {
    const rows = readPurchaseFile(file);
    const index = rows.findIndex(row =>
      String(row.discordId) === String(discordId) &&
      (!itemId || row.itemId === itemId) &&
      (!title || row.title === title) &&
      purchaseServerMatches(row.server, wantedServer)
    );

    if (index !== -1) {
      rows.splice(index, 1);
      writePurchaseFile(file, rows);
      return true;
    }
  }

  return false;
}

function cleanupExpiredPurchaseFile(file) {
  const rows = readPurchaseFile(file);
  const now = Date.now();

  const kept = rows.filter(row => {
    if (!row?._expiry) return true;

    const expiresAt = new Date(row._expiry).getTime();
    if (!Number.isFinite(expiresAt)) return true;

    return expiresAt > now;
  });

  if (kept.length !== rows.length) {
    writePurchaseFile(file, kept);
  }
}

function cleanupExpiredPurchases() {
  cleanupExpiredPurchaseFile(KITS_PURCHASES_PATH);
  cleanupExpiredPurchaseFile(PACKS_PURCHASES_PATH);
  cleanupExpiredPurchaseFile(VIPS_PURCHASES_PATH);
  cleanupExpiredPurchaseFile(RANKS_PURCHASES_PATH);
}

function userOwnsProduct(discordId, itemId, serverId = '') {
  cleanupExpiredPurchases();

  const wantedServer = String(serverId || '').trim();
  const files = [KITS_PURCHASES_PATH, PACKS_PURCHASES_PATH, VIPS_PURCHASES_PATH, RANKS_PURCHASES_PATH];
  return files.some(file =>
    readPurchaseFile(file).some(row =>
      String(row.discordId) === String(discordId) &&
      row.itemId === itemId &&
      purchaseServerMatches(row.server, wantedServer)
    )
  );
}

// ── Cooldown helpers ──────────────────────────────────────────────────────
function readCooldowns() {
  ensureJsonFile(COOLDOWNS_PATH, {});
  return readJson(COOLDOWNS_PATH, {});
}

function writeCooldowns(data) {
  writeJson(COOLDOWNS_PATH, data);
}

function getCooldownKey(discordId, itemId, claimType, serverId = '') {
  return `${discordId}:${itemId}:${claimType}:${String(serverId || '').trim()}`;
}

function getUserCooldowns(discordId) {
  const all = readCooldowns();
  const prefix = `${discordId}:`;
  const result = {};

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }

  return result;
}

function setCooldown(discordId, itemId, claimType, serverId = '') {
  const durationMs = COOLDOWN_DURATION_MS[itemId] || 6 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + durationMs).toISOString();

  const all = readCooldowns();
  all[getCooldownKey(discordId, itemId, claimType, serverId)] = expiresAt;
  writeCooldowns(all);

  return expiresAt;
}

function isCooldownActive(discordId, itemId, claimType, serverId = '') {
  const all = readCooldowns();
  const iso = all[getCooldownKey(discordId, itemId, claimType, serverId)];
  if (!iso) return false;
  return new Date(iso).getTime() > Date.now();
}

// ── Pending checkouts ─────────────────────────────────────────────────────
function readPendingCheckouts() {
  ensureJsonFile(PENDING_CHECKOUTS_PATH, {});
  return readJson(PENDING_CHECKOUTS_PATH, {});
}

function writePendingCheckouts(data) {
  writeJson(PENDING_CHECKOUTS_PATH, data);
}

function savePendingCheckout(sessionId, payload) {
  const all = readPendingCheckouts();
  all[sessionId] = payload;
  writePendingCheckouts(all);
}

function getPendingCheckout(sessionId) {
  return readPendingCheckouts()[sessionId] || null;
}

function deletePendingCheckout(sessionId) {
  const all = readPendingCheckouts();
  delete all[sessionId];
  writePendingCheckouts(all);
}

// ── In-memory server state ────────────────────────────────────────────────
const serverState = {};
for (const server of serversConfig) {
  serverState[server.id] = { players: [], bans: [], info: null, logs: [] };
}

function ensureServerState(serverId) {
  if (!serverState[serverId]) {
    serverState[serverId] = { players: [], bans: [], info: null, logs: [] };
  }
  return serverState[serverId];
}

// ── RCE setup ─────────────────────────────────────────────────────────────
const rce = new RCEManager({ logger: { level: LogLevel.Info } });

const POLLING_CMDS = new Set(['playerlist', 'banlist', 'serverinfo']);

function isPollingEntry(type, message) {
  if (type !== 'console') return false;

  const msg = String(message || '').trim().toLowerCase();
  for (const cmd of POLLING_CMDS) {
    if (msg.startsWith(`> ${cmd}`) || msg === cmd) return true;
  }

  return false;
}

function pushLog(serverId, type, raw) {
  const state = ensureServerState(serverId);
  const message = String(raw ?? '').trim();

  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    type,
    message,
    polling: isPollingEntry(type, message)
  };

  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.splice(0, state.logs.length - 500);
  }

  io.to(`server:${serverId}`).emit('log', entry);
}

// ── Parse helpers ─────────────────────────────────────────────────────────
function extractJson(raw) {
  const str = String(raw ?? '');
  const arrIdx = str.indexOf('[');
  const objIdx = str.indexOf('{');

  let start = -1;
  let end = -1;

  if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) {
    start = arrIdx;
    end = str.lastIndexOf(']');
  } else {
    start = objIdx;
    end = str.lastIndexOf('}');
  }

  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(str.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseBanList(raw) {
  const lines = String(raw ?? '').split('\n');
  const bans = [];
  const re = /\[(\d+)\]\s+User\s+\[(.+?)\]\s+Expiry\s+\[(.+?)\]/;

  for (const line of lines) {
    const match = line.match(re);
    if (!match) continue;

    const expiry = match[3].trim();
    bans.push({
      index: parseInt(match[1], 10),
      username: match[2].trim(),
      expiry,
      permanent: expiry === '12/31/9999 23:59:59' || expiry.startsWith('12/31/9999')
    });
  }

  return bans;
}

// ── RCE claim kit ─────────────────────────────────────────────────────────
async function rceClaimKit(serverId, kitName, gamertag) {
  const cmd = `kit givetoplayer "${kitName}" "${gamertag}"`;
  let result = '';

  try {
    result = await rce.sendCommand(serverId, cmd);
    pushLog(serverId, 'info', `CLAIM: ${cmd} → ${result}`);
  } catch (error) {
    pushLog(serverId, 'error', `CLAIM ERROR: ${cmd} → ${error.message}`);
    throw new Error('RCE command failed');
  }

  const text = String(result || '').toLowerCase();
  const success =
    (text.includes('[kitmanager]') && text.includes('successfully gave')) ||
    text.includes('successfully gave') ||
    text.includes('kit given') ||
    text.includes('gave kit');

  if (!success) {
    const failure =
      text.includes('player not found') ||
      text.includes('no player') ||
      text.includes('error') ||
      text.includes('failed');

    if (failure) {
      throw new Error(`Kit delivery failed: ${result}`);
    }
  }

  return true;
}

// ── RCE give inventory item ───────────────────────────────────────────────
async function rceGiveItem(serverId, ingameName, gamertag, quantity) {
  const cmd = `inventory.giveto "${gamertag}" "${ingameName}" ${quantity}`;
  let result = '';

  try {
    result = await rce.sendCommand(serverId, cmd);
    pushLog(serverId, 'info', `JEWEL PURCHASE: ${cmd} → ${result}`);
  } catch (error) {
    pushLog(serverId, 'error', `JEWEL PURCHASE ERROR: ${cmd} → ${error.message}`);
    throw new Error('RCE command failed');
  }

  const text = String(result || '').toLowerCase();
  if (text.includes('player not found') || text.includes('no player')) {
    throw new Error('Player not found in-game. Make sure you are online on the server.');
  }

  return true;
}

// ── Polling ───────────────────────────────────────────────────────────────
const PLAYER_POLL_MS = 5_000;
const BAN_POLL_MS = 5_000;
const SERVERINFO_POLL_MS = 5_000;
const JEWEL_AWARD_INTERVAL_MS = 60 * 1000;

async function pollPlayers(serverId) {
  try {
    const raw = await rce.sendCommand(serverId, 'playerlist');
    pushLog(serverId, 'console', `> playerlist\n${raw}`);

    const arr = extractJson(raw);
    if (Array.isArray(arr)) {
      ensureServerState(serverId).players = arr;
      io.to(`server:${serverId}`).emit('players', arr);
    }
  } catch (error) {
    pushLog(serverId, 'error', `playerlist error: ${error.message}`);
  }
}

async function pollBans(serverId) {
  try {
    const raw = await rce.sendCommand(serverId, 'banlist');
    pushLog(serverId, 'console', `> banlist\n${raw}`);

    const bans = parseBanList(raw);
    ensureServerState(serverId).bans = bans;
    io.to(`server:${serverId}`).emit('bans', bans);
  } catch (error) {
    pushLog(serverId, 'error', `banlist error: ${error.message}`);
  }
}

async function pollServerInfo(serverId) {
  try {
    const raw = await rce.sendCommand(serverId, 'serverinfo');
    pushLog(serverId, 'console', `> serverinfo\n${raw}`);

    const info = extractJson(raw);
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      ensureServerState(serverId).info = info;
      io.to(`server:${serverId}`).emit('serverinfo', info);
    }
  } catch (error) {
    pushLog(serverId, 'error', `serverinfo error: ${error.message}`);
  }
}
// ── RCE init ──────────────────────────────────────────────────────────────
async function initRCE() {
  for (const server of serversConfig) {
    try {
    await rce.addServer({
  identifier: server.id,
  rcon: server.rcon,
  state: server.state,
  intents: [RCEIntent.PlayerList],
  intentTimers: {
    [RCEIntent.PlayerList]: PLAYER_POLL_MS
  },
  reconnection: {
    enabled: true,
    interval: 10_000,
    maxAttempts: -1
  }
});

      pushLog(server.id, 'info', `✅ Connected to ${server.label}`);

      const playerInterval = setInterval(() => pollPlayers(server.id), PLAYER_POLL_MS);
const banInterval = setInterval(() => pollBans(server.id), BAN_POLL_MS);
const serverInfoInterval = setInterval(() => pollServerInfo(server.id), SERVERINFO_POLL_MS);

if (typeof playerInterval.unref === 'function') playerInterval.unref();
if (typeof banInterval.unref === 'function') banInterval.unref();
if (typeof serverInfoInterval.unref === 'function') serverInfoInterval.unref();

await pollPlayers(server.id);
await pollBans(server.id);
await pollServerInfo(server.id);
    } catch (error) {
      pushLog(server.id, 'error', `❌ Failed to connect to ${server.label}: ${error.message}`);
      console.error(`RCE addServer failed for ${server.id}:`, error);
    }
  }

  try {
    killtracker.init(null, rce);
  } catch (error) {
    console.error('killtracker init failed:', error);
  }

  try {
    playtimetracker.init(null, rce, serversConfig);
  } catch (error) {
    console.error('playtimetracker init failed:', error);
  }
}

// ── Stripe webhook ────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

if (event.type === 'checkout.session.completed') {
  const checkoutSession = event.data.object;
  const pending = getPendingCheckout(checkoutSession.id);

  if (!pending) {
    console.warn('No pending checkout for session:', checkoutSession.id);
    return res.json({ received: true });
  }

  try {
    await processCompletedPurchase(pending);
  } catch (error) {
    console.error('Error processing completed purchase:', error.response?.data || error.message || error);
  }

  if (pending.donationItemId) {
    const queueItems = readDonationQueue();
    const queueIndex = queueItems.findIndex(q => q.id === pending.donationItemId);
    if (queueIndex >= 0) {
      queueItems[queueIndex] = {
        ...queueItems[queueIndex],
        status: 'paid',
        paymentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkoutSessionId: checkoutSession.id
      };
      writeDonationQueue(queueItems);
    }
  }

  deletePendingCheckout(checkoutSession.id);

  console.log('Saved paid purchase:', {
    sessionId: checkoutSession.id,
    orderId: pending.orderId,
    discordId: pending.discordId
  });
}

  res.json({ received: true });
});

// ── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'spirals.sid',
    store: new FileStore({
      path: sessionsDir,
      ttl: 7 * 24 * 60 * 60,
      retries: 1,
      logFn: () => {}
    }),
    secret: SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.get('/admin-shop.html', requireDash, (req, res) => {
  res.redirect('/admin/shop');
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helpers ──────────────────────────────────────────────────────────
function getDashboardIds() {
  return String(DASHBOARD_ACCESS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getDefaultAvatarIndex(user) {
  const d = parseInt(user?.discriminator ?? '', 10);
  if (Number.isFinite(d) && d > 0) return d % 5;

  try {
    return Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    return 0;
  }
}

function getAvatarUrl(user) {
  if (user?.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${getDefaultAvatarIndex(user)}.png`;
}

function isLoggedIn(req) {
  return !!req.session?.user;
}

function hasAccess(id) {
  return getDashboardIds().includes(String(id));
}

function requireDash(req, res, next) {
  if (!isLoggedIn(req) || !hasAccess(req.session.user.id)) {
    return req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'Unauthorized' })
      : res.redirect('/');
  }
  next();
}

function requireLogin(req, res, next) {
  if (!isLoggedIn(req)) {
    return req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'Unauthorized' })
      : res.redirect('/');
  }
  next();
}

function getLoggedInUsers() {
  const users = new Map();

  if (!fs.existsSync(sessionsDir)) return [];

  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;

    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      const user = data?.user;
      const expires = data?.cookie?.expires ? new Date(data.cookie.expires).getTime() : null;

      if (!user?.id) continue;
      if (expires && expires < Date.now()) continue;

      users.set(String(user.id), {
        id: String(user.id),
        username: user.username || 'Unknown',
        globalName: user.globalName || user.username || 'Unknown',
        avatar: user.avatar || null
      });
    } catch {}
  }

  return [...users.values()];
}

function buildDiscordAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope: 'identify',
    state
  });

  return `${DISCORD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function getSafeReturnTo(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  if (raw.startsWith('/auth/discord')) return '/';
  return raw;
}

// ── OAuth ─────────────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res.status(500).send('Discord OAuth is not configured.');
  }

  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.oauthReturnTo = getSafeReturnTo(req.query.returnTo || '/');

  req.session.save(err => {
    if (err) {
      console.error('Failed to save OAuth session:', err);
      return res.status(500).send('Failed to start OAuth.');
    }

    res.redirect(buildDiscordAuthUrl(state));
  });
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');

  const expectedState = req.session.oauthState;
  const returnTo = getSafeReturnTo(req.session.oauthReturnTo || '/');

  delete req.session.oauthState;
  delete req.session.oauthReturnTo;

  if (!code) {
    return req.session.save(() => res.redirect('/'));
  }

  if (!expectedState || state !== expectedState) {
    return req.session.save(() => res.status(400).send('Invalid OAuth state.'));
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_CALLBACK_URL
    });

    const tokenRes = await axios.post(DISCORD_OAUTH_TOKEN_URL, tokenBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      throw new Error('No access token returned from Discord.');
    }

    const userRes = await axios.get(DISCORD_API_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const u = userRes.data;
    const safeUser = {
      id: u.id,
      username: u.username,
      discriminator: u.discriminator,
      globalName: u.global_name || u.username,
      avatar: getAvatarUrl(u)
    };

    req.session.user = safeUser;

    await sendLoginWebhook(safeUser);

    req.session.save(err => {
      if (err) console.error('Session save error:', err);
      res.redirect(returnTo);
    });
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    req.session.save(() => res.redirect('/'));
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('spirals.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
    res.redirect('/');
  });
});

// ── API: Me ───────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!isLoggedIn(req)) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    user: req.session.user,
    hasDashboard: hasAccess(req.session.user.id),
    canUseTestCheckout: isAdminBypassUser(req.session.user.id)
  });
});

// ── API: Jewels ───────────────────────────────────────────────────────────
app.get('/api/jewels/balance', requireLogin, (req, res) => {
  const userId = String(req.session.user.id);
  const balance = getJewelBalance(userId);
  const { rate, owned } = getUserEarnRate(userId);

  res.json({
    ok: true,
    balance,
    earnRate: rate,
    ownedRanks: [...owned]
  });
});

app.get('/api/jewels/store', (req, res) => {
  try {
    const categories = loadJewelstoreCategories();
    res.json({ ok: true, categories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jewels/award', requireDash, (req, res) => {
  const { discordId, amount } = req.body;
  if (!discordId || amount == null) {
    return res.status(400).json({ error: 'Missing discordId or amount' });
  }

  const newBal = adjustJewels(String(discordId), Number(amount));
  res.json({ ok: true, balance: newBal });
});

app.post('/api/jewels/purchase', requireLogin, async (req, res) => {
  const { itemId, quantity, serverId } = req.body;
  const userId = String(req.session.user.id);

  if (!itemId || !quantity || !serverId) {
    return res.status(400).json({ error: 'Missing itemId, quantity or serverId' });
  }

  const targetServer = serversConfig.find(s => s.id === serverId);
  if (!targetServer) {
    return res.status(400).json({ error: 'Unknown server' });
  }

  if (JEWELSTORE_SERVER_ID && serverId !== JEWELSTORE_SERVER_ID) {
    return res.status(403).json({ error: `Jewel store purchases are only allowed on ${JEWELSTORE_SERVER_ID}.` });
  }

  const links = readJson(LINKS_PATH, {});
  const link = links[userId];
  if (!link?.gamertag) {
    return res.status(403).json({ error: 'Account not linked. Link your Xbox gamertag first.' });
  }

  const allItems = loadJewelstoreItems();
  const item = allItems.find(i => i.id === itemId);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }

  const qty = Math.max(1, Math.min(10, Math.floor(Number(quantity))));
  const totalCost = item.price * qty;
  const balance = getJewelBalance(userId);

 if (balance < totalCost) {
  writeJewelLog({
    type: 'declined',
    discordId: userId,
    discordUsername: req.session.user?.globalName || req.session.user?.username || 'Unknown',
    gamertag: link.gamertag,
    itemId: item.id,
    itemName: item.displayName,
    category: item.category,
    quantity: qty,
    unitPrice: item.price,
    totalCost,
    balanceBefore: balance,
    balanceAfter: balance,
    reason: 'insufficient_jewels',
    serverId
  });

  return res.status(402).json({
    error: `Insufficient jewels. Need ${totalCost}, have ${balance}.`
  });
}

  try {
    await rceGiveItem(serverId, item.ingameName, link.gamertag, item.quantity * qty);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const newBalance = adjustJewels(userId, -totalCost);
  writeJewelLog({
  type: 'purchase',
  discordId: userId,
  discordUsername: req.session.user?.globalName || req.session.user?.username || 'Unknown',
  gamertag: link.gamertag,
  itemId: item.id,
  itemName: item.displayName,
  category: item.category,
  quantity: qty,
  unitPrice: item.price,
  totalCost,
  balanceBefore: balance,
  balanceAfter: newBalance,
  serverId
});
res.json({ ok: true, spent: totalCost, balance: newBalance, item: item.displayName, quantity: qty });
});

// ── API: Cooldowns ────────────────────────────────────────────────────────
app.get('/api/cooldowns', requireLogin, (req, res) => {
  res.json(getUserCooldowns(String(req.session.user.id)));
});

// ── API: Claim ────────────────────────────────────────────────────────────
app.post('/api/claim', requireLogin, async (req, res) => {
const { itemId, claimType, serverId } = req.body;
const userId = String(req.session.user.id);

if (!itemId || !claimType || !serverId) {
  return res.status(400).json({ error: 'Missing itemId, claimType or serverId' });
}

const links = readJson(LINKS_PATH, {});
const linked = links[userId];
const gamertag = String(linked?.gamertag || '').trim();

if (!gamertag) {
  return res.status(403).json({ error: 'Account not linked. Link your Xbox gamertag first.' });
}

  const allPurchases = [
  ...readPurchaseFile(RANKS_PURCHASES_PATH),
  ...readPurchaseFile(KITS_PURCHASES_PATH),
  ...readPurchaseFile(PACKS_PURCHASES_PATH)
];

const ownedPurchase = allPurchases.find(
  purchase =>
    String(purchase.discordId) === userId &&
    purchase.itemId === itemId &&
    String(purchase.server || '').trim() === String(serverId).trim()
);

if (!ownedPurchase) {
  return res.status(403).json({ error: 'You do not own this item' });
}

if (isCooldownActive(userId, itemId, claimType, serverId)) {
  const all = readCooldowns();
  const iso = all[getCooldownKey(userId, itemId, claimType, serverId)];
  return res.status(429).json({ error: 'Still on cooldown', expiresAt: iso });
}

  const names = KIT_COMMAND_NAMES[itemId];
  if (!names) {
    return res.status(400).json({ error: 'Unknown item' });
  }

  const kitName = names[claimType];
  if (!kitName) {
    return res.status(400).json({
      error: `Invalid claimType "${claimType}" for ${itemId}`
    });
  }

  const finalServerId = String(ownedPurchase.server || '').trim();

if (!finalServerId) {
  return res.status(500).json({ error: 'No server configured' });
}

const targetServer = serversConfig.find(s => s.id === finalServerId);
if (!targetServer) {
  return res.status(400).json({ error: 'Invalid server on owned product' });
}

  try {
    await rceClaimKit(finalServerId, kitName, gamertag);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'RCE claim failed' });
  }

  const expiresAt = setCooldown(userId, itemId, claimType, serverId);
  res.json({ ok: true, expiresAt });
});

// ── API: Inventory ────────────────────────────────────────────────────────
app.get('/api/inventory', requireLogin, (req, res) => {
  cleanupExpiredPurchases();

  const userId = String(req.session.user.id);
  const wantedServer = String(req.query.serverId || '').trim();

  const matchRow = row =>
    String(row.discordId) === userId &&
    (!wantedServer || String(row.server || '').trim() === wantedServer);

  res.json({
  ok: true,
  ranks: readPurchaseFile(RANKS_PURCHASES_PATH).filter(matchRow),
  kits: readPurchaseFile(KITS_PURCHASES_PATH).filter(matchRow),
  packs: readPurchaseFile(PACKS_PURCHASES_PATH).filter(matchRow),
  vips: readPurchaseFile(VIPS_PURCHASES_PATH).filter(matchRow)
});
});

app.post('/api/admin/gift', requireDash, (req, res) => {
  const { discordId, discordUsername, products, expiresAt, serverId } = req.body || {};

  if (!discordId || !Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'Missing discordId or products' });
  }

  if (!serverId || !serversConfig.some(s => s.id === serverId)) {
  return res.status(400).json({ error: 'Invalid or missing serverId' });
}

  cleanupExpiredPurchases();

  const seen = new Set();
  const cleanProducts = [];

  for (const product of products) {
    const itemId = String(product?.itemId || '').trim();
    const title = String(product?.title || '').trim();
    const type = String(product?.type || '').trim();

    if (!itemId || !title || !type) {
      return res.status(400).json({ error: 'Each product needs itemId, title, and type' });
    }

    if (seen.has(itemId)) continue;
    seen.add(itemId);

    cleanProducts.push({ itemId, title, type });
  }

  if (!cleanProducts.length) {
    return res.status(400).json({ error: 'No valid products selected' });
  }

  const alreadyOwned = cleanProducts.filter(product =>
  userOwnsProduct(discordId, product.itemId, serverId)
);

  if (alreadyOwned.length) {
    return res.status(400).json({
      error: `User already owns: ${alreadyOwned.map(p => p.title).join(', ')}`
    });
  }

  const sharedOrderId = `GIFT-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
  const nowIso = new Date().toISOString();

  const existingRows = [
  ...readPurchaseFile(KITS_PURCHASES_PATH),
  ...readPurchaseFile(PACKS_PURCHASES_PATH),
  ...readPurchaseFile(VIPS_PURCHASES_PATH),
  ...readPurchaseFile(RANKS_PURCHASES_PATH)
];

const existingUser = existingRows.find(row =>
  String(row.discordId) === String(discordId) &&
  row.discordUsername &&
  row.discordUsername !== 'Unknown'
);

const finalDiscordUsername =
  String(discordUsername || '').trim() ||
  existingUser?.discordUsername ||
  String(discordId);

  for (const product of cleanProducts) {
    const item = {
  id: product.itemId,
  title: product.title,
  type: product.type,
  price: 0,
  server: serverId
};

    const file = getPurchaseFile(item);
    if (!file) {
      return res.status(400).json({ error: `Invalid product type for ${product.title}` });
    }

    const rows = readPurchaseFile(file);

    rows.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      orderId: sharedOrderId,
      discordId: String(discordId),
      discordUsername: finalDiscordUsername,
      gamertag: null,
      itemId: product.itemId,
      title: product.title,
      type: product.type,
      price: 0,
      server: serverId,
      purchasedAt: nowIso,
      claimed: false,
      claimedAt: null,
      _gifted: true,
      _expiry: expiresAt || null
    });

    writePurchaseFile(file, rows);
  }

  res.json({
    ok: true,
    added: cleanProducts.length,
    orderId: sharedOrderId
  });
});

app.post('/api/admin/link-gamertag', requireDash, (req, res) => {
  const { discordId, gamertag } = req.body || {};

  if (!discordId) {
    return res.status(400).json({ error: 'Missing discordId' });
  }

  const links = readJson(LINKS_PATH, {});
  const id = String(discordId);
  const cleanTag = String(gamertag || '').trim();

  if (!cleanTag) {
    delete links[id];
  } else {
    links[id] = {
      ...(links[id] || {}),
      gamertag: cleanTag,
      linkedAt: (links[id] && links[id].linkedAt) || new Date().toISOString()
    };
  }

  writeJson(LINKS_PATH, links);
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireDash, (req, res) => {
  res.json(buildDashboardOrders());
});

app.get('/api/admin/jewellogs', requireDash, (req, res) => {
  res.json(readJson(JEWEL_LOGS_PATH, []));
});

app.get('/api/admin/logged-in-users', requireDash, (req, res) => {
  res.json(getLoggedInUsers());
});

app.post('/api/admin/remove-product', requireDash, (req, res) => {
  const { discordId, itemId, title, serverId } = req.body || {};

  if (!discordId || (!itemId && !title) || !serverId) {
    return res.status(400).json({ error: 'Missing discordId, serverId, and itemId/title' });
  }

  const removed = removePurchasedItem({ discordId, itemId, title, serverId });
  if (!removed) {
    return res.status(404).json({ error: 'Product not found' });
  }

  res.json({ ok: true });
});

app.get('/api/products', (req, res) => {
  const config = readShopConfig();
  const products = readProducts().filter(p => p.active !== false);
  res.json({ products, shopConfig: config });
});

app.get('/api/admin/products', requireDash, (req, res) => {
  res.json(readProducts());
});

app.post('/api/admin/products', requireDash, (req, res) => {
  const product = req.body || {};
  if (!product.id || !product.title || !product.type) {
    return res.status(400).json({ error: 'Product id, title, and type are required' });
  }

  const existingProducts = readProducts();
  const normalized = {
    id: String(product.id).trim(),
    title: String(product.title).trim(),
    type: String(product.type).trim(),
    description: String(product.description || '').trim(),
    price: Number(product.price) || 0,
    currency: 'usd',
    currencySymbol: '$',
    stripePriceId: String(product.stripePriceId || '').trim(),
    mode: product.mode === 'subscription' ? 'subscription' : 'payment',
    interval: String(product.interval || 'month').trim(),
    allowMultiple: Boolean(product.allowMultiple),
    active: product.active !== false,
    serverDiscounts: typeof product.serverDiscounts === 'object' && product.serverDiscounts !== null ? product.serverDiscounts : {},
    discordRoleIds: Array.isArray(product.discordRoleIds) ? product.discordRoleIds.filter(Boolean) : [],
    discordMessages: Array.isArray(product.discordMessages)
      ? product.discordMessages.map(m => ({ channelId: String(m.channelId || '').trim(), content: String(m.content || '').trim() }))
      : []
  };

  const index = existingProducts.findIndex(p => p.id === normalized.id);
  if (index >= 0) {
    existingProducts[index] = { ...existingProducts[index], ...normalized };
  } else {
    existingProducts.unshift(normalized);
  }

  writeProducts(existingProducts);
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('shop:update'); } catch (e) {}
  res.json({ ok: true, product: normalized });
});

app.delete('/api/admin/products/:id', requireDash, (req, res) => {
  const products = readProducts();
  const id = String(req.params.id || '').trim();
  const filtered = products.filter(p => String(p.id).trim() !== id);
  if (filtered.length === products.length) {
    return res.status(404).json({ error: 'Product not found' });
  }
  writeProducts(filtered);
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('shop:update'); } catch (e) {}
  res.json({ ok: true });
});

app.get('/api/admin/stripe-config', requireDash, (req, res) => {
  res.json(readShopConfig());
});

app.post('/api/admin/stripe-config', requireDash, (req, res) => {
  const { stripePublicKey } = req.body || {};
  writeShopConfig({ currency: 'usd', currencySymbol: '$', stripePublicKey, stripeCurrency: 'usd' });
  res.json({ ok: true, config: readShopConfig() });
});

app.get('/api/admin/discord/channels', requireDash, async (req, res) => {
  try {
    const channels = await fetchDiscordChannels();
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch Discord channels' });
  }
});

// Debug endpoint: return discord channels fetched server-side (localhost only)
app.get('/api/debug/discord/channels', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (!(ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const channels = await fetchDiscordChannels();
    res.json({ ok: true, channels });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.get('/api/donation-queue', (req, res) => {
  const items = readDonationQueue()
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  res.json(items);
});

app.get('/api/donation-queue/me', requireLogin, (req, res) => {
  const userId = String(req.session.user.id);
  const items = readDonationQueue()
    .filter(item => String(item.discordId) === userId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  res.json(items);
});

app.post('/api/donation-queue', requireLogin, async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const currency = String(req.body.currency || readShopConfig().currency || 'usd').trim().toLowerCase();
    const note = String(req.body.note || '').trim();
    const serverInfo = String(req.body.serverInfo || '').trim();
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Donation amount must be greater than zero' });
    }

    const queueItem = {
      id: `dq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      discordId: String(req.session.user.id),
      discordUsername: req.session.user.globalName || req.session.user.username || 'Unknown',
      amount: Number(amount.toFixed(2)),
      currency,
      note,
      serverInfo,
      status: 'checkout',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkoutSessionId: null,
      paymentAt: null,
      adminNote: null,
      assignedTo: null
    };

    const items = readDonationQueue();
    items.push(queueItem);
    writeDonationQueue(items);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: 'Donation Queue Request',
              description: note || 'Donation for Discord queue management'
            },
            unit_amount: Math.max(1, Math.round(amount * 100))
          },
          quantity: 1
        }
      ],
      success_url: `${APP_BASE_URL}/donation-queue?success=1&itemId=${queueItem.id}`,
      cancel_url: `${APP_BASE_URL}/donation-queue`,
      client_reference_id: req.session.user.id,
      metadata: {
        donationItemId: queueItem.id,
        amount: queueItem.amount,
        currency: queueItem.currency
      }
    });

    queueItem.checkoutSessionId = checkoutSession.id;
    writeDonationQueue(items);

    savePendingCheckout(checkoutSession.id, {
      donationItemId: queueItem.id,
      discordId: queueItem.discordId,
      discordUsername: queueItem.discordUsername,
      amount: queueItem.amount,
      currency: queueItem.currency,
      note: queueItem.note,
      orderId: `DQ-${Math.random().toString(36).toUpperCase().slice(2, 10)}`
    });

    res.json({ url: checkoutSession.url, itemId: queueItem.id });
  } catch (error) {
    console.error('Donation queue creation failed:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'Failed to create donation queue request' });
  }
});

app.patch('/api/donation-queue/:id', requireDash, (req, res) => {
  const id = String(req.params.id || '').trim();
  const items = readDonationQueue();
  const index = items.findIndex(item => item.id === id);
  if (index < 0) {
    return res.status(404).json({ error: 'Donation queue request not found' });
  }

  const item = items[index];
  const updates = req.body || {};
  if (updates.status) item.status = String(updates.status).trim();
  if (typeof updates.adminNote === 'string') item.adminNote = updates.adminNote.trim();
  if (typeof updates.assignedTo === 'string') item.assignedTo = updates.assignedTo.trim();
  item.updatedAt = new Date().toISOString();

  items[index] = item;
  writeDonationQueue(items);
  res.json({ ok: true, item });
});

app.delete('/api/donation-queue/:id', requireDash, (req, res) => {
  const id = String(req.params.id || '').trim();
  const items = readDonationQueue();
  const filtered = items.filter(item => item.id !== id);
  if (filtered.length === items.length) {
    return res.status(404).json({ error: 'Donation queue request not found' });
  }
  writeDonationQueue(filtered);
  res.json({ ok: true });
});

app.get('/api/admin/discounts', requireDash, (req, res) => {
  res.json(readDiscounts());
});

app.post('/api/admin/discounts', requireDash, (req, res) => {
  const discount = req.body || {};
  if (!discount.code || !discount.amount) {
    return res.status(400).json({ error: 'Discount code and amount are required' });
  }
  const discounts = readDiscounts();
  const normalized = {
    code: String(discount.code).trim(),
    amount: Number(discount.amount) || 0,
    type: discount.type === 'percent' ? 'percent' : 'fixed',
    serverId: String(discount.serverId || '').trim() || null,
    active: discount.active !== false
  };
  const index = discounts.findIndex(d => d.code === normalized.code);
  if (index >= 0) discounts[index] = { ...discounts[index], ...normalized };
  else discounts.unshift(normalized);
  writeDiscounts(discounts);
  res.json({ ok: true, discount: normalized });
});

app.delete('/api/admin/discounts/:code', requireDash, (req, res) => {
  const code = String(req.params.code || '').trim();
  const discounts = readDiscounts().filter(d => d.code !== code);
  writeDiscounts(discounts);
  res.json({ ok: true });
});

app.get('/api/admin/giftcards', requireDash, (req, res) => {
  res.json(readGiftCards());
});

app.post('/api/admin/giftcards', requireDash, (req, res) => {
  const card = req.body || {};
  if (!card.code || !card.amount) {
    return res.status(400).json({ error: 'Gift card code and amount are required' });
  }
  const cards = readGiftCards();
  const normalized = {
    code: String(card.code).trim(),
    amount: Number(card.amount) || 0,
    currency: String(card.currency || readShopConfig().currency || 'usd').trim(),
    active: card.active !== false,
    note: String(card.note || '').trim()
  };
  const index = cards.findIndex(c => c.code === normalized.code);
  if (index >= 0) cards[index] = { ...cards[index], ...normalized };
  else cards.unshift(normalized);
  writeGiftCards(cards);
  res.json({ ok: true, card: normalized });
});

app.delete('/api/admin/giftcards/:code', requireDash, (req, res) => {
  const code = String(req.params.code || '').trim();
  const cards = readGiftCards().filter(c => c.code !== code);
  writeGiftCards(cards);
  res.json({ ok: true });
});

// Public endpoint: check gift card balance by code
app.get('/api/giftcards/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Code required' });
  const card = readGiftCards().find(c => String(c.code || '').trim().toUpperCase() === code.toUpperCase() && c.active !== false);
  if (!card) return res.status(404).json({ error: 'Gift card not found' });
  res.json({ ok: true, amount: Number(card.amount) || 0, currency: card.currency || readShopConfig().currency || 'usd', note: card.note || '' });
});

app.post('/api/admin/leaderboard/wipe', requireDash, (req, res) => {
  const { type } = req.body || {};
  if (type === 'kills') {
    writeJson(KILLS_PATH, {});
  } else if (type === 'playtime') {
    writeJson(PLAYTIME_PATH, {});
  } else {
    return res.status(400).json({ error: 'Unknown leaderboard type' });
  }
  res.json({ ok: true });
});
// ── API: Leaderboards ─────────────────────────────────────────────────────
app.get('/api/leaderboard/kills', (req, res) => {
  res.json(readJson(KILLS_PATH, {}));
});

app.get('/api/leaderboard/playtime', (req, res) => {
  res.json(readJson(PLAYTIME_PATH, {}));
});

// ── API: Servers (dashboard) ──────────────────────────────────────────────
app.get('/api/servers', requireDash, (req, res) => {
  res.json(
    serversConfig.map(server => ({
      id: server.id,
      label: server.label,
      tag: server.tag,
      color: server.color
    }))
  );
});

app.get('/api/servers/:id/players', requireDash, (req, res) => {
  const state = serverState[req.params.id];
  if (!state) return res.status(404).json({ error: 'Unknown server' });
  res.json(state.players);
});

app.get('/api/servers/:id/bans', requireDash, (req, res) => {
  const state = serverState[req.params.id];
  if (!state) return res.status(404).json({ error: 'Unknown server' });
  res.json(state.bans);
});

app.get('/api/servers/:id/logs', requireDash, (req, res) => {
  const state = serverState[req.params.id];
  if (!state) return res.status(404).json({ error: 'Unknown server' });
  res.json(state.logs.filter(entry => !entry.polling));
});

app.post('/api/servers/:id/command', requireDash, async (req, res) => {
  const { id } = req.params;
  const { command } = req.body;

  if (!command) return res.status(400).json({ error: 'No command' });
  if (!serverState[id]) return res.status(404).json({ error: 'Unknown server' });

  try {
    const trimmed = String(command).trim();
    const result = await rce.sendCommand(id, trimmed);
    pushLog(id, 'info', `CMD: ${trimmed} → ${result ?? ''}`);
    res.json({ ok: true, result });
  } catch (error) {
    pushLog(id, 'error', `Command error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:id/ban', requireDash, async (req, res) => {
  const { id } = req.params;
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'No username' });
  if (!serverState[id]) return res.status(404).json({ error: 'Unknown server' });

  try {
    const result = await rce.sendCommand(id, `banid "${username}"`);
    pushLog(id, 'info', `BAN: ${username}`);
    setTimeout(() => pollBans(id), 1000);
    res.json({ ok: true, result });
  } catch (error) {
    pushLog(id, 'error', `Ban error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:id/unban', requireDash, async (req, res) => {
  const { id } = req.params;
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'No username' });
  if (!serverState[id]) return res.status(404).json({ error: 'Unknown server' });

  try {
    const result = await rce.sendCommand(id, `unban "${username}"`);
    pushLog(id, 'info', `UNBAN: ${username}`);
    setTimeout(() => pollBans(id), 1000);
    res.json({ ok: true, result });
  } catch (error) {
    pushLog(id, 'error', `Unban error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:id/kick', requireDash, async (req, res) => {
  const { id } = req.params;
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'No username' });
  if (!serverState[id]) return res.status(404).json({ error: 'Unknown server' });

  try {
    const result = await rce.sendCommand(id, `kick "${username}"`);
    pushLog(id, 'info', `KICK: ${username}`);
    setTimeout(() => pollPlayers(id), 1000);
    res.json({ ok: true, result });
  } catch (error) {
    pushLog(id, 'error', `Kick error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:id/vip', requireDash, async (req, res) => {
  const { id } = req.params;
  const { username, action } = req.body;

  if (!username) return res.status(400).json({ error: 'No username' });
  if (!serverState[id]) return res.status(404).json({ error: 'Unknown server' });

  const cmd = action === 'remove' ? `removevip "${username}"` : `vipid "${username}"`;

  try {
    const result = await rce.sendCommand(id, cmd);
    pushLog(id, 'info', `VIP ${action === 'remove' ? 'REMOVE' : 'GIVE'}: ${username}`);
    res.json({ ok: true, result });
  } catch (error) {
    pushLog(id, 'error', `VIP error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/servers/:id/info', (req, res) => {
  const state = serverState[req.params.id];
  if (!state) return res.status(404).json({ error: 'Unknown server' });

  const info = state.info || null;

  res.json({
    ok: true,
    info,
    players: Number(info?.Players || 0),
    queued: Number(info?.Queued || 0),
    maxPlayers: Number(info?.MaxPlayers || 100),
    hostname: cleanHostname(info?.Hostname)
  });
});
// ── API: Stored kits ──────────────────────────────────────────────────────
app.get('/api/storedkits', requireLogin, (req, res) => {
  res.json(readStoredKits());
});

app.post('/api/storedkits', requireDash, (req, res) => {
  const kits = Array.isArray(req.body) ? req.body : [];
  writeStoredKits(kits);
  res.json({ ok: true });
});

app.post('/api/storedkits/store', requireDash, (req, res) => {
  const entry = req.body;
  if (!entry?.name) return res.status(400).json({ error: 'Invalid kit' });

  const kits = readStoredKits();
  const index = kits.findIndex(k => k.name.toLowerCase() === entry.name.toLowerCase());

  if (index >= 0) kits[index] = entry;
  else kits.unshift(entry);

  writeStoredKits(kits);
  res.json({ ok: true });
});

// ── API: Checkout ─────────────────────────────────────────────────────────
app.post('/api/checkout', requireLogin, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const discountCode = String(req.body.discountCode || '').trim();
    const discount = discountCode ? getDiscountByCode(discountCode) : null;

    if (!items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const resolvedItems = items.map(item => {
      const product = findProduct(item?.id);
      const productCurrency = product?.currency || readShopConfig().currency || 'usd';
      return {
        ...item,
        id: String(item?.id || '').trim(),
        title: item?.title || product?.title || 'Unknown',
        priceId: product?.stripePriceId || STRIPE_PRICES[item?.id] || '',
        mode: product?.mode || 'payment',
        stripeCurrency: productCurrency,
        price: Number(product?.price || item.price || 0),
        description: String(product?.description || '').trim(),
        interval: String(product?.interval || 'month').trim()
      };
    });

    const productModes = new Set(resolvedItems.map(item => item.mode));
    if (productModes.size > 1) {
      return res.status(400).json({ error: 'Cannot mix payment and subscription products in a single checkout' });
    }

    const seenInCart = new Set();
    const line_items = [];
    let paymentMode = 'payment';

    for (const item of resolvedItems) {
      const cartKey = `${item.id}:${String(item.server || '').trim()}`;

      if (seenInCart.has(cartKey)) {
        return res.status(400).json({ error: `Duplicate product in cart: ${item.title || item.id}` });
      }
      seenInCart.add(cartKey);

      if (userOwnsProduct(req.session.user.id, item.id, item.server || '')) {
        return res.status(400).json({ error: `You already own ${item.title || item.id} on this server` });
      }

      if (item.priceId) {
        line_items.push({ price: item.priceId, quantity: 1 });
      } else {
        if (!item.price || item.price <= 0) {
          throw new Error(`Missing price for item: ${item.id}`);
        }
        const priceData = {
          currency: item.stripeCurrency || 'usd',
          product_data: {
            name: item.title,
            description: item.description || undefined
          },
          unit_amount: Math.max(1, Math.round(item.price * 100))
        };
        if (item.mode === 'subscription') {
          priceData.recurring = { interval: item.interval || 'month' };
          paymentMode = 'subscription';
        }
        line_items.push({ price_data: priceData, quantity: 1 });
      }
    }

    const totalAmount = resolvedItems.reduce((sum, item) => sum + (Number(findProduct(item.id)?.price || item.price || 0)), 0);
    const discountAmount = calculateDiscountAmount(discount, totalAmount);

    if (discountAmount > 0) {
      line_items.push({
        price_data: {
          currency: readShopConfig().currency || 'usd',
          product_data: {
            name: 'Discount',
            description: discount ? `${discount.code}: -${discount.amount}${discount.type === 'percent' ? '%' : ''}` : undefined
          },
          unit_amount: Math.max(1, -Math.round(discountAmount * 100))
        },
        quantity: 1
      });
    }

    const isAdminBypass = isAdminBypassUser(req.session.user?.id);
    const orderId = `SPIRALS-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
    const pending = {
      orderId,
      discordId: req.session.user?.id || null,
      discordUsername: req.session.user?.globalName || req.session.user?.username || 'Unknown',
      items: resolvedItems.map(item => ({
        id: item.id || null,
        title: item.title || 'Unknown',
        type: item.type || '',
        price: Number(item.price) || 0,
        server: item.server || '',
        mode: item.mode || 'payment',
        stripePriceId: item.priceId
      })),
      createdAt: new Date().toISOString(),
      bypassed: isAdminBypass
    };

    if (isAdminBypass) {
      try {
        await processCompletedPurchase(pending);
      } catch (error) {
        console.error('Admin bypass purchase failed:', error.response?.data || error.message || error);
        return res.status(500).json({ error: 'Admin bypass purchase failed' });
      }

      return res.json({
        success: true,
        bypass: true,
        orderId,
        items: pending.items
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: paymentMode,
      line_items,
      success_url: `${APP_BASE_URL}/cart?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/cart`,
      client_reference_id: req.session.user?.id || undefined,
      metadata: {
        discordId: req.session.user?.id || '',
        discordUsername: req.session.user?.globalName || req.session.user?.username || '',
        itemIds: resolvedItems.map(item => item.id).join(','),
        discountCode: discountCode || ''
      }
    });

    savePendingCheckout(checkoutSession.id, {
      orderId: `SPIRALS-${Math.random().toString(36).toUpperCase().slice(2, 8)}`,
      discordId: req.session.user?.id || null,
      discordUsername: req.session.user?.globalName || req.session.user?.username || 'Unknown',
      items: resolvedItems.map(item => ({
        id: item.id || null,
        title: item.title || 'Unknown',
        type: item.type || '',
        price: Number(item.price) || 0,
        server: item.server || '',
        mode: item.mode || 'payment',
        stripePriceId: item.priceId
      })),
      createdAt: new Date().toISOString()
    });

    res.json({ url: checkoutSession.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(400).json({ error: error.message || 'Checkout failed' });
  }
});

// ── Pages ─────────────────────────────────────────────────────────────────
app.get('/dashboard', requireDash, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin/shop', requireDash, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-shop.html'));
});

app.get('/servers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'servers.html'));
});

app.get('/inventory', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inventory.html'));
});

app.get('/leaderboards', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboards.html'));
});

app.get('/store', (req, res) => {
  if (!isLoggedIn(req)) {
    return res.redirect('/auth/discord?returnTo=/store');
  }

  res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get('/cart', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cart.html'));
});

app.get('/jewels', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'jewels.html'));
});

app.get('/data/links.json', (req, res) => {
  res.sendFile(LINKS_PATH);
});

// ── Webhook ───────────────────────────────────────────────────────────────
async function sendLoginWebhook(user) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [
        {
          title: '👤 User Login',
          description: `**${user.globalName}** logged into spiralsrust.com`,
          color: 0xff0000,
          timestamp: new Date().toISOString(),
          thumbnail: { url: user.avatar },
          footer: {
            text: user.username,
            icon_url: user.avatar
          }
        }
      ]
    });
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', serverId => {
    for (const server of serversConfig) {
      socket.leave(`server:${server.id}`);
    }

    if (serverState[serverId]) {
      socket.join(`server:${serverId}`);
      socket.emit('players', serverState[serverId].players);
socket.emit('bans', serverState[serverId].bans);
socket.emit('serverinfo', serverState[serverId].info);
socket.emit('logs', serverState[serverId].logs.filter(entry => !entry.polling));
    }
  });
});

// ── Fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.method !== 'GET') {
    return res.status(404).json({ error: 'Not found' });
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────
httpServer.listen(serverPort, async () => {
  console.log(`🚀 Spirals RCE running at ${APP_BASE_URL}`);
  await initRCE();

  cleanupExpiredPurchases();
  setInterval(cleanupExpiredPurchases, 60 * 1000);

  awardJewelsFromPlaytime();
  setInterval(awardJewelsFromPlaytime, JEWEL_AWARD_INTERVAL_MS);
});
