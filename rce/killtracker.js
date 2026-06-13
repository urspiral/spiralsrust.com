// rce/killtracker.js
// Tracks player kills from RCEEvent.PlayerKill.
// Anti-team:   ignores kills between same-team members (findplayerteam).
// Anti-farm:   killer kills same victim >10x in 30 min → 2h pair block.
// Blacklist:   data/killbans.json  — permanent per-server name list.
// Pair bans:   data/killpairbans.json — auto farm blocks (persisted).
// Stats:       data/kills.json — per-server kills + deaths per player.

const fs   = require("fs");
const path = require("path");
const { RCEEvent } = require("rce.js");

const DATA       = path.join(__dirname, "..", "data");
const KILLS_PATH     = path.join(DATA, "kills.json");
const KILLBANS_PATH  = path.join(DATA, "killbans.json");
const PAIRBANS_PATH  = path.join(DATA, "killpairbans.json");

const WINDOW_MS = 30 * 60 * 1000;
const THRESHOLD = 10;
const BAN_MS    = 2  * 60 * 60 * 1000;

const teamCache      = new Map();
const recentPairKills = new Map();
const blacklistCache = new Map();

// ── Write queue ──────────────────────────────────────────────────────────
let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch(e => console.error("[killtracker] write error:", e));
  return writeChain;
}

// ── JSON helpers ─────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) { if (!cur[k]) cur[k] = {}; cur = cur[k]; }
  return cur;
}
const safeName  = s => String(s ?? "").trim();
const keyLower  = s => safeName(s).toLowerCase();

// ── Blacklist ────────────────────────────────────────────────────────────
function getBlacklist(serverId) {
  const cached = blacklistCache.get(serverId);
  if (cached && Date.now() - cached.ts < 10_000) return cached.set;
  const bans = readJson(KILLBANS_PATH, {});
  const list = bans[serverId] || bans.default || [];
  const set  = new Set(list.map(n => String(n).trim().toLowerCase()).filter(Boolean));
  blacklistCache.set(serverId, { ts: Date.now(), set });
  return set;
}

// ── Pair bans ────────────────────────────────────────────────────────────
function cleanupPairBans(pb) {
  const now = Date.now();
  for (const sid of Object.keys(pb || {})) {
    const pairs = pb[sid] || {};
    for (const k of Object.keys(pairs)) {
      if (!pairs[k] || Number(pairs[k].banUntil || 0) <= now) delete pairs[k];
    }
    if (!Object.keys(pairs).length) delete pb[sid];
    else pb[sid] = pairs;
  }
}
function isPairBlocked(pb, sid, key) {
  const b = pb?.[sid]?.[key];
  return !!(b && Number(b.banUntil || 0) > Date.now());
}
function setPairBlock(pb, sid, key, killer, victim, hits) {
  const s = ensure(pb, sid);
  s[key] = { killer, victim, hitsInWindow: hits, createdAt: Date.now(), banUntil: Date.now() + BAN_MS, reason: "kill-farm" };
}

// ── Team check ───────────────────────────────────────────────────────────
function parseFindPlayerTeam(out) {
  const text = String(out ?? "").replace(/\\n/g, "\n");
  if (!text.match(/Team\s+\d+\s+member list:/i)) return null;
  const members = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?)\s+\[\d+\]/);
    if (m?.[1]) members.add(m[1].trim().toLowerCase());
  }
  return members;
}
async function getTeamMembers(rce, serverId, playerName) {
  const pn = safeName(playerName);
  if (!pn) return null;
  const cacheKey = `${serverId}::${keyLower(pn)}`;
  const cached = teamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10_000) return cached.members;
  if (!rce || typeof rce.sendCommand !== "function") return null;
  const resp = await rce.sendCommand(serverId, `findplayerteam "${pn}"`).catch(() => null);
  const members = parseFindPlayerTeam(resp);
  teamCache.set(cacheKey, { ts: Date.now(), members });
  return members;
}

