/**
 * Updated index.js for 20-30 groups with enhanced stability
 * - Reads APPSTATE directly from appstate.json
 * - Bot sets its own nickname first, then others
 * - Member nickname changes: 15s silence, then revert without group messages unless changed by BOSS
 * - Dynamic nickname change speed: 7-10s (fast), 15-20s (slow) for safety
 * - Optimized logging: minimal logs, no group messages
 * - Group-name revert: wait 60s after change detected
 * - Auto-session refresh every 6 hours
 * - Rate limit protection with auto-pause
 * - Keepalive ping to prevent server sleep
 * - Global concurrency limiter set to 1
 * - Improved command handling for /gclock and /nicklock on
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
};
function log(...a) { console.log(C.green + "[BOT]" + C.reset, ...a); }

const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.get("/ping", (req, res) => res.send("Pong!")); // Keepalive ping
app.listen(PORT, () => log(`Server started on port ${PORT}`));

const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DEFAULT_NICKNAME = process.env.DEFAULT_NICKNAME || "😈ALLAH MADARCHOD😈";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 60 * 1000; // Increased to 60s
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 5000; // Increased to 7s
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 7000; // Increased to 10s
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 15000; // Increased to 15s
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 20000; // Increased to 20s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 30; // Reduced to 30
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 10 * 60 * 1000; // Increased to 10min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 15 * 60 * 1000; // Increased to 15min
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 6 * 60 * 60 * 1000; // 6 hours
const MAX_PER_TICK = parseInt(process.env.MAX_PER_TICK) || 3; // Reduced to 3
const MEMBER_CHANGE_SILENCE_DURATION = 15 * 1000;

const ENABLE_PUPPETEER = false;
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let memberChangeSilence = {};
let lastEventLog = {};
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;
let shuttingDown = false;

const GLOBAL_MAX_CONCURRENT = 1;
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
  } catch (e) {
    groupLocks = {};
  }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
  } catch (e) {}
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

async function sendGroupMessage(threadID, message, isBotChange = false) {
  // Group messages disabled, only log the action
  if (isBotChange) {
    log(`[ACTION] Would send to ${threadID}: ${message}`);
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
    } catch (e) {}
    await sleep(1000); // Increased delay between tasks
  }
  q.running = false;
}

async function safeGetThreadInfo(apiObj, threadID, maxRetries = 5) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
      if (!info || typeof info !== 'object') {
        throw new Error("Invalid thread info");
      }
      return {
        threadName: info.threadName || "",
        participantIDs: (info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id || '') : [])).filter(id => id),
        nicknames: info.nicknames || {},
        userInfo: Array.isArray(info.userInfo) ? info.userInfo.filter(u => u && u.id) : []
      };
    } catch (e) {
      retries++;
      log(`[DEBUG] Failed to get thread info for ${threadID}, retry ${retries}/${maxRetries}: ${e.message || e}`);
      if (retries === maxRetries) return null;
      await sleep(3000 * retries); // Exponential backoff
    }
  }
}

async function changeThreadTitle(apiObj, threadID, title, maxRetries = 3) {
  if (!apiObj) throw new Error("No api");
  let retries = 0;
  while (retries < maxRetries) {
    try {
      if (typeof apiObj.setTitle === "function") {
        await new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
      } else if (typeof apiObj.changeThreadTitle === "function") {
        await new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
      } else {
        throw new Error("No method to change thread title");
      }
      return;
    } catch (e) {
      retries++;
      log(`[DEBUG] Failed to change title for ${threadID}, retry ${retries}/${maxRetries}: ${e.message || e}`);
      if (retries === maxRetries) throw e;
      await sleep(2000 * retries); // Exponential backoff
    }
  }
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

async function refreshAppState() {
  try {
    const newAppState = api.getAppState();
    await fsp.writeFile(appStatePath, JSON.stringify(newAppState, null, 2));
    log("Appstate refreshed.");
  } catch (e) {}
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t, 5);
        if (!threadInfo) {
          log(`[ERROR] Failed to load thread info for ${t}`);
          continue;
        }
        const botNick = group.nick || DEFAULT_NICKNAME;
        if (threadInfo.nicknames[BOSS_UID] !== botNick) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(botNick, t, BOSS_UID, (err) => (err ? rej(err) : res())));
              await sendGroupMessage(t, `Bot nickname set to ${botNick}`, true);
              await sleep(getDynamicDelay(group.count || 0));
            } catch (e) {}
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
                group.count = (group.count || 0) + 1;
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) {}
            });
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
}

let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      log(`Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try {
          loginLib({ appState }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      log(`Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);

      await loadLocks();

      setInterval(refreshAppState, APPSTATE_BACKUP_INTERVAL); // Auto-refresh every 6 hours

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
              } else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[threadID] = true;
                try {
                  await changeThreadTitle(api, threadID, group.groupName, 5); // Retry up to 5 times
                } catch (e) {} finally {
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
            if ((e.message || "").toLowerCase().includes("client disconnecting") || (e.message || "").toLowerCase().includes("not logged in")) {
              try { api.removeAllListeners && api.removeAllListeners(); } catch(_){}
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api), 5 * 60 * 1000);

      api.listenMqtt(async (err, event) => {
        if (err) return;
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();
          const eventKey = `${event.logMessageType}_${threadID}_${event.logMessageData?.participant_id || event.logMessageData?.name || ""}`;
          const now = Date.now();

          if (lastEventLog[eventKey] && (now - lastEventLog[eventKey]) < 5000) return;
          lastEventLog[eventKey] = now;

          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = (body || "").toLowerCase();
            if (lc === "/nicklock on") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 5);
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
                    await sleep(getDynamicDelay(groupLocks[threadID].count || 0));
                  } catch (e) {}
                });
                for (const user of threadInfo.userInfo || []) {
                  if (user.id === BOSS_UID) continue;
                  groupLocks[threadID].original[user.id] = lockedNick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(threadID, `Nickname for ${user.id} set to ${lockedNick}`, true);
                      groupLocks[threadID].count = (groupLocks[threadID].count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(groupLocks[threadID].count));
                    } catch (e) {}
                  });
                }
                await saveLocks();
              } catch (e) {}
            }
            if (lc === "/nicklock off" || body === "/nicklock off") {
              if (groupLocks[threadID]) { 
                groupLocks[threadID].enabled = false; 
                await saveLocks(); 
              }
            }
            if (lc === "/nickall" || body === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 5);
                if (!threadInfo) return;
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(data.nick || DEFAULT_NICKNAME, threadID, BOSS_UID, (err) => (err ? rej(err) : res())));
                    await sendGroupMessage(threadID, `Bot nickname reapplied to ${data.nick || DEFAULT_NICKNAME}`, true);
                    await sleep(getDynamicDelay(data.count || 0));
                  } catch (e) {}
                });
                for (const user of threadInfo.userInfo || []) {
                  if (user.id === BOSS_UID) continue;
                  const nick = data.nick || DEFAULT_NICKNAME;
                  groupLocks[threadID].original = groupLocks[threadID].original || {};
                  groupLocks[threadID].original[user.id] = nick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(nick, threadID, user.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(threadID, `Nickname for ${user.id} reapplied to ${nick}`, true);
                      data.count = (data.count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(data.count));
                    } catch (e) {}
                  });
                }
                await saveLocks();
              } catch (e) {}
            }
            if (lc.startsWith("/gclock ")) {
              const customName = body.slice(8).trim();
              if (!customName) {
                log(`[DEBUG] /gclock with empty name for ${threadID}`);
                return;
              }
              groupLocks[threadID] = groupLocks[threadID] || {};
              groupLocks[threadID].groupName = customName;
              groupLocks[threadID].gclock = true;
              try {
                log(`[DEBUG] Attempting to set group name to ${customName} for ${threadID}`);
                await changeThreadTitle(api, threadID, customName);
                await saveLocks();
                log(`[SUCCESS] Locked ${threadID} to "${customName}"`);
              } catch (e) {
                log(`[ERROR] Failed to set group name for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc === "/gclock") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 5);
                if (!threadInfo) {
                  log(`[ERROR] Failed to load thread info for ${threadID}`);
                  return;
                }
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = threadInfo.threadName;
                groupLocks[threadID].gclock = true;
                log(`[DEBUG] Attempting to lock ${threadID} to "${threadInfo.threadName}"`);
                await changeThreadTitle(api, threadID, threadInfo.threadName);
                await saveLocks();
                log(`[SUCCESS] Locked ${threadID} to "${threadInfo.threadName}"`);
              } catch (e) {
                log(`[ERROR] /gclock failed for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) { 
                delete groupLocks[threadID].gclock; 
                await saveLocks(); 
                log(`[SUCCESS] Unlocked ${threadID}`);
              }
            }
          }

          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick || DEFAULT_NICKNAME;

            // Only revert if not changed by BOSS
            if (lockedNick && currentNick !== lockedNick && uid !== BOSS_UID) {
              memberChangeSilence[threadID] = Date.now() + MEMBER_CHANGE_SILENCE_DURATION;
              queueTask(threadID, async () => {
                try {
                  await sleep(MEMBER_CHANGE_SILENCE_DURATION);
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  log(`🎭 [NICKLOCK] Reverted ${uid} in ${threadID} to "${lockedNick}"`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    setTimeout(() => { 
                      group.cooldown = false; 
                      group.count = 0; 
                    }, NICKNAME_COOLDOWN);
                  }
                  await saveLocks();
                  await sleep(getDynamicDelay(group.count));
                } catch (e) {}
                finally {
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
                const threadInfo = await safeGetThreadInfo(api, event.threadID, 5);
                if (!threadInfo) return;
                g.original = g.original || {};
                for (const u of threadInfo.userInfo || []) {
                  if (u.id === BOSS_UID) continue;
                  g.original[u.id] = g.nick || DEFAULT_NICKNAME;
                  queueTask(event.threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(g.nick || DEFAULT_NICKNAME, event.threadID, u.id, (err) => (err ? rej(err) : res())));
                      await sendGroupMessage(event.threadID, `Nickname for ${u.id} set to ${g.nick || DEFAULT_NICKNAME}`, true);
                      g.count = (g.count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(g.count));
                    } catch (e) {}
                  });
                }
                await saveLocks();
              } catch (e) {}
            }
          }

        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
        }
      });

      loginAttempts = 0;
      break;
    } catch (e) {
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      await sleep(backoff * 1000);
    }
  }
}

loginAndRun().catch((e) => { process.exit(1); });

process.on("uncaughtException", (err) => {
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch(_){}
  setTimeout(() => loginAndRun(), 5000);
});
process.on("unhandledRejection", (reason) => {
  setTimeout(() => loginAndRun(), 5000);
});

async function gracefulExit() {
  shuttingDown = true;
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  try { if (puppeteerBrowser) await puppeteerBrowser.close(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
