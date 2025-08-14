/**
 * Facebook Messenger Bot - Ultra Stable (Auto + Commands)
 * - Auto-lock from groups.json (no command needed)
 * - Self-first nickname change, then others
 * - Random delay 6–7s; gclock revert after 47s
 * - Cooldown (60 events -> 3 min)
 * - Anti-sleep typing, appstate backup
 * - Global concurrency limiter (default 3)
 * - Puppeteer fallback (optional)
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

// ---------- Console colors ----------
const C = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m" };
const log=(...a)=>console.log(C.cyan+"[BOT]"+C.reset,...a);
const info=(...a)=>console.log(C.green+"[INFO]"+C.reset,...a);
const warn=(...a)=>console.log(C.yellow+"[WARN]"+C.reset,...a);
const error=(...a)=>console.log(C.red+"[ERR]"+C.reset,...a);

// ---------- Keepalive server ----------
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_, res) => res.send("✅ Facebook Bot online"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// ---------- Paths / Config ----------
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json"); // persistent runtime state
const groupFile = path.join(DATA_DIR, "groups.json");   // input list

// Timing & Limits (defaults per your ask)
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47000; // 47s
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000; // 6s
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000; // 7s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 3 * 60 * 1000; // 3 min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5 * 60 * 1000; // 5 min
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;

// Puppeteer (optional)
const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// Defaults (safe)
const DEFAULT_LOCK_NICK = process.env.LOCK_NICK || "LOCKED 🔒";

// ---------- State ----------
let api = null;
let groupLocks = {};                // per-thread config/state (persisted)
let groupQueues = {};               // per-thread task queues (in-mem)
let groupNameChangeDetected = {};   // first-seen timestamps for name change
let groupNameRevertInProgress = {}; // flags
let shuttingDown = false;

// Puppeteer handles
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;

// Global concurrency to avoid flood / blocks
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];

// ---------- Utils ----------
const sleep = ms => new Promise(res => setTimeout(res, ms));
const randomDelay = () =>
  Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
const timestamp = () => new Date().toTimeString().split(" ")[0];

async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) { globalActiveCount++; return; }
  await new Promise(res => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) globalPending.shift()();
}

// ---------- Safe file ops ----------
async function ensureFileJSON(file, fallbackJSON) {
  try {
    await fsp.access(file);
  } catch {
    await fsp.writeFile(file, JSON.stringify(fallbackJSON, null, 2));
  }
}
async function loadJSON(file, fallback = {}) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt || (typeof fallback === "string" ? fallback : JSON.stringify(fallback)));
  } catch (e) {
    warn(`Failed to read ${path.basename(file)}:`, e.message || e);
    return fallback;
  }
}
async function writeJSONAtomic(file, obj) {
  try {
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, file);
  } catch (e) {
    warn(`Failed to write ${path.basename(file)}:`, e.message || e);
  }
}
async function loadAppState() {
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    return JSON.parse(txt);
  } catch {
    throw new Error("Cannot load appstate.json");
  }
}

// ---------- Queue per-thread ----------
function ensureQueue(threadID) {
  if (!groupQueues[threadID]) groupQueues[threadID] = { running: false, tasks: [] };
  return groupQueues[threadID];
}
function queueTask(threadID, fn) {
  const q = ensureQueue(threadID);
  q.tasks.push(fn);
  if (!q.running) runQueue(threadID);
}
async function runQueue(threadID) {
  const q = ensureQueue(threadID);
  if (q.running) return;
  q.running = true;
  while (q.tasks.length) {
    const fn = q.tasks.shift();
    try {
      await acquireGlobalSlot();
      try { await fn(); }
      finally { releaseGlobalSlot(); }
    } catch (e) {
      warn(`[${timestamp()}] Queue task error for ${threadID}:`, e.message || e);
    }
    await sleep(250); // micro-gap to smooth burst
  }
  q.running = false;
}

// ---------- Puppeteer (optional) ----------
async function startPuppeteerIfEnabled() {
  if (!ENABLE_PUPPETEER) { info("Puppeteer disabled."); return; }
  try {
    const puppeteer = require("puppeteer");
    const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] };
    if (CHROME_EXECUTABLE) launchOpts.executablePath = CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com", { waitUntil: "networkidle2", timeout: 30000 }).catch(()=>{});
    puppeteerAvailable = true;
    info("Puppeteer ready.");
  } catch (e) {
    puppeteerAvailable = false;
    warn("Puppeteer init failed:", e.message || e);
  }
}
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle === "function") {
    return new Promise((r, rej) => apiObj.setTitle(title, threadID, err => err ? rej(err) : r()));
  }
  if (typeof apiObj.changeThreadTitle === "function") {
    return new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, err => err ? rej(err) : r()));
  }
  if (ENABLE_PUPPETEER && puppeteerAvailable) {
    const url = `https://www.facebook.com/messages/t/${threadID}`;
    await puppeteerPage.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(()=>{});
    await puppeteerPage.waitForTimeout(1200);
    info(`[${timestamp()}] [PUPP] Fallback attempted for title change (best effort).`);
    return;
  }
  throw new Error("No method to change thread title");
}

// ---------- INIT NICK CHECK (periodic re-apply safeguard) ----------
async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (const t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      let infoObj;
      try {
        infoObj = await new Promise((res, rej)=>apiObj.getThreadInfo(t,(e,r)=>e?rej(e):res(r)));
      } catch { continue; }

      const participants = infoObj?.participantIDs || (infoObj?.userInfo?.map(u=>u.id)) || [];
      for (const uid of participants) {
        const desired = group.original?.[uid] || group.nick;
        if (!desired) continue;
        const current = (infoObj.nicknames && infoObj.nicknames[uid])
                      || (infoObj.userInfo && infoObj.userInfo.find(u=>u.id===uid)?.nickname)
                      || null;
        if (current !== desired) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, err => err?rej(err):res()));
              info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);
              await sleep(randomDelay());
            } catch (e) {
              warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e);
            }
          });
        }
      }
    }
  } catch (e) {
    warn("initCheckLoop error:", e.message || e);
  }
}

// ---------- Load groups.json ----------
async function loadGroupUIDs() {
  await ensureFileJSON(groupFile, []); // create if missing
  const data = await loadJSON(groupFile, []);
  if (Array.isArray(data)) {
    // simple: ["123","456"]
    return data.map(x => ({ id: String(x).trim(), nick: DEFAULT_LOCK_NICK, groupName: null }));
  }
  if (data && typeof data === "object" && Array.isArray(data.groups)) {
    // advanced: { groups: [{id, nick?, groupName?}, ...] }
    return data.groups.map(g => ({
      id: String(g.id).trim(),
      nick: (g.nick || DEFAULT_LOCK_NICK),
      groupName: g.groupName || null
    }));
  }
  warn("groups.json invalid format. Use array of ids or {groups:[{id,nick,groupName}]}");
  return [];
}

// =================== LOGIN LOOP ===================
let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try { loginLib({ appState }, (err, a) => err ? rej(err) : res(a)); }
        catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as ${(api.getCurrentUserID && api.getCurrentUserID()) || "unknown"}`);

      await ensureFileJSON(dataFile, {});
      groupLocks = await loadJSON(dataFile, {});
      startPuppeteerIfEnabled().catch(e => warn("Puppeteer init err:", e.message || e));

      // --------- AUTO-LOCK from groups.json (no command needed) ---------
      const groups = await loadGroupUIDs();
      for (const g of groups) {
        const threadID = g.id;
        const lockNick = g.nick || DEFAULT_LOCK_NICK;

        queueTask(threadID, async () => {
          try {
            const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => err ? rej(err) : res(r)));
            const currentName = infoThread.threadName || "Group";
            const selfID = api.getCurrentUserID ? api.getCurrentUserID() : "";

            // init structure
            groupLocks[threadID] = groupLocks[threadID] || {};
            const GL = groupLocks[threadID];
            GL.enabled = true;
            GL.nick = lockNick;
            GL.original = GL.original || {};
            GL.count = 0;
            GL.cooldown = false;
            GL.gclock = true;
            GL.groupName = g.groupName || GL.groupName || currentName;

            // self first
            if (selfID) {
              GL.original[selfID] = lockNick;
              try {
                await new Promise((res, rej) => api.changeNickname(lockNick, threadID, selfID, err => err ? rej(err) : res()));
                info(`[${timestamp()}] Self nick locked in ${threadID}`);
              } catch (e) {
                warn(`[${timestamp()}] Self nick change failed in ${threadID}:`, e.message || e);
              }
            }

            // then others
            for (const user of (infoThread.userInfo || [])) {
              if (user.id === selfID) continue;
              GL.original[user.id] = lockNick;
              try {
                await new Promise((res, rej) => api.changeNickname(lockNick, threadID, user.id, err => err ? rej(err) : res()));
                info(`[${timestamp()}] Nick set for ${user.id} in ${threadID}`);
              } catch (e) {
                warn(`[${timestamp()}] changeNickname failed for ${user.id} in ${threadID}:`, e.message || e);
              }
              await sleep(randomDelay());
            }

            // ensure group name lock equals desired
            try {
              if (infoThread.threadName !== GL.groupName) {
                await changeThreadTitle(api, threadID, GL.groupName);
                info(`[${timestamp()}] [GCLOCK] Applied name "${GL.groupName}" in ${threadID}`);
              }
            } catch (e) {
              warn(`[${timestamp()}] [GCLOCK] set title failed in ${threadID}:`, e.message || e);
            }

            await writeJSONAtomic(dataFile, groupLocks);
            info(`[${timestamp()}] Auto-lock complete for ${threadID}`);
          } catch (e) {
            warn(`Auto-lock failed for ${threadID}:`, e.message || e);
          }
        });
      }

      // --------- Group-name watcher (revert after 47s) ---------
      setInterval(async () => {
        for (const threadID of Object.keys(groupLocks)) {
          const GL = groupLocks[threadID];
          if (!GL || !GL.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;

          try {
            const infoObj = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => err ? rej(err) : res(r)));
            if (infoObj && infoObj.threadName !== GL.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${infoObj.threadName}" (waiting 47s)`);
              } else {
                const elapsed = Date.now() - groupNameChangeDetected[threadID];
                if (elapsed >= GROUP_NAME_REVERT_DELAY) {
                  groupNameRevertInProgress[threadID] = true;
                  try {
                    await changeThreadTitle(api, threadID, GL.groupName);
                    info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${GL.groupName}"`);
                  } catch (e) {
                    warn(`[${timestamp()}] [GCLOCK] Revert failed ${threadID}:`, e.message || e);
                  } finally {
                    groupNameChangeDetected[threadID] = null;
                    groupNameRevertInProgress[threadID] = false;
                  }
                }
              }
            } else {
              groupNameChangeDetected[threadID] = null;
            }
          } catch (e) {
            warn(`[${timestamp()}] [GCLOCK] Error checking ${threadID}:`, e.message || e);
          }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // --------- Anti-sleep typing ---------
      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const GL = groupLocks[id];
            if (!GL || (!GL.gclock && !GL.enabled)) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, err => err ? rej(err) : res()));
            await sleep(1200);
          } catch (e) {
            warn(`[${timestamp()}] Typing indicator failed for ${id}:`, e.message || e);
            const msg = (e.message || "").toLowerCase();
            if (msg.includes("client disconnecting") || msg.includes("not logged in")) {
              warn("Detected client disconnect - attempting reconnect...");
              try { api.removeAllListeners && api.removeAllListeners(); } catch {}
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      // --------- Appstate backup ---------
      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s) await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
          info(`[${timestamp()}] Appstate backed up.`);
        } catch (e) { warn("Appstate backup error:", e.message || e); }
      }, APPSTATE_BACKUP_INTERVAL);

      // --------- Initial periodic nick re-applier ---------
      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api).catch(e => warn("initCheck error:", e.message || e)), 5 * 60 * 1000);

      // --------- Listener ---------
      api.listenMqtt(async (err, event) => {
        if (err) { warn("listenMqtt error:", err.message || err); return; }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();

          // Quick thread-name change signal (poller will revert after 47s)
          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const GL = groupLocks[threadID];
            if (GL?.gclock && event.logMessageData?.name !== GL.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Name changed in ${threadID} -> schedule revert in 47s`);
              }
            }
          }

          // Nickname change events -> revert
          if (event.logMessageType === "log:user-nickname") {
            const GL = groupLocks[threadID];
            if (!GL || !GL.enabled || GL.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (GL.original && GL.original[uid]) || GL.nick;

            if (lockedNick && currentNick !== lockedNick) {
              queueTask(threadID, async () => {
                try {
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, err => err ? rej(err) : res()));
                  GL.count = (GL.count || 0) + 1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if (GL.count >= NICKNAME_CHANGE_LIMIT) {
                    GL.cooldown = true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooling down ${Math.floor(NICKNAME_COOLDOWN/1000)}s`);
                    setTimeout(() => { GL.cooldown = false; GL.count = 0; info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`); }, NICKNAME_COOLDOWN);
                  } else {
                    await sleep(randomDelay());
                  }
                  await writeJSONAtomic(dataFile, groupLocks);
                } catch (e) {
                  warn(`[${timestamp()}] Nick revert failed for ${uid} in ${threadID}:`, e.message || e);
                }
              });
            }
          }

          // ------------ Boss commands ------------
          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = body.toLowerCase();

            if (lc === "/nicklock on") {
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => err ? rej(err) : res(r)));
                const selfID = api.getCurrentUserID ? api.getCurrentUserID() : "";
                groupLocks[threadID] = groupLocks[threadID] || {};
                const GL = groupLocks[threadID];
                GL.enabled = true;
                GL.nick = GL.nick || DEFAULT_LOCK_NICK;
                GL.original = GL.original || {};
                GL.count = 0;
                GL.cooldown = false;

                if (selfID) {
                  GL.original[selfID] = GL.nick;
                  queueTask(threadID, async () => {
                    try { await new Promise((res, rej) => api.changeNickname(GL.nick, threadID, selfID, err => err ? rej(err) : res())); info(`[${timestamp()}] Changed bot's own nick in ${threadID}`); }
                    catch (e) { warn("Self nick change failed:", e.message || e); }
                  });
                }
                for (const u of (infoThread.userInfo || [])) {
                  if (u.id === selfID) continue;
                  GL.original[u.id] = GL.nick;
                  queueTask(threadID, async () => {
                    try { await new Promise((res, rej) => api.changeNickname(GL.nick, threadID, u.id, err => err ? rej(err) : res())); info(`[${timestamp()}] Changed nick for ${u.id} in ${threadID}`); }
                    catch (e) { warn(`[${timestamp()}] changeNickname failed for ${u.id}:`, e.message || e); }
                    await sleep(randomDelay());
                  });
                }
                await writeJSONAtomic(dataFile, groupLocks);
                info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
              } catch (e) { warn(`[${timestamp()}] Nicklock activation failed:`, e.message || e); }
            }

            if (lc === "/nicklock off") {
              if (groupLocks[threadID]) { groupLocks[threadID].enabled = false; await writeJSONAtomic(dataFile, groupLocks); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); }
            }

            if (lc === "/nickall") {
              const GL = groupLocks[threadID];
              if (!GL?.enabled) return;
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => err ? rej(err) : res(r)));
                const selfID = api.getCurrentUserID ? api.getCurrentUserID() : "";
                if (selfID) {
                  GL.original[selfID] = GL.nick;
                  queueTask(threadID, async () => {
                    try { await new Promise((res, rej) => api.changeNickname(GL.nick, threadID, selfID, err => err ? rej(err) : res())); info(`[${timestamp()}] Reapplied self nick in ${threadID}`); }
                    catch (e) { warn("Self nick apply failed:", e.message || e); }
                  });
                }
                for (const u of (infoThread.userInfo || [])) {
                  if (u.id === selfID) continue;
                  GL.original[u.id] = GL.nick;
                  queueTask(threadID, async () => {
                    try { await new Promise((res, rej) => api.changeNickname(GL.nick, threadID, u.id, err => err ? rej(err) : res())); info(`[${timestamp()}] Reapplied nick for ${u.id}`); }
                    catch (e) { warn(`[${timestamp()}] Nick apply failed:`, e.message || e); }
                    await sleep(randomDelay());
                  });
                }
                await writeJSONAtomic(dataFile, groupLocks);
                info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
              } catch (e) { warn(`[${timestamp()}] /nickall failed:`, e.message || e); }
            }

            if (lc.startsWith("/gclock ")) {
              const customName = body.slice(8).trim();
              if (!customName) return;
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].groupName = customName;
              groupLocks[threadID].gclock = true;
              try { await changeThreadTitle(api, threadID, customName); await writeJSONAtomic(dataFile, groupLocks); info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`); }
              catch (e) { warn("Could not set group name:", e.message || e); }
            }

            if (lc === "/gclock") {
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => err ? rej(err) : res(r)));
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = infoThread.threadName;
                groupLocks[threadID].gclock = true;
                await writeJSONAtomic(dataFile, groupLocks);
                info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
              } catch (e) { warn("/gclock failed:", e.message || e); }
            }

            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) { delete groupLocks[threadID].gclock; await writeJSONAtomic(dataFile, groupLocks); info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`); }
            }

            if (lc === "/startlock") {
              if (groupLocks[threadID]) { groupLocks[threadID].enabled = true; await writeJSONAtomic(dataFile, groupLocks); info(`[${timestamp()}] Auto-lock enabled for ${threadID}`); }
            }
            if (lc === "/stoplock") {
              if (groupLocks[threadID]) { groupLocks[threadID].enabled = false; await writeJSONAtomic(dataFile, groupLocks); info(`[${timestamp()}] Auto-lock disabled for ${threadID}`); }
            }
          }
        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          warn("Event handler error:", e.message || e);
        }
      });

      // success -> reset attempts, keep running
      loginAttempts = 0;
      break;
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  }
}

// ---------- Start ----------
loginAndRun().catch((e) => { error("Fatal start error:", e.message || e); process.exit(1); });

// ---------- Global handlers ----------
process.on("uncaughtException", (err) => {
  error("uncaughtException:", err && err.stack ? err.stack : err);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch {}
  setTimeout(() => loginAndRun().catch(e => error("relogin after exception failed:", e.message || e)), 5000);
});
process.on("unhandledRejection", (reason) => {
  warn("unhandledRejection:", reason);
  setTimeout(() => loginAndRun().catch(e => error("relogin after rejection failed:", e.message || e)), 5000);
});

// ---------- Graceful shutdown ----------
async function gracefulExit() {
  shuttingDown = true;
  info("Graceful shutdown: saving state...");
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch {}
  try { await writeJSONAtomic(dataFile, groupLocks); } catch {}
  try { if (puppeteerBrowser) await puppeteerBrowser.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