// ── Record kill/death ────────────────────────────────────────────────────
function recordKillDeath(killsAll, sid, killerName, victimName) {
  const s = ensure(killsAll, sid);
  if (!s.players)    s.players    = {};
  if (!s.totalKills) s.totalKills = 0;
  if (!s.totalDeaths)s.totalDeaths= 0;
  if (!s.recent)     s.recent     = [];

  const kk = keyLower(killerName);
  const vk = keyLower(victimName);

  if (!s.players[kk]) s.players[kk] = { name: killerName, kills: 0, deaths: 0, lastKillAt: 0, lastDeathAt: 0 };
  if (!s.players[vk]) s.players[vk] = { name: victimName, kills: 0, deaths: 0, lastKillAt: 0, lastDeathAt: 0 };

  s.players[kk].kills      += 1;
  s.players[kk].lastKillAt  = Date.now();
  s.totalKills              += 1;

  s.players[vk].deaths     += 1;
  s.players[vk].lastDeathAt = Date.now();
  s.totalDeaths             += 1;

  s.recent.push({ t: Date.now(), killer: killerName, victim: victimName });
  if (s.recent.length > 500) s.recent.splice(0, s.recent.length - 500);
}

// ── Module ───────────────────────────────────────────────────────────────
module.exports = {
  name: "killtracker",

  init(client, rce) {
    console.log("[killtracker] init");
    if (!rce?.on) { console.error("[killtracker] rce manager missing"); return; }

    // Ensure data files exist
    readJson(KILLS_PATH,    {});
    readJson(KILLBANS_PATH, { default: [] });
    readJson(PAIRBANS_PATH, {});

    // Clean expired pair bans on startup
    queueWrite(async () => {
      const pb = readJson(PAIRBANS_PATH, {});
      cleanupPairBans(pb);
      writeJson(PAIRBANS_PATH, pb);
    });

    rce.on(RCEEvent.PlayerKill, async (payload) => {
      try {
        const sid        = safeName(payload?.server?.identifier || "unknown");
        const killer     = payload?.killer;
        const victim     = payload?.victim;
        const killerName = safeName(killer?.name);
        const victimName = safeName(victim?.name);
        const victimId   = safeName(victim?.id);

        // Always log
        console.log(`:LOG: ${victimId || victimName || "UNKNOWN"} was killed by ${killerName || "UNKNOWN"}`);

        const isPlayer = p => String(p?.type || "").toLowerCase() === "player" || !!p?.player;
        if (!isPlayer(killer) || !isPlayer(victim)) return;
        if (!killerName || !victimName) return;
        if (keyLower(killerName) === keyLower(victimName)) return;

        // Blacklist
        const bl = getBlacklist(sid);
        if (bl.has(keyLower(killerName)) || bl.has(keyLower(victimName))) {
          console.log(`[killtracker] ignored (blacklist): ${killerName} -> ${victimName}`);
          return;
        }

        // Same-team check
        const members = await getTeamMembers(rce, sid, killerName);
        if (members?.has(keyLower(victimName))) {
          console.log(`[killtracker] ignored (same team): ${killerName} -> ${victimName}`);
          return;
        }

        const pairKey = `${keyLower(killerName)}|${keyLower(victimName)}`;

        // Persisted pair ban check
        const pb = readJson(PAIRBANS_PATH, {});
        if (isPairBlocked(pb, sid, pairKey)) {
          console.log(`[killtracker] ignored (pair blocked): ${killerName} -> ${victimName}`);
          return;
        }

        // Rolling window
        const rkKey = `${sid}::${pairKey}`;
        const now   = Date.now();
        const arr   = (recentPairKills.get(rkKey) || []).filter(t => now - t <= WINDOW_MS);
        arr.push(now);
        recentPairKills.set(rkKey, arr);

        if (arr.length > THRESHOLD) {
          await queueWrite(async () => {
            const pb2 = readJson(PAIRBANS_PATH, {});
            cleanupPairBans(pb2);
            setPairBlock(pb2, sid, pairKey, killerName, victimName, arr.length);
            writeJson(PAIRBANS_PATH, pb2);
          });
          console.log(`[killtracker] farm block (2h): ${killerName} -> ${victimName}`);
          return;
        }

        // Record
        await queueWrite(async () => {
          const kills = readJson(KILLS_PATH, {});
          recordKillDeath(kills, sid, killerName, victimName);
          writeJson(KILLS_PATH, kills);
        });

        console.log(`[killtracker] counted: ${killerName} killed ${victimName} (${sid})`);
      } catch (e) {
        console.error("[killtracker] error:", e?.message || e);
      }
    });
  },
};
