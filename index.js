const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => console.log(`[${new Date().toLocaleTimeString()}] 🌐 Server started on port ${PORT}`));

require("dotenv").config();

// Try ws3-fca first, fallback to fca-unofficial
let loginLib;
try {
  const ws3 = require("ws3-fca");
  loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
  console.log(`[${new Date().toLocaleTimeString()}] ℹ️ Using ws3-fca`);
} catch (e) {
  try {
    const fca = require("fca-unofficial");
    loginLib = typeof fca === "function" ? fca : (fca.default || fca.login || fca);
    console.warn(`[${new Date().toLocaleTimeString()}] ⚠ ws3-fca failed, using fca-unofficial`);
  } catch (e2) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Neither ws3-fca nor fca-unofficial installed. Install one first.`);
    process.exit(1);
  }
}

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

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 3 * 60 * 1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;
const ENABLE_PUPPETEER = false; // Temporarily disabled as requested

// State
let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let shuttingDown = false;

// Global concurrency limiter
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

// Utilities
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// Per-thread queue helpers
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
      try {
        await fn();
      } finally {
        releaseGlobalSlot();
      }
    } catch (e) {
      warn(`[${timestamp()}] Queue task error for ${threadID}:`, e.message || e);
    }
    await sleep(250);
  }
  q.running = false;
}

// Safe wrapper for getThreadInfo
async function safeGetThreadInfo(apiObj, threadID) {
  try {
    const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
    if (!info) {
      warn(`[${timestamp()}] getThreadInfo returned null for ${threadID}`);
      return null;
    }
    return {
      threadName: info.threadName || "",
      participantIDs: info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id) : []),
      nicknames: info.nicknames || {},
      userInfo: info.userInfo || []
    };
  } catch (e) {
    warn(`[${timestamp()}] getThreadInfo failed for ${threadID}:`, e.message || e);
    return null;
  }
}

async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  try {
    if (typeof apiObj.setTitle === "function") {
      await new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
      info(`[${timestamp()}] setTitle via API success for ${threadID}`);
      return true;
    }
    if (typeof apiObj.sendMessage === "function") {
      await new Promise((r, rej) => apiObj.sendMessage(`/settitle ${title}`, threadID, (err) => (err ? rej(err) : r())));
      info(`[${timestamp()}] setTitle via sendMessage success for ${threadID}`);
      return true;
    }
    throw new Error("No API method to change thread title");
  } catch (e) {
    warn(`[${timestamp()}] API title change failed for ${threadID}:`, e.message || e);
    return false;
  }
  /*
  // Puppeteer disabled as requested
  if (ENABLE_PUPPETEER) {
    // ... (Puppeteer code commented out)
  }
  */
}

async function loadAppState() {
  if (process.env.APPSTATE) {
    try {
      const parsed = JSON.parse(process.env.APPSTATE);
      if (Array.isArray(parsed) && parsed.every(item => item.key && item.value && item.domain)) {
        return parsed;
      }
      warn(`[${timestamp()}] APPSTATE env is not a valid appstate array`);
    } catch (e) {
      warn(`[${timestamp()}] Failed to parse APPSTATE env:`, e.message || e);
    }
  }
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed) && parsed.every(item => item.key && item.value && item.domain)) {
      return parsed;
    }
    warn(`[${timestamp()}] appstate.json is not a valid appstate array`);
  } catch (e) {
    warn(`[${timestamp()}] Failed to read appstate.json:`, e.message || e);
  }
  throw new Error("Cannot load appstate.json or APPSTATE env");
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks).filter(id => /^[0-9]+$/.test(id));
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      const info = await safeGetThreadInfo(apiObj, t);
      if (!info) continue;
      for (const uid of info.participantIDs) {
        const desired = group.original?.[uid] || group.nick;
        if (!desired) continue;
        const current = info.nicknames[uid] || (info.userInfo.find(u => u.id === uid)?.nickname) || null;
        if (current !== desired) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
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
    warn(`[${timestamp()}] initCheckLoop error:`, e.message || e);
  }
}

let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try {
          loginLib({ appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);

      await loadLocks();

      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks).filter(id => /^[0-9]+$/.test(id));
        const MAX_PER_TICK = 20;
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          const infoObj = await safeGetThreadInfo(api, threadID);
          if (!infoObj) continue;
          if (infoObj.threadName !== group.groupName) {
            if (!groupNameChangeDetected[threadID]) {
              groupNameChangeDetected[threadID] = Date.now();
              info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${infoObj.threadName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s.`);
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
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks).filter(id => /^[0-9]+$/.test(id));
        for (const id of threadIDs) {
          try {
            const g = groupLocks[id];
            if (!g || (!g.gclock && !g.enabled)) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, (err) => (err ? rej(err) : res())));
            info(`[${timestamp()}] 💤 Anti-sleep ping sent to ${id}`);
            await sleep(1200);
          } catch (e) {
            if (e.message?.toLowerCase().includes("client disconnecting") || e.message?.toLowerCase().includes("not logged in")) {
              warn(`[${timestamp()}] Detected client disconnect - attempting reconnect...`);
              try { api.removeAllListeners && api.removeAllListeners(); } catch (_) {}
              throw new Error("FORCE_RECONNECT");
            }
            // Suppress non-critical typing errors
            if (e.error !== 1357031) {
              warn(`[${timestamp()}] Typing indicator failed for ${id}:`, e.message || e);
            }
          }
        }
      }, TYPING_INTERVAL);

      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s && Array.isArray(s) && s.every(item => item.key && item.value && item.domain)) {
            await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
            info(`[${timestamp()}] Appstate backed up.`);
          }
        } catch (e) {
          warn(`[${timestamp()}] Appstate backup error:`, e.message || e);
        }
      }, APPSTATE_BACKUP_INTERVAL);

      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api).catch(e => warn(`[${timestamp()}] initCheck error:`, e.message || e)), 5 * 60 * 1000);

      api.listenMqtt(async (err, event) => {
        if (err) {
          warn(`[${timestamp()}] listenMqtt error:`, err.message || err);
          return;
        }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();

          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = body.toLowerCase();
            if (lc === "/nicklock on") {
              const infoThread = await safeGetThreadInfo(api, threadID);
              if (!infoThread) return;
              const lockedNick = "😈Allah madarchod😈";
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].enabled = true;
              groupLocks[threadID].nick = lockedNick;
              groupLocks[threadID].original = groupLocks[threadID].original || {};
              groupLocks[threadID].count = 0;
              groupLocks[threadID].cooldown = false;
              for (const user of infoThread.userInfo) {
                groupLocks[threadID].original[user.id] = lockedNick;
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? rej(err) : res())));
                    info(`[${timestamp()}] Changed nick for ${user.id} in ${threadID}`);
                  } catch (e) {
                    warn(`[${timestamp()}] changeNickname failed for ${user.id}:`, e.message || e);
                  }
                  await sleep(randomDelay());
                });
              }
              await saveLocks();
              info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
              api.sendMessage(`🔒 Nicklock activated for ${threadID}`, threadID);
            }

            if (lc === "/nicklock off") {
              if (groupLocks[threadID]) {
                groupLocks[threadID].enabled = false;
                await saveLocks();
                info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);
                api.sendMessage(`🔓 Nicklock deactivated for ${threadID}`, threadID);
              }
            }

            if (lc === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              const infoThread = await safeGetThreadInfo(api, threadID);
              if (!infoThread) return;
              for (const user of infoThread.userInfo) {
                const nick = data.nick;
                groupLocks[threadID].original = groupLocks[threadID].original || {};
                groupLocks[threadID].original[user.id] = nick;
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(nick, threadID, user.id, (err) => (err ? rej(err) : res())));
                    info(`[${timestamp()}] Reapplied nick for ${user.id}`);
                  } catch (e) {
                    warn(`[${timestamp()}] Nick apply failed:`, e.message || e);
                  }
                  await sleep(randomDelay());
                });
              }
              await saveLocks();
              info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
              api.sendMessage(`🔄 Nicknames reapplied for ${threadID}`, threadID);
            }

            if (lc.startsWith("/gclock ")) {
              const customName = body.slice(8).trim();
              if (!customName) return;
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].groupName = customName;
              groupLocks[threadID].gclock = true;
              try {
                await changeThreadTitle(api, threadID, customName);
                await saveLocks();
                info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID} to "${customName}"`);
                api.sendMessage(`🔒 Group name locked to "${customName}"`, threadID);
              } catch (e) {
                warn(`[${timestamp()}] Could not set group name:`, e.message || e);
              }
            }

            if (lc === "/gclock") {
              const infoThread = await safeGetThreadInfo(api, threadID);
              if (!infoThread) return;
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].groupName = infoThread.threadName;
              groupLocks[threadID].gclock = true;
              await saveLocks();
              info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
              api.sendMessage(`🔒 Group name locked to "${infoThread.threadName}"`, threadID);
            }

            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) {
                delete groupLocks[threadID].gclock;
                await saveLocks();
                info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`);
                api.sendMessage(`🔓 Group name lock disabled`, threadID);
              }
            }
          }

          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const lockedName = groupLocks[event.threadID]?.groupName;
            if (lockedName && event.logMessageData?.name !== lockedName) {
              if (!groupNameChangeDetected[event.threadID]) {
                groupNameChangeDetected[event.threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected quick name change for ${event.threadID} -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);
              }
            }
          }

          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;
            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick;
            if (lockedNick && currentNick !== lockedNick) {
              queueTask(threadID, async () => {
                try {
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);
                    setTimeout(() => {
                      group.cooldown = false;
                      group.count = 0;
                      info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`);
                    }, NICKNAME_COOLDOWN);
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

          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              const infoThread = await safeGetThreadInfo(api, event.threadID);
              if (!infoThread) return;
              g.original = g.original || {};
              for (const u of infoThread.userInfo) {
                g.original[u.id] = g.nick;
              }
              await saveLocks();
              info(`[${timestamp()}] Membership sync for ${event.threadID}`);
            }
          }
        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          warn(`[${timestamp()}] Event handler caught error:`, e.message || e);
        }
      });
      loginAttempts = 0;
      break;
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`[${timestamp()}] Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  }
}

loginAndRun().catch((e) => {
  error(`[${timestamp()}] Fatal start error:`, e.message || e);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  error(`[${timestamp()}] uncaughtException:`, err && err.stack ? err.stack : err);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch (_) {}
  setTimeout(() => loginAndRun().catch(e => error(`[${timestamp()}] relogin after exception failed:`, e.message || e)), 5000);
});

process.on("unhandledRejection", (reason) => {
  warn(`[${timestamp()}] unhandledRejection:`, reason);
  setTimeout(() => loginAndRun().catch(e => error(`[${timestamp()}] relogin after rejection failed:`, e.message || e)), 5000);
});

async function gracefulExit() {
  shuttingDown = true;
  info(`[${timestamp()}] Graceful shutdown: saving state...`);
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
