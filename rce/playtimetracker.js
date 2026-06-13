const fs = require("fs");
const path = require("path");

const PLAYTIME_PATH = path.join(__dirname, "..", "data", "playtime.json");

let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch(e => console.error("[playtimetracker] write error:", e));
  return writeChain;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[playtimetracker] write failed:", e?.message || e); }
}

const safeName = s => String(s ?? "").trim();
const keyLower = s => safeName(s).toLowerCase();

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function parseUsers(resp) {
  const text = String(resp ?? "").replace(/\\n/g, "\n");
  const names = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const v = safeName(m[1]);
    if (!v || v.toLowerCase() === "name") continue;
    names.push(v);
  }
  const seen = new Set();
  return names.filter(n => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = {
  name: "playtimetracker",

  init(client, rce, serversConfig = []) {
    console.log("[playtimetracker] init");
    readJson(PLAYTIME_PATH, {});

    const running = new Map();

    setInterval(async () => {
      for (const s of serversConfig) {
        const sid = s.id;
        if (!sid || running.get(sid)) continue;

        running.set(sid, true);
        try {
          const resp = await rce.sendCommand(sid, "users").catch(() => null);
          if (!resp) continue;

          const online = parseUsers(resp);
          if (!online.length) continue;

          const now = Date.now();

          await queueWrite(async () => {
            const data = readJson(PLAYTIME_PATH, {});
            const srv = ensure(data, sid);
            if (!srv.players) srv.players = {};

            for (const name of online) {
              const k = keyLower(name);
              if (!srv.players[k]) srv.players[k] = { name, seconds: 0, lastSeenAt: 0 };
              srv.players[k].name = name;
              srv.players[k].seconds = Number(srv.players[k].seconds || 0) + 1;
              srv.players[k].lastSeenAt = now;
            }

            srv.updatedAt = now;
            writeJson(PLAYTIME_PATH, data);
          });
        } catch (e) {
          console.error("[playtimetracker] tick error:", sid, e?.message || e);
        } finally {
          running.set(sid, false);
        }
      }
    }, 1000);
  },
};