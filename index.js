/**
 * Updated index.js for 20-30 groups with optimized logging
 * - Reads APPSTATE directly from appstate.json (no .env APPSTATE)
 * - Bot sets its own nickname first, then others
 * - Bot changes show group messages (triggers Facebook default messages)
 * - Member nickname changes: 15s silence, then revert without group messages
 * - Dynamic nickname change speed: 5-6s (fast), 14-15s (slow) in cycles
 * - Optimized logging: deduplicated events, removed redundant messages
 * - Group-name revert: wait 47s after change detected
 * - Global concurrency limiter set to 1
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
const DEFAULT_NICKNAME = process.env.DEFAULT_NICKNAME || "😈Allah madarchod😈";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// Timing rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000;
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 5000;
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 6000;
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 14000;
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 15000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 50;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 5 * 60 * 1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 10 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;
const MAX_PER_TICK = parseInt(process.env.MAX_PER_TICK) || 5;
const MEMBER_CHANGE_SILENCE_DURATION = 15 * 1000;

const ENABLE_PUPPETEER = false;
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// State
let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let memberChangeSilence = {};
let lastEventLog = {}; // To deduplicate events
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;
let shuttingDown = false;

const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 1;
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
    for (const threadID in groupLocks) {
      if (!groupLocks[threadID].nick) {
        groupLocks[threadID].nick = DEFAULT_NICKNAME;
      }
    }
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function getDynamicDelay(count) {
  const cycle = count % 16;
  if (cycle < 5 || cycle >= 11) {
    return Math.floor(Math.random() * (FAST_NICKNAME_DELAY_MAX - FAST_NICKNAME_DELAY_MIN + 1)) + FAST_NICKNAME_DELAY_MIN;
  } else {
    return Math.floor(Math.random() * (SLOW_NICKNAME_DELAY_MAX - SLOW_NICKNAME_DELAY_MIN + 1)) + SLOW_NICKNAME_DELAY_MIN;
  }
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

async function sendGroupMessage(threadID, message, isBotChange = false) {
  if (isBotChange) {
    await new Promise((res, rej) => api.sendMessage(message, threadID, (err) => (err ? rej(err) : res())));
    info(`[${timestamp()}] Sent bot change to ${threadID}: ${message}`);
  } else {
    const silenceEnd = memberChangeSilence[threadID] || 0;
    if (Date.now() < silenceEnd) {
      return;
    }
  }
}

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
      warn(`[${timestamp()}] Queue error in ${threadID}: ${e.message || e}`);
    }
    await sleep(500);
  }
  q.running = false;
}

async function safeGetThreadInfo(apiObj, threadID) {
  try {
    const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
    if (!info || typeof info !== 'object') {
      return null;
    }
    return {
      threadName: info.threadName || "",
      participantIDs: (info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id || '') : [])).filter(id => id),
      nicknames: info.nicknames || {},
      userInfo: Array.isArray(info.userInfo) ? info.userInfo.filter(u => u && u.id) : []
    };
  } catch (e) {
    return null;
  }
}

async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle === "function") {
    return new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  if (typeof apiObj.changeThreadTitle === "function") {
    return new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  throw new Error("No method to change thread title");
}

async function loadAppState() {
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    const appState = JSON.parse(txt);
    if (!Array.isArray(appState)) {
      throw new Error("Invalid appstate.json: must be an array");
    }
    return appState;
  } catch (e) {
    throw new Error(`Cannot load appstate.json: ${e.message || e}`);
  }
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t);
        if (!threadInfo) continue;
        const botNick = group.nick || DEFAULT_NICKNAME;
        if (threadInfo.nicknames[BOSS_UID] !== botNick) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(botNick, t, BOSS_UID, (err) => (err ? rej(err) : res())));
              await sendGroupMessage(t, `Bot nickname set to ${botNick}`, true);
              log(`[INIT] Set bot nick to ${botNick} in ${t}`);
              await sleep(getDynamicDelay(group.count || 0));
            } catch (e) {
              warn(`[INIT] Bot nick set failed in ${t}: ${e.message || e}`);
            }
          });
        }
        for (const uid of threadInfo.participantIDs) {
          if (uid === BOSS_UID) continue;
          const desired = group.original?.[uid] || group.nick || DEFAULT_NICKNAME;
          if (!desired) continue;
          const current = threadInfo.nicknames[uid] || (threadInfo.userInfo.find(u => u.id === uid)?.nickname) || null;
          if (current !== desired) {
            queueTask(t, async () => {
              try {
                await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
                await sendGroupMessage(t, `Nickname for ${uid} set to ${desired}`, true);
                log(`[INIT] Reapplied nick for ${uid} in ${t} to "${desired}"`);
                group.count = (group.count || 0) + 1;
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) {
                warn(`[INIT] Revert failed for ${uid} in ${t}: ${e.message || e}`);
              }
            });
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    warn("initCheckLoop error:", e.message || e);
  }
}

let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try {
          loginLib({ appState }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);

      await loadLocks();

      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          try {
            const threadInfo = await safeGetThreadInfo(api, threadID);
            if (threadInfo && threadInfo.threadName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[GCLOCK] Name change detected in ${threadID}, reverting in ${GROUP_NAME_REVERT_DELAY/1000}s`);
              } else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[threadID] = true;
                try {
                  await changeThreadTitle(api, threadID, group.groupName);
                  info(`[GCLOCK] Reverted ${threadID} to "${group.groupName}"`);
                } catch (e) {
                  warn(`[GCLOCK] Revert failed for ${threadID}: ${e.message || e}`);
                } finally {
                  groupNameChangeDetected[threadID] = null;
                  groupNameRevertInProgress[threadID] = false;
                }
              }
            } else {
              groupNameChangeDetected[threadID] = null;
            }
          } catch (e) {}
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const g = groupLocks[id];
            if (!g || (!g.gclock && !g.enabled)) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, (err) => (err ? rej(err) : res())));
            await sleep(1200);
          } catch (e) {
            warn(`Typing indicator failed for ${id}: ${e.message || e}`);
            if ((e.message || "").toLowerCase().includes("client disconnecting") || (e.message || "").toLowerCase().includes("not logged in")) {
              warn("Detected disconnect - attempting reconnect...");
              try { api.removeAllListeners && api.removeAllListeners(); } catch(_){}
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s) await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
          info("Appstate backed up.");
        } catch (e) { warn("Appstate backup error:", e.message || e); }
      }, APPSTATE_BACKUP_INTERVAL);

      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api).catch(e => warn("initCheck error:", e.message || e)), 5 * 60 * 1000);

      api.listenMqtt(async (err, event) => {
        if (err) {
          warn("listenMqtt error:", err.message || err);
          return;
        }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();
          const eventKey = `${event.logMessageType}_${threadID}_${event.logMessageData?.participant_id || event.logMessageData?.name || ""}`;
          const now = Date.now();

          if (lastEventLog[eventKey] && (now - lastEventLog[eventKey]) < 5000) return; // Deduplicate within 5s
          lastEventLog[eventKey] = now;

          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = (body || "").toLowerCase();
            if (lc === "/nicklock on") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID);
                if (!threadInfo) return;
                const lockedNick = groupLocks[threadID]?.nick || DEFAULT_NICKNAME;
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].enabled = true;
                groupLocks[threadID].nick = lockedNick;
                groupLocks[threadID].original = groupLocks[threadID].original || {};
                groupLocks[threadID].count = 0;
                groupLocks[threadID].cooldown = false;
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, BOSS_UID, (err) => (err ? rej(err) : res())));
                    await sendGroupMessage(threadID, `Bot nickname set to ${lockedNick}`, true);
                    info(`[NICKLOCK] Activated bot nick ${lockedNick} in ${threadID}`);
                    await sleep(getDynamicDelay(groupLocks[threadID].count || 0));
                  } catch (e) {
                    warn(`[NICKLOCK] Bot nick set failed in ${threadID}: ${e.message || e}`);
                  }
                });
                for (const user of (threadInfo.userInfo || [])) {
                  if (user.id === BOSS_UID) continue;
                  groupLocks[threadID].original[user.id] = lockedNick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(threadID, `Nickname for ${user.id} set to ${lockedNick}`, true);
                      info(`[NICKLOCK] Set nick for ${user.id} in ${threadID} to "${lockedNick}"`);
                      groupLocks[threadID].count = (groupLocks[threadID].count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(groupLocks[threadID].count));
                    } catch (e) {
                      warn(`[NICKLOCK] Nick set failed for ${user.id}: ${e.message || e}`);
                    }
                  });
                }
                await saveLocks();
                info(`[NICKLOCK] Activated for ${threadID}`);
              } catch (e) { warn(`[NICKLOCK] Activation failed: ${e.message || e}`); }
            }
            if (lc === "/nicklock off" || body === "/nicklock off") {
              if (groupLocks[threadID]) { 
                groupLocks[threadID].enabled = false; 
                await saveLocks(); 
                info(`[NICKLOCK] Deactivated for ${threadID}`);
              }
            }
            if (lc === "/nickall" || body === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID);
                if (!threadInfo) return;
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(data.nick || DEFAULT_NICKNAME, threadID, BOSS_UID, (err) => (err ? rej(err) : res())));
                    await sendGroupMessage(threadID, `Bot nickname reapplied to ${data.nick || DEFAULT_NICKNAME}`, true);
                    info(`[NICKLOCK] Reapplied bot nick in ${threadID}`);
                    await sleep(getDynamicDelay(data.count || 0));
                  } catch (e) {
                    warn(`[NICKLOCK] Bot nick reapply failed: ${e.message || e}`);
                  }
                });
                for (const user of (threadInfo.userInfo || [])) {
                  if (user.id === BOSS_UID) continue;
                  const nick = data.nick || DEFAULT_NICKNAME;
                  groupLocks[threadID].original = groupLocks[threadID].original || {};
                  groupLocks[threadID].original[user.id] = nick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(nick, threadID, user.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(threadID, `Nickname for ${user.id} reapplied to ${nick}`, true);
                      info(`[NICKLOCK] Reapplied nick for ${user.id} in ${threadID}`);
                      data.count = (data.count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(data.count));
                    } catch (e) { warn(`[NICKLOCK] Nick apply failed: ${e.message || e}`); }
                  });
                }
                await saveLocks();
                info(`[NICKLOCK] Nicknames reapplied for ${threadID}`);
              } catch (e) { warn(`[NICKLOCK] /nickall failed: ${e.message || e}`); }
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
                info(`[GCLOCK] Locked ${threadID} to "${customName}"`);
              } catch (e) { warn("Failed to set group name:", e.message || e); }
            }
            if (lc === "/gclock") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID);
                if (!threadInfo) return;
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = threadInfo.threadName;
                groupLocks[threadID].gclock = true;
                await saveLocks();
                info(`[GCLOCK] Locked ${threadID} to "${threadInfo.threadName}"`);
              } catch (e) { warn("/gclock failed:", e.message || e); }
            }
            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) { 
                delete groupLocks[threadID].gclock; 
                await saveLocks(); 
                info(`[GCLOCK] Unlocked ${threadID}`);
              }
            }
          }

          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const lockedName = groupLocks[event.threadID]?.groupName;
            if (lockedName && event.logMessageData?.name !== lockedName) {
              if (!groupNameChangeDetected[event.threadID]) {
                groupNameChangeDetected[event.threadID] = Date.now();
                info(`[GCLOCK] Name change detected in ${event.threadID}`);
              }
            }
          }

          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick || DEFAULT_NICKNAME;

            if (lockedNick && currentNick !== lockedNick) {
              memberChangeSilence[threadID] = Date.now() + MEMBER_CHANGE_SILENCE_DURATION;
              queueTask(threadID, async () => {
                try {
                  await sleep(MEMBER_CHANGE_SILENCE_DURATION);
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  info(`🎭 [NICKLOCK] Reverted ${uid} in ${threadID} to "${lockedNick}"`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    warn(`[COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);
                    setTimeout(() => { 
                      group.cooldown = false; 
                      group.count = 0; 
                      info(`[COOLDOWN] Lifted for ${threadID}`); 
                    }, NICKNAME_COOLDOWN);
                  }
                  await saveLocks();
                  await sleep(getDynamicDelay(group.count));
                } catch (e) {
                  warn(`[NICKLOCK] Revert failed for ${uid} in ${threadID}: ${e.message || e}`);
                } finally {
                  if (memberChangeSilence[threadID] && Date.now() >= memberChangeSilence[threadID]) {
                    delete memberChangeSilence[threadID];
                  }
                }
              });
            }
          }

          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              try {
                const threadInfo = await safeGetThreadInfo(api, event.threadID);
                if (!threadInfo) return;
                g.original = g.original || {};
                for (const u of (threadInfo.userInfo || [])) {
                  if (u.id === BOSS_UID) continue;
                  g.original[u.id] = g.nick || DEFAULT_NICKNAME;
                  queueTask(event.threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(g.nick || DEFAULT_NICKNAME, event.threadID, u.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(event.threadID, `Nickname for ${u.id} set to ${g.nick || DEFAULT_NICKNAME}`, true);
                      info(`[NICKLOCK] Set nick for ${u.id} in ${event.threadID}`);
                      g.count = (g.count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(g.count));
                    } catch (e) {
                      warn(`[NICKLOCK] Nick set failed for ${u.id}: ${e.message || e}`);
                    }
                  });
                }
                await saveLocks();
                info(`[NICKLOCK] Synced members for ${event.threadID}`);
              } catch (e) { warn(`[NICKLOCK] Sync failed for ${event.threadID}: ${e.message || e}`); }
            }
          }

        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          warn("Event handler error:", e.message || e);
        }
      });

      loginAttempts = 0;
      break;
    } catch (e) {
      error(`Login/Run error: ${e.message || e}`);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  }
}

loginAndRun().catch((e) => { error("Fatal start error:", e.message || e); process.exit(1); });

process.on("uncaughtException", (err) => {
  error("uncaughtException:", err && err.stack ? err.stack : err);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch(_){}
  setTimeout(() => loginAndRun().catch(e=>error("relogin failed:", e.message || e)), 5000);
});
process.on("unhandledRejection", (reason) => {
  warn("unhandledRejection:", reason);
  setTimeout(() => loginAndRun().catch(e=>error("relogin failed:", e.message || e)), 5000);
});

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
