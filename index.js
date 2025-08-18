/**
 * Updated index.js for 20-30 groups with enhanced stability
 * - Fixes logout issue with forceLogin, userAgent, and proxy support
 * - Handles 'Content Not Available' errors for group access
 * - Extended pauses for rate limits and session errors
 * - Single group processing for testing
 * - Detailed logging and BOSS notifications
 * - TIP: Disable 2FA, use VPN (US IP), and verify group access
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
app.get("/ping", (req, res) => res.send("Pong!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DEFAULT_NICKNAME = process.env.DEFAULT_NICKNAME || "😈Allah madarchod😈";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 60 * 1000;
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 5000; // 20s
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 7000; // 30s
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 10000; // 40s
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 15000; // 50s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 30;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 10 * 60 * 1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 15 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 6 * 60 * 60 * 1000;
const MAX_PER_TICK = parseInt(process.env.MAX_PER_TICK) || 1;
const MEMBER_CHANGE_SILENCE_DURATION = 15 * 1000;

let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let memberChangeSilence = {};
let lastEventLog = {};
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
    log(`[ERROR] Failed to load groupLocks: ${e.message || e}`);
  }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
  } catch (e) {
    log(`[ERROR] Failed to save groupLocks: ${e.message || e}`);
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

async function sendGroupMessage(threadID, message, isBotChange = false) {
  if (isBotChange) {
    log(`[ACTION] Would send to ${threadID}: ${message}`);
  } else {
    const silenceEnd = memberChangeSilence[threadID] || 0;
    if (Date.now() < silenceEnd) {
      return;
    }
  }
}

async function notifyBoss(message) {
  try {
    if (api) await api.sendMessage(message, BOSS_UID);
    log(`[NOTIFY] Sent to BOSS_UID: ${message}`);
  } catch (e) {
    log(`[ERROR] Failed to notify boss: ${e.message || e}`);
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
      log(`[ERROR] Queue task failed for ${threadID}: ${e.message || e}`);
    }
    await sleep(2000);
  }
  q.running = false;
}

async function safeGetThreadInfo(apiObj, threadID, maxRetries = 3) {
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
      if (e.message.includes("429") || e.message.includes("rate limit") || e.message.includes("userID") || e.message.includes("not available")) {
        log(`[ERROR] Rate limit or access error for ${threadID}, pausing for 20 minutes`);
        await sleep(20 * 60 * 1000);
        // Disable group if persistently unavailable
        if (groupLocks[threadID]) {
          groupLocks[threadID].enabled = false;
          await saveLocks();
          await notifyBoss(`Disabled group ${threadID} due to persistent access error`);
        }
      }
      log(`[DEBUG] Failed to get thread info for ${threadID}, retry ${retries}/${maxRetries}: ${e.message || e}`);
      if (retries === maxRetries) return null;
      await sleep(5000 * retries);
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
      await sleep(2000 * retries);
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
    await notifyBoss("Appstate refreshed successfully.");
  } catch (e) {
    log(`[ERROR] Failed to refresh appstate: ${e.message || e}`);
  }
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t, 3);
        if (!threadInfo) {
          log(`[ERROR] Failed to load thread info for ${t}, disabling group`);
          group.enabled = false;
          await saveLocks();
          await notifyBoss(`Disabled group ${t} due to access failure`);
          continue;
        }
        const botNick = group.nick || DEFAULT_NICKNAME;
        if (threadInfo.nicknames[BOSS_UID] !== botNick) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(botNick, t, BOSS_UID, (err) => (err ? rej(err) : res())));
              await sendGroupMessage(t, `Bot nickname set to ${botNick}`, true);
              await sleep(getDynamicDelay(group.count || 0));
            } catch (e) {
              log(`[ERROR] Failed to set bot nickname in ${t}: ${e.message || e}`);
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
                group.count = (group.count || 0) + 1;
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) {
                log(`[ERROR] Failed to set nickname for ${uid} in ${t}: ${e.message || e}`);
              }
            });
          }
        }
      } catch (e) {
        log(`[ERROR] Error in initCheckLoop for ${t}: ${e.message || e}`);
      }
    }
  } catch (e) {
    log(`[ERROR] initCheckLoop failed: ${e.message || e}`);
  }
}

let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      log(`Attempt login (attempt ${++loginAttempts}) with appstate snippet: ${JSON.stringify(appState.slice(0, 2))}...`);
      api = await new Promise((res, rej) => {
        try {
          const loginOptions = {
            appState,
            forceLogin: true,
            userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            proxy: process.env.PROXY_URL || null
          };
          loginLib(loginOptions, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: false, updatePresence: true });
      log(`Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);
      await notifyBoss(`Bot logged in successfully as ${api.getCurrentUserID()}`);
      loginAttempts = 0;

      await loadLocks();

      setInterval(refreshAppState, APPSTATE_BACKUP_INTERVAL);

      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          try {
            const threadInfo = await safeGetThreadInfo(api, threadID);
            if (!threadInfo) {
              log(`[ERROR] Failed to load thread info for ${threadID}, disabling group`);
              group.enabled = false;
              await saveLocks();
              await notifyBoss(`Disabled group ${threadID} due to access failure`);
              continue;
            }
            if (threadInfo.threadName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
              } else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[threadID] = true;
                try {
                  await changeThreadTitle(api, threadID, group.groupName, 3);
                  log(`[SUCCESS] Reverted group name for ${threadID} to "${group.groupName}"`);
                } catch (e) {
                  log(`[ERROR] Failed to revert group name for ${threadID}: ${e.message || e}`);
                } finally {
                  groupNameChangeDetected[threadID] = null;
                  groupNameRevertInProgress[threadID] = false;
                }
              }
            } else {
              groupNameChangeDetected[threadID] = null;
            }
          } catch (e) {
            log(`[ERROR] Group name check failed for ${threadID}: ${e.message || e}`);
          }
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
            log(`[ERROR] Typing indicator failed for ${id}: ${e.message || e}`);
          }
        }
      }, TYPING_INTERVAL);

      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api), 5 * 60 * 1000);

      api.listenMqtt(async (err, event) => {
        if (err) {
          log(`[ERROR] MQTT error: ${err.message || err}`);
          return;
        }
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
            log(`[DEBUG] Command received: ${body} in ${threadID} (private or group)`);
            if (lc === "/nicklock on") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 3);
                if (!threadInfo) {
                  log(`[ERROR] Failed to load thread info for ${threadID}`);
                  await notifyBoss(`Failed to enable nicklock for ${threadID}: No thread info`);
                  return;
                }
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
                  } catch (e) {
                    log(`[ERROR] Failed to set bot nickname in ${threadID}: ${e.message || e}`);
                  }
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
                    } catch (e) {
                      log(`[ERROR] Failed to set nickname for ${user.id} in ${threadID}: ${e.message || e}`);
                    }
                  });
                }
                await saveLocks();
                log(`[SUCCESS] Nicklock enabled for ${threadID}`);
                await notifyBoss(`Nicklock enabled for thread ${threadID}`);
              } catch (e) {
                log(`[ERROR] /nicklock on failed for ${threadID}: ${e.message || e}`);
                await notifyBoss(`Failed to enable nicklock for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc === "/nicklock off" || body === "/nicklock off") {
              if (groupLocks[threadID]) {
                groupLocks[threadID].enabled = false;
                await saveLocks();
                log(`[SUCCESS] Nicklock disabled for ${threadID}`);
                await notifyBoss(`Nicklock disabled for thread ${threadID}`);
              }
            }
            if (lc === "/nickall" || body === "/nickall") {
              const data = groupLocks[threadID];
              if (!data?.enabled) return;
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 3);
                if (!threadInfo) {
                  log(`[ERROR] Failed to load thread info for ${threadID}`);
                  await notifyBoss(`Failed to apply nickall for ${threadID}: No thread info`);
                  return;
                }
                queueTask(threadID, async () => {
                  try {
                    await new Promise((res, rej) => api.changeNickname(data.nick || DEFAULT_NICKNAME, threadID, BOSS_UID, (err) => (err ? rej(err) : res())));
                    await sendGroupMessage(threadID, `Bot nickname reapplied to ${data.nick || DEFAULT_NICKNAME}`, true);
                    await sleep(getDynamicDelay(data.count || 0));
                  } catch (e) {
                    log(`[ERROR] Failed to reapply bot nickname in ${threadID}: ${e.message || e}`);
                  }
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
                    } catch (e) {
                      log(`[ERROR] Failed to reapply nickname for ${user.id} in ${threadID}: ${e.message || e}`);
                    }
                  });
                }
                await saveLocks();
                log(`[SUCCESS] Nickall applied for ${threadID}`);
                await notifyBoss(`Nickall applied for thread ${threadID}`);
              } catch (e) {
                log(`[ERROR] /nickall failed for ${threadID}: ${e.message || e}`);
                await notifyBoss(`Failed to apply nickall for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc.startsWith("/gclock ")) {
              const customName = body.slice(8).trim();
              if (!customName) {
                log(`[DEBUG] /gclock with empty name for ${threadID}`);
                await notifyBoss(`Failed to set group name for ${threadID}: Empty name`);
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
                await notifyBoss(`Group name locked to "${customName}" for thread ${threadID}`);
              } catch (e) {
                log(`[ERROR] Failed to set group name for ${threadID}: ${e.message || e}`);
                await notifyBoss(`Failed to set group name for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc === "/gclock") {
              try {
                const threadInfo = await safeGetThreadInfo(api, threadID, 3);
                if (!threadInfo) {
                  log(`[ERROR] Failed to load thread info for ${threadID}`);
                  await notifyBoss(`Failed to lock group name for ${threadID}: No thread info`);
                  return;
                }
                groupLocks[threadID] = groupLocks[threadID] || {};
                groupLocks[threadID].groupName = threadInfo.threadName;
                groupLocks[threadID].gclock = true;
                log(`[DEBUG] Attempting to lock ${threadID} to "${threadInfo.threadName}"`);
                await changeThreadTitle(api, threadID, threadInfo.threadName);
                await saveLocks();
                log(`[SUCCESS] Locked ${threadID} to "${threadInfo.threadName}"`);
                await notifyBoss(`Group name locked to "${threadInfo.threadName}" for thread ${threadID}`);
              } catch (e) {
                log(`[ERROR] /gclock failed for ${threadID}: ${e.message || e}`);
                await notifyBoss(`Failed to lock group name for ${threadID}: ${e.message || e}`);
              }
            }
            if (lc === "/unlockgname") {
              if (groupLocks[threadID]) {
                delete groupLocks[threadID].gclock;
                await saveLocks();
                log(`[SUCCESS] Unlocked ${threadID}`);
                await notifyBoss(`Group name unlocked for thread ${threadID}`);
              }
            }
          }

          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick || DEFAULT_NICKNAME;

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
                } catch (e) {
                  log(`[ERROR] Failed to revert nickname for ${uid} in ${threadID}: ${e.message || e}`);
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
                const threadInfo = await safeGetThreadInfo(api, event.threadID, 3);
                if (!threadInfo) {
                  log(`[ERROR] Failed to load thread info for ${event.threadID}`);
                  await notifyBoss(`Failed to process new thread ${event.threadID}: No thread info`);
                  return;
                }
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
                    } catch (e) {
                      log(`[ERROR] Failed to set nickname for ${u.id} in ${event.threadID}: ${e.message || e}`);
                    }
                  });
                }
                await saveLocks();
              } catch (e) {
                log(`[ERROR] Failed to handle new thread ${event.threadID}: ${e.message || e}`);
                await notifyBoss(`Failed to handle new thread ${event.threadID}: ${e.message || e}`);
              }
            }
          }

        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          log(`[ERROR] MQTT event handling failed: ${e.message || e}`);
        }
      });

      loginAttempts = 0;
      break;
    } catch (e) {
      log(`[ERROR] Login failed: ${e.message || e}`);
      await notifyBoss(`Bot login failed: ${e.message || e}`);
      if (e.message.includes("userID") || e.message.includes("not logged in") || e.message.includes("not available")) {
        log(`[ERROR] Session invalid or group access issue, pausing for 30 minutes before retry`);
        await sleep(30 * 60 * 1000);
      }
      const backoff = Math.min(180, (loginAttempts + 1) * 15); // Increased to max 3 minutes
      await sleep(backoff * 1000);
    }
  }
}

loginAndRun().catch((e) => {
  log(`[FATAL] Bot crashed: ${e.message || e}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log(`[ERROR] Uncaught exception: ${err.message || err}`);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch(_){}
  setTimeout(() => loginAndRun(), 10000);
});
process.on("unhandledRejection", (reason) => {
  log(`[ERROR] Unhandled rejection: ${reason}`);
  setTimeout(() => loginAndRun(), 10000);
});

async function gracefulExit() {
  shuttingDown = true;
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  log("Bot shutting down gracefully.");
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
