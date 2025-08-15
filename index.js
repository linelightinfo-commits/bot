/**
 * Patched index.js
 * - Adds null-safety around getThreadInfo results (fixes Cannot read properties of null 'userInfo')
 * - Guards membership/nicklock flows if userInfo is missing
 * - Monkey-patches api.setPostReaction to quietly skip "Content Not Available" errors (code 1446034)
 * - Small hardening around event handling and queues
 * - Keeps your original behavior & timings (6–7s nickname delay, 47s gclock revert)
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
function log(...a) { console.log(C.cyan + "[BOT]" + C.reset, ...a); }
function info(...a) { console.log(C.green + "[INFO]" + C.reset, ...a); }
function warn(...a) { console.log(C.yellow + "[WARN]" + C.reset, ...a); }
function error(...a) { console.log(C.red + "[ERR]" + C.reset, ...a); }

// Express for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// Config (overrides via .env)
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// timing rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15 * 1000;
const GROUP_NAME_REVERT_DELAY   = parseInt(process.env.GROUP_NAME_REVERT_DELAY)   || 47 * 1000; // 47s
const NICKNAME_DELAY_MIN        = parseInt(process.env.NICKNAME_DELAY_MIN)        || 6000;      // 6s
const NICKNAME_DELAY_MAX        = parseInt(process.env.NICKNAME_DELAY_MAX)        || 7000;      // 7s
const NICKNAME_CHANGE_LIMIT     = parseInt(process.env.NICKNAME_CHANGE_LIMIT)     || 60;
const NICKNAME_COOLDOWN         = parseInt(process.env.NICKNAME_COOLDOWN)         || 3 * 60 * 1000; // 3min
const TYPING_INTERVAL           = parseInt(process.env.TYPING_INTERVAL)           || 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL  = parseInt(process.env.APPSTATE_BACKUP_INTERVAL)  || 10 * 60 * 1000;

const ENABLE_PUPPETEER  = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// State
let api = null;
let groupLocks = {};                // persisted config loaded from groupData.json
let groupQueues = {};               // per-thread queues (in-memory)
let groupNameChangeDetected = {};   // timestamp recorded when change first noticed
let groupNameRevertInProgress = {}; // bool
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;
let shuttingDown = false;

// Global concurrency limiter to reduce flood risk across groups
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) {
    globalActiveCount++;
    return;
  }
  await new Promise((res) => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) {
    const r = globalPending.shift();
    r();
  }
}

// Helpers: file ops
async function ensureDataFile() {
  try {
    await fsp.access(dataFile);
  } catch (e) {
    await fsp.writeFile(dataFile, JSON.stringify({}, null, 2));
  }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt || "{}");
    info("Loaded saved group locks.");
  } catch (e) {
    warn("Failed to load groupData.json:", e.message || e);
    groupLocks = {};
  }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
    info("Group locks saved.");
  } catch (e) {
    warn("Failed to save groupData.json:", e.message || e);
  }
}

// utilities
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// per-thread queue helpers (but each task will acquire global slot before running)
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
      try { await fn(); } finally { releaseGlobalSlot(); }
    } catch (e) {
      warn(`[${timestamp()}] Queue task error for ${threadID}:`, e.message || e);
    }
    await sleep(250);
  }
  q.running = false;
}

// Puppeteer fallback (optional)
async function startPuppeteerIfEnabled() {
  if (!ENABLE_PUPPETEER) { info("Puppeteer disabled."); return; }
  try {
    const puppeteer = require("puppeteer");
    const launchOpts = { headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] };
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

// change thread title: try API methods, then Puppeteer fallback (best-effort)
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle === "function") {
    return new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  if (typeof apiObj.changeThreadTitle === "function") {
    return new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  if (ENABLE_PUPPETEER && puppeteerAvailable) {
    try {
      const url = `https://www.facebook.com/messages/t/${threadID}`;
      await puppeteerPage.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(()=>{});
      await puppeteerPage.waitForTimeout(1200);
      info(`[${timestamp()}] [PUPP] Puppeteer fallback attempted for title change (best-effort).`);
      return;
    } catch (e) { throw e; }
  }
  throw new Error("No method to change thread title");
}

// appState loader: accept ENV or file
async function loadAppState() {
  if (process.env.APPSTATE) {
    try { return JSON.parse(process.env.APPSTATE); }
    catch (e) { warn("APPSTATE env invalid JSON:", e.message || e); }
  }
  try { const txt = await fsp.readFile(appStatePath, "utf8"); return JSON.parse(txt); }
  catch (e) { throw new Error("Cannot load appstate.json or APPSTATE env"); }
}

// Safely get thread info (never throw, always return object)
async function safeGetThreadInfo(apiObj, threadID) {
  try {
    const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
    if (!info || typeof info !== "object") return {};
    return info;
  } catch (e) {
    warn(`[${timestamp()}] getThreadInfo failed for ${threadID}:`, e.message || e);
    return {};
  }
}

// Turn any thread-info shape into [{id}] list
function extractUsers(info) {
  if (!info || typeof info !== "object") return [];
  if (Array.isArray(info.userInfo) && info.userInfo.length) return info.userInfo.map(u => ({ id: u && u.id }));
  if (Array.isArray(info.participantIDs) && info.participantIDs.length) return info.participantIDs.map(id => ({ id }));
  return [];
}

// init check: reapply nicknames according to groupLocks (run on start + periodically)
async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      const info = await safeGetThreadInfo(apiObj, t);
      const participants = extractUsers(info);
      for (const { id: uid } of participants) {
        if (!uid) continue;
        const desired = (group.original && group.original[uid]) || group.nick;
        if (!desired) continue;
        const current = (info.nicknames && info.nicknames[uid]) || (Array.isArray(info.userInfo) && (info.userInfo.find(u => u.id === uid)?.nickname)) || null;
        if (current !== desired) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
              info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);
              await sleep(randomDelay());
            } catch (e) { warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e); }
          });
        }
      }
    }
  } catch (e) { warn("initCheckLoop error:", e.message || e); }
}

// Main login + run with reconnect logic
let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try { loginLib({ appState }, (err, a) => (err ? rej(err) : res(a))); }
        catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"} `);

      // 🔇 Patch setPostReaction to ignore unavailable content errors going forward
      try {
        if (api.setPostReaction) {
          const _orig = api.setPostReaction.bind(api);
          api.setPostReaction = (...args) => {
            const last = args[args.length - 1];
            if (typeof last === "function") {
              args[args.length - 1] = (err, ...rest) => {
                const msg = (err && (err.summary || err.message)) || "";
                const code = err && (err.code || err.api_error_code);
                if (code === 1446034 || /Content Not Available/i.test(msg)) {
                  warn(`[${timestamp()}] [REACTION] Skipped: content unavailable`);
                  return; // swallow silently
                }
                return last(err, ...rest);
              };
            }
            try { return _orig(...args); }
            catch (e) {
              const msg = (e && (e.summary || e.message)) || "";
              const code = e && (e.code || e.api_error_code);
              if (code === 1446034 || /Content Not Available/i.test(msg)) {
                warn(`[${timestamp()}] [REACTION] Skipped: content unavailable`);
                return;
              }
              throw e;
            }
          };
        }
      } catch (e) { /* ignore */ }

      // load persisted locks
      await loadLocks();

      // start puppeteer optionally
      startPuppeteerIfEnabled().catch(e => warn("Puppeteer init err:", e.message || e));

      // group-name watcher: detects name change and reverts after GROUP_NAME_REVERT_DELAY (47s)
      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        const MAX_PER_TICK = 20;
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          try {
            const infoObj = await safeGetThreadInfo(api, threadID);
            const currentName = infoObj && infoObj.threadName;
            if (currentName && currentName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${currentName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s if still changed.`);
              } else {
                const elapsed = Date.now() - groupNameChangeDetected[threadID];
                if (elapsed >= GROUP_NAME_REVERT_DELAY) {
                  groupNameRevertInProgress[threadID] = true;
                  try {
                    await changeThreadTitle(api, threadID, group.groupName);
                    info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`);
                  } catch (e) {
                    warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`, e.message || e);
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

      // anti-sleep typing indicator
      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const g = groupLocks[id];
            if (!g || (!g.gclock && !g.enabled)) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, (err) => (err ? rej(err) : res())));
            await sleep(1200);
          } catch (e) {
            warn(`[${timestamp()}] Typing indicator failed for ${id}:`, e.message || e);
            const m = (e.message || "").toLowerCase();
            if (m.includes("client disconnecting") || m.includes("not logged in")) {
              warn("Detected client disconnect - attempting reconnect...");
              try { api.removeAllListeners && api.removeAllListeners(); } catch(_){ }
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      // appstate backup
      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s) await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
          info(`[${timestamp()}] Appstate backed up.`);
        } catch (e) { warn("Appstate backup error:", e.message || e); }
      }, APPSTATE_BACKUP_INTERVAL);

      // initial init check
      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api).catch(e => warn("initCheck error:", e.message || e)), 5 * 60 * 1000);

      // Event listener
      api.listenMqtt(async (err, event) => {
        if (err) {
          warn("listenMqtt error:", err.message || err);
          return;
        }
        if (!event || typeof event !== "object") return;
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();

          // Boss-only commands
          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = (body || "").toLowerCase();

            if (lc === "/nicklock on") {
              try {
                const infoThread = await safeGetThreadInfo(api, threadID);
                // NOTE: Default nick kept configurable; set a neutral default.
                const lockedNick = groupLocks[threadID]?.nick || "(locked)";
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].enabled = true;
                groupLocks[threadID].nick = lockedNick;
                groupLocks[threadID].original = groupLocks[threadID].original || {};
                groupLocks[threadID].count = 0;
                groupLocks[threadID].cooldown = false;

                const users = extractUsers(infoThread);
                if (!users.length) {
                  warn(`[${timestamp()}] [NICKLOCK] No participants resolved for ${threadID}; skipping mass apply.`);
                }
                for (const { id } of users) {
                  if (!id) continue;
                  groupLocks[threadID].original[id] = lockedNick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, id, (err) => (err ? rej(err) : res())));
                      info(`[${timestamp()}] Changed nick for ${id} in ${threadID}`);
                    } catch (e) { warn(`[${timestamp()}] changeNickname failed for ${id}:`, e.message || e); }
                    await sleep(randomDelay());
                  });
                }
                await saveLocks();
                info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
              } catch (e) { warn(`[${timestamp()}] Nicklock activation failed:`, e.message || e); }
            }

            if (lc === "/nicklock off" || body === "/nicklock off") {
              if (groupLocks[threadID]) { groupLocks[threadID].enabled = false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); }
            }

            if (lc === "/nickall" || body === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              try {
                const infoThread = await safeGetThreadInfo(api, threadID);
                const users = extractUsers(infoThread);
                for (const { id } of users) {
                  const nick = data.nick;
                  if (!id || !nick) continue;
                  groupLocks[threadID].original = groupLocks[threadID].original || {};
                  groupLocks[threadID].original[id] = nick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(nick, threadID, id, (err) => (err ? rej(err) : res())));
                      info(`[${timestamp()}] Reapplied nick for ${id}`);
                    } catch (e) { warn(`[${timestamp()}] Nick apply failed:`, e.message || e); }
                    await sleep(randomDelay());
                  });
                }
                await saveLocks();
                info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
              } catch (e) { warn(`[${timestamp()}] /nickall failed:`, e.message || e); }
            }

            if (lc.startsWith("/gclock ")) {
              const customName = body.slice(8).trim();
              if (!customName) return;
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].groupName = customName;
              groupLocks[threadID].gclock = true;
              try { await changeThreadTitle(api, threadID, customName); await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`); } catch (e) { warn("Could not set group name:", e.message || e); }
            }

            if (lc === "/gclock") {
              try {
                const infoThread = await safeGetThreadInfo(api, threadID);
                const currentName = infoThread.threadName || "";
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = currentName;
                groupLocks[threadID].gclock = true;
                await saveLocks();
                info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${currentName}"`);
              } catch (e) { warn("/gclock failed:", e.message || e); }
            }

            if (lc === "/unlockgname" || body === "/unlockgname") {
              if (groupLocks[threadID]) { delete groupLocks[threadID].gclock; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`); }
            }
          } // end boss-only commands

          // Quick reaction to thread-name log events (also handled by poller)
          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const lockedName = groupLocks[event.threadID]?.groupName;
            const newName = event.logMessageData?.name;
            if (lockedName && newName && newName !== lockedName) {
              if (!groupNameChangeDetected[event.threadID]) {
                groupNameChangeDetected[event.threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected quick name change for ${event.threadID} -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);
              }
            }
          }

          // Nickname revert events
          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick;

            if (uid && lockedNick && currentNick !== lockedNick) {
              queueTask(threadID, async () => {
                try {
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);
                    setTimeout(() => { group.cooldown = false; group.count = 0; info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`); }, NICKNAME_COOLDOWN);
                  } else {
                    await sleep(randomDelay());
                  }
                  await saveLocks();
                } catch (e) {
                  warn(`[${timestamp()}] Nick revert failed for ${uid} in ${threadID}:`, e.message || e);
                }
              });
            }
          }

          // When members join / thread created, sync mapping if nicklock enabled
          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              try {
                const infoThread = await safeGetThreadInfo(api, event.threadID);
                const users = extractUsers(infoThread);
                g.original = g.original || {};
                for (const { id } of users) { if (!id) continue; g.original[id] = g.nick; }
                await saveLocks();
                info(`[${timestamp()}] Membership sync for ${event.threadID}`);
              } catch (e) { warn(`Membership sync failed for ${event.threadID}:`, e.message || e); }
            }
          }

        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          warn("Event handler caught error:", e.message || e);
        }
      }); // end listenMqtt

      // login succeeded; reset attempts
      loginAttempts = 0;
      break; // stay logged in and let intervals/listener run
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  } // while
}

// Start bot
loginAndRun().catch((e) => { error("Fatal start error:", e.message || e); process.exit(1); });

// Global handlers
process.on("uncaughtException", (err) => {
  error("uncaughtException:", err && err.stack ? err.stack : err);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch(_){}
  setTimeout(() => loginAndRun().catch(e=>error("relogin after exception failed:", e.message || e)), 5000);
});
process.on("unhandledRejection", (reason) => {
  warn("unhandledRejection:", reason);
  setTimeout(() => loginAndRun().catch(e=>error("relogin after rejection failed:", e.message || e)), 5000);
});

// graceful shutdown
async function gracefulExit() {
  shuttingDown = true;
  info("Graceful shutdown: saving state...");
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  try { if (puppeteerBrowser) await puppeteerBrowser.close(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
