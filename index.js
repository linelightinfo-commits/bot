/**
 * Auto-lock Facebook Messenger Bot with groupData.json
 * - Auto-applies nick and group name locks from groupData.json on startup
 * - Silent operation, minimal logs
 * - Nickname delay 6-7s, cooldown after 60 changes (3 min)
 * - Group name revert delay 47s
 * - Anti-sleep typing indicator every 5 min
 * - Saves group locks and appstate regularly
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

// Express keepalive server
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// Timing and limits
const GROUP_NAME_CHECK_INTERVAL = 15 * 1000;
const GROUP_NAME_REVERT_DELAY = 47 * 1000;
const NICKNAME_DELAY_MIN = 6000;
const NICKNAME_DELAY_MAX = 7000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 3 * 60 * 1000;
const TYPING_INTERVAL = 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = 10 * 60 * 1000;

let api = null;
let groupLocks = {};            // group config loaded from groupData.json
let groupQueues = {};           // per-thread queues for nick changes
let groupNameChangeDetected = {}; // for group name revert delay
let groupNameRevertInProgress = {};
let shuttingDown = false;

// Global concurrency limiter to avoid flood/block
const GLOBAL_MAX_CONCURRENT = 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) {
    globalActiveCount++;
    return;
  }
  await new Promise(res => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) {
    const r = globalPending.shift();
    r();
  }
}

// Sleep helper
const sleep = ms => new Promise(res => setTimeout(res, ms));
function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// File helpers
async function ensureDataFile() {
  try {
    await fsp.access(dataFile);
  } catch {
    await fsp.writeFile(dataFile, JSON.stringify({}, null, 2));
  }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt || "{}");
    info("Loaded groupData.json.");
  } catch (e) {
    warn("Failed to load groupData.json:", e.message || e);
    groupLocks = {};
  }
}
async function saveLocks() {
  try {
    const tmp = dataFile + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
    info("Saved groupData.json.");
  } catch (e) {
    warn("Failed to save groupData.json:", e.message || e);
  }
}

// Queue helpers per thread for nick changes
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
      warn(`[${timestamp()}] Queue task error ${threadID}:`, e.message || e);
    }
    await sleep(250);
  }
  q.running = false;
}

// Change group name with API
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No API");
  if (typeof apiObj.setTitle === "function") {
    return new Promise((res, rej) => apiObj.setTitle(title, threadID, err => (err ? rej(err) : res())));
  }
  if (typeof apiObj.changeThreadTitle === "function") {
    return new Promise((res, rej) => apiObj.changeThreadTitle(title, threadID, err => (err ? rej(err) : res())));
  }
  throw new Error("No method to change thread title");
}

// Load appstate.json or env var
async function loadAppState() {
  if (process.env.APPSTATE) {
    try {
      return JSON.parse(process.env.APPSTATE);
    } catch (e) {
      warn("APPSTATE env invalid JSON:", e.message || e);
    }
  }
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    return JSON.parse(txt);
  } catch {
    throw new Error("Cannot load appstate.json or APPSTATE env");
  }
}

// On startup and every 5 mins, enforce nickname locks
async function enforceNicknames(apiObj) {
  const threadIDs = Object.keys(groupLocks);
  for (const t of threadIDs) {
    const group = groupLocks[t];
    if (!group || !group.enabled) continue;
    try {
      const info = await new Promise((res, rej) => apiObj.getThreadInfo(t, (err, r) => (err ? rej(err) : res(r))));
      const participants = info?.participantIDs || (info.userInfo?.map(u => u.id) || []);
      for (const uid of participants) {
        const desired = group.original?.[uid] || group.nick;
        if (!desired) continue;
        const current = (info.nicknames && info.nicknames[uid]) || info.userInfo?.find(u => u.id === uid)?.nickname || null;
        if (current !== desired) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, err => (err ? rej(err) : res())));
              info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);
              await sleep(randomDelay());
            } catch (e) {
              warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e);
            }
          });
        }
      }
    } catch {
      // ignore single thread failure
    }
  }
}

// Main login + run
let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (try ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try {
          loginLib({ appState }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) {
          rej(e);
        }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in.`);

      await loadLocks();

      // Periodic enforcement on startup + every 5 min
      await enforceNicknames(api);
      setInterval(() => enforceNicknames(api).catch(() => {}), 5 * 60 * 1000);

      // Group name revert poller
      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        const MAX_PER_TICK = 20;
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          try {
            const infoObj = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
            if (infoObj && infoObj.threadName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected name change for ${threadID} -> "${infoObj.threadName}". Will revert in ${GROUP_NAME_REVERT_DELAY/1000}s`);
              } else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[threadID] = true;
                try {
                  await changeThreadTitle(api, threadID, group.groupName);
                  info(`[${timestamp()}] [GCLOCK] Reverted name for ${threadID} -> "${group.groupName}"`);
                } catch (e) {
                  warn(`[${timestamp()}] [GCLOCK] Revert failed for ${threadID}:`, e.message || e);
                } finally {
                  groupNameChangeDetected[threadID] = null;
                  groupNameRevertInProgress[threadID] = false;
                }
              }
            } else {
              groupNameChangeDetected[threadID] = null;
            }
          } catch {
            // ignore errors
          }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep typing indicator
      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const g = groupLocks[id];
            if (!g || (!g.gclock && !g.enabled)) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, err => (err ? rej(err) : res())));
            await sleep(1200);
          } catch {
            // ignore errors
          }
        }
      }, TYPING_INTERVAL);

      // Appstate backup
      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s) await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
          info(`[${timestamp()}] Appstate backed up.`);
        } catch (e) {
          warn("Appstate backup error:", e.message || e);
        }
      }, APPSTATE_BACKUP_INTERVAL);

      // Event listener
      api.listenMqtt(async (err, event) => {
        if (err) {
          warn("listenMqtt error:", err.message || err);
          return;
        }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();

          // Boss-only commands to enable/disable locks if needed
          if (event.type === "message" && senderID === BOSS_UID) {
            const lc = body.toLowerCase();

            if (lc === "/nicklock on") {
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
                const lockedNick = "😈LockedNick😈"; // customize this nickname
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].enabled = true;
                groupLocks[threadID].nick = lockedNick;
                groupLocks[threadID].original = groupLocks[threadID].original || {};
                groupLocks[threadID].count = 0;
                groupLocks[threadID].cooldown = false;
                for (const user of (infoThread.userInfo || [])) {
                  groupLocks[threadID].original[user.id] = lockedNick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, user.id, err => (err ? rej(err) : res())));
                      info(`[${timestamp()}] Changed nick for ${user.id} in ${threadID}`);
                    } catch (e) {
                      warn(`[${timestamp()}] changeNickname failed for ${user.id}:`, e.message || e);
                    }
                    await sleep(randomDelay());
                  });
                }
                await saveLocks();
                info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
              } catch (e) {
                warn(`[${timestamp()}] Nicklock activation failed:`, e.message || e);
              }
            }

            if (lc === "/nicklock off") {
              if (groupLocks[threadID]) {
                groupLocks[threadID].enabled = false;
                await saveLocks();
                info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);
              }
            }

            if (lc === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
                for (const user of (infoThread.userInfo || [])) {
                  const nick = data.nick;
                  groupLocks[threadID].original = groupLocks[threadID].original || {};
                  groupLocks[threadID].original[user.id] = nick;
                  queueTask(threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(nick, threadID, user.id, err => (err ? rej(err) : res())));
                      info(`[${timestamp()}] Reapplied nick for ${user.id}`);
                    } catch (e) {
                      warn(`[${timestamp()}] Nick apply failed:`, e.message || e);
                    }
                    await sleep(randomDelay());
                  });
                }
                await saveLocks();
                info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
              } catch (e) {
                warn(`[${timestamp()}] /nickall failed:`, e.message || e);
              }
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
                info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`);
              } catch (e) {
                warn("Could not set group name:", e.message || e);
              }
            }

            if (lc === "/gclock") {
              try {
                const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = infoThread.threadName;
                groupLocks[threadID].gclock = true;
                await saveLocks();
                info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
              } catch (e) {
                warn("/gclock failed:", e.message || e);
              }
            }

            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) {
                delete groupLocks[threadID].gclock;
                await saveLocks();
                info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`);
              }
            }
          } // end boss commands

          // On nickname change event: revert if locked
          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;
            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick;
            if (lockedNick && currentNick !== lockedNick) {
              queueTask(threadID, async () => {
                try {
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, err => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooldown started for 3 minutes.`);
                    setTimeout(() => {
                      group.cooldown = false;
                      group.count = 0;
                      info(`▶️ [${timestamp()}] [COOLDOWN] ${threadID} cooldown ended.`);
                    }, NICKNAME_COOLDOWN);
                  }
                  await sleep(randomDelay());
                } catch (e) {
                  warn(`[${timestamp()}] [NICKLOCK] Revert failed:`, e.message || e);
                }
              });
            }
          }
        } catch (e) {
          warn("Event handler error:", e.message || e);
        }
      });
      break; // break while on success
    } catch (e) {
      error("Login failed:", e.message || e);
      await sleep(10 * 1000);
    }
  }
}

// Graceful shutdown save
process.on("SIGINT", async () => {
  shuttingDown = true;
  log("Shutting down... saving groupData.json");
  await saveLocks();
  process.exit();
});

// Start bot
(async () => {
  await loginAndRun();
})();
