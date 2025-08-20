/**
 * सुधारी गई index.js स्क्रिप्ट (20+ ग्रुप्स के लिए)
 * - बेहतर त्रुटि हैंडलिंग और लॉगिंग (winston का उपयोग)
 * - प्रॉक्सी वैलिडेशन और बैकअप लॉगिन लॉजिक
 * - सख्त रेट लिमिटिंग (MAX_PER_TICK=1, बढ़ी हुई देरी)
 * - ऑटो-रीकनेक्ट और बैकऑफ में सुधार
 * - अमान्य appstate.json के लिए बैकअप लॉगिन
 * - तटस्थ डिफ़ॉल्ट निकनेम
 * - अप्रयुक्त पपेटीअर कोड हटाया गया
 * - ग्रुप नेम रिवर्ट देरी को 20s से 60s किया गया
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const winston = require("winston");
require("dotenv").config();

// लॉगिंग सेटअप (कंसोल और फ़ाइल दोनों में)
const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" })
  ],
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  )
});

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m" };
function log(type, ...a) {
  const msg = a.join(" ");
  if (type === "ERROR") logger.error(msg);
  else logger.info(msg);
  console.log(`${type === "ERROR" ? C.red : C.green}[BOT]${C.reset}`, ...a);
}

const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.get("/ping", (req, res) => res.send("Pong!"));
app.listen(PORT, () => log("INFO", `Server started on port ${PORT}`));

// कॉन्फ़िगरेशन
const BOSS_UID = process.env.BOSS_UID || "61578666851540"; // आपका यूजर आईडी
const DEFAULT_NICKNAME = process.env.DEFAULT_NICKNAME || "GroupBot"; // तटस्थ निकनेम
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");
const PROXY = process.env.PROXY || null; // .env में प्रॉक्सी (जैसे, http://user:pass@host:port)
const FB_EMAIL = process.env.FB_EMAIL || null; // बैकअप लॉगिन के लिए
const FB_PASSWORD = process.env.FB_PASSWORD || null; // बैकअप लॉगिन के लिए

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 60 * 1000; // 60s
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 5000; // 5s
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 10000; // 10s
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 15000; // 15s
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 20000; // 20s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 5; // कम किया गया
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 30 * 60 * 1000; // 30min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 15 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 4 * 60 * 60 * 1000;
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
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) { globalActiveCount++; return; }
  await new Promise((res) => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() { globalActiveCount = Math.max(0, globalActiveCount - 1); if (globalPending.length) globalPending.shift()(); }

async function ensureDataFile() {
  try { await fsp.access(dataFile); } catch (e) { await fsp.writeFile(dataFile, JSON.stringify({}, null, 2)); }
}

async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt || "{}");
    for (const threadID in groupLocks) {
      if (!groupLocks[threadID].nick) groupLocks[threadID].nick = DEFAULT_NICKNAME;
      if (!groupLocks[threadID].original) groupLocks[threadID].original = {};
      if (!groupLocks[threadID].count) groupLocks[threadID].count = 0;
      if (groupLocks[threadID].enabled === undefined) groupLocks[threadID].enabled = true;
      if (groupLocks[threadID].cooldown === undefined) groupLocks[threadID].cooldown = false;
    }
  } catch (e) { log("ERROR", `Failed to load group locks: ${JSON.stringify(e, null, 2)}`); }
}

async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
  } catch (e) { log("ERROR", `Failed to save group locks: ${JSON.stringify(e, null, 2)}`); }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function getDynamicDelay(count) {
  const cycle = count % 10;
  if (cycle < 3 || cycle >= 7) return Math.floor(Math.random() * (FAST_NICKNAME_DELAY_MAX - FAST_NICKNAME_DELAY_MIN + 1)) + FAST_NICKNAME_DELAY_MIN;
  return Math.floor(Math.random() * (SLOW_NICKNAME_DELAY_MAX - SLOW_NICKNAME_DELAY_MIN + 1)) + SLOW_NICKNAME_DELAY_MIN;
}

async function sendGroupMessage(threadID, message, isBotChange = false) {
  if (isBotChange) log("INFO", `[ACTION] Would send to ${threadID}: ${message}`);
  else {
    const silenceEnd = memberChangeSilence[threadID] || 0;
    if (Date.now() < silenceEnd) return;
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
      try { await fn(); } finally { releaseGlobalSlot(); }
    } catch (e) { log("ERROR", `Queue task failed for ${threadID}: ${JSON.stringify(e, null, 2)}`); }
    await sleep(1000);
  }
  q.running = false;
}

async function safeGetThreadInfo(apiObj, threadID, maxRetries = 10) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
      if (!info || typeof info !== "object") throw new Error("Invalid thread info");
      return {
        threadName: info.threadName || "",
        participantIDs: (info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id || "") : [])).filter(id => id),
        nicknames: info.nicknames || {},
        userInfo: Array.isArray(info.userInfo) ? info.userInfo.filter(u => u && u.id) : []
      };
    } catch (e) {
      retries++;
      log("ERROR", `[DEBUG] Failed to get thread info for ${threadID}, retry ${retries}/${maxRetries}: ${JSON.stringify(e, null, 2)}`);
      if (retries === maxRetries) return null;
      await sleep(10000 * retries);
    }
  }
}

async function changeThreadTitle(apiObj, threadID, title, maxRetries = 7) {
  if (!apiObj) throw new Error("No api");
  let retries = 0;
  while (retries < maxRetries) {
    try {
      if (typeof apiObj.setTitle === "function") await new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
      else if (typeof apiObj.changeThreadTitle === "function") await new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
      else throw new Error("No method to change thread title");
      return;
    } catch (e) {
      retries++;
      log("ERROR", `[DEBUG] Failed to change title for ${threadID}, retry ${retries}/${maxRetries}: ${JSON.stringify(e, null, 2)}`);
      if (retries === maxRetries) throw e;
      await sleep(5000 * retries);
    }
  }
}

async function loadAppState() {
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    const appState = JSON.parse(txt);
    if (!Array.isArray(appState)) throw new Error("Invalid appstate.json: must be an array");
    return appState;
  } catch (e) {
    log("ERROR", `Cannot load appstate.json: ${JSON.stringify(e, null, 2)}`);
    return null;
  }
}

async function refreshAppState() {
  try {
    const newAppState = api.getAppState();
    await fsp.writeFile(appStatePath, JSON.stringify(newAppState, null, 2));
    log("INFO", "Appstate refreshed.");
  } catch (e) { log("ERROR", `Failed to refresh appstate: ${JSON.stringify(e, null, 2)}`); }
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t, 10);
        if (!threadInfo) { log("ERROR", `[ERROR] Failed to load thread info for ${t}`); continue; }
        const botNick = group.original[BOSS_UID] || group.nick || DEFAULT_NICKNAME;
        if (threadInfo.nicknames[BOSS_UID] !== botNick) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(botNick, t, BOSS_UID, (err) => (err ? rej(err) : res())));
              await sendGroupMessage(t, `Bot nickname set to ${botNick}`, true);
              await sleep(getDynamicDelay(group.count || 0));
            } catch (e) { log("ERROR", `[ERROR] Nickname set failed for ${t}: ${JSON.stringify(e, null, 2)}`); }
          });
        }
        for (const uid of threadInfo.participantIDs) {
          const desired = (uid === BOSS_UID) ? (group.original[BOSS_UID] || group.nick || DEFAULT_NICKNAME) : (group.original[uid] || group.nick || DEFAULT_NICKNAME);
          if (!desired) continue;
          const current = threadInfo.nicknames[uid] || (threadInfo.userInfo.find(u => u.id === uid)?.nickname) || null;
          if (current !== desired) {
            queueTask(t, async () => {
              try {
                await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
                await sendGroupMessage(t, `Nickname for ${uid} set to ${desired}`, true);
                group.original[uid] = desired;
                group.count = (group.count || 0) + 1;
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) { log("ERROR", `[ERROR] Nickname set failed for ${uid} in ${t}: ${JSON.stringify(e, null, 2)}`); }
            });
          }
        }
        if (group.gclock && threadInfo.threadName !== group.groupName) {
          queueTask(t, async () => {
            try {
              await changeThreadTitle(apiObj, t, group.groupName, 7);
              log("INFO", `[SUCCESS] Locked ${t} to "${group.groupName}"`);
            } catch (e) { log("ERROR", `[ERROR] Failed to lock group name for ${t}: ${JSON.stringify(e, null, 2)}`); }
          });
        }
      } catch (e) { log("ERROR", `[ERROR] Init check failed for ${t}: ${JSON.stringify(e, null, 2)}`); }
    }
  } catch (e) { log("ERROR", `[ERROR] Init check loop failed: ${JSON.stringify(e, null, 2)}`); }
}

async function validateProxy(proxy) {
  if (!proxy) return true;
  try {
    const { default: fetch } = await import("node-fetch");
    const response = await fetch("https://api.ipify.org", { agent: require("https-proxy-agent")(proxy) });
    if (response.ok) {
      log("INFO", `Proxy validated: ${proxy}`);
      return true;
    }
    return false;
  } catch (e) {
    log("ERROR", `Proxy validation failed: ${JSON.stringify(e, null, 2)}`);
    return false;
  }
}

let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      let appState = await loadAppState();
      loginAttempts++;
      log("INFO", `Attempt login (attempt ${loginAttempts})`);

      // प्रॉक्सी की जाँच
      const proxyValid = await validateProxy(PROXY);
      const loginOptions = proxyValid ? { appState, proxy: PROXY } : { appState };

      // अगर appstate अमान्य है और क्रेडेंशियल उपलब्ध हैं, तो पासवर्ड से लॉगिन करें
      if (!appState && FB_EMAIL && FB_PASSWORD) {
        log("INFO", "Invalid appstate, attempting login with credentials");
        api = await new Promise((res, rej) => {
          loginLib({ email: FB_EMAIL, password: FB_PASSWORD, proxy: PROXY }, (err, a) => (err ? rej(err) : res(a)));
        });
        await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
      } else {
        api = await new Promise((res, rej) => {
          loginLib(loginOptions, (err, a) => (err ? rej(err) : res(a)));
        });
      }

      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      log("INFO", `Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);

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
            if (threadInfo && threadInfo.threadName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) groupNameChangeDetected[threadID] = Date.now();
              else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[threadID] = true;
                try { await changeThreadTitle(api, threadID, group.groupName, 7); } catch (e) {}
                finally {
                  groupNameChangeDetected[threadID] = null;
                  groupNameRevertInProgress[threadID] = false;
                }
              }
            } else groupNameChangeDetected[threadID] = null;
          } catch (e) { log("ERROR", `[ERROR] Group name check failed for ${threadID}: ${JSON.stringify(e, null, 2)}`); }
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
              try { api.removeAllListeners && api.removeAllListeners(); } catch (_) {}
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api), 5 * 60 * 1000);

      api.listenMqtt(async (err, event) => {
        if (err) { log("ERROR", `[ERROR] MQTT error: ${JSON.stringify(err, null, 2)}`); return; }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const eventKey = `${event.logMessageType}_${threadID}_${event.logMessageData?.participant_id || event.logMessageData?.name || ""}`;
          const now = Date.now();

          if (lastEventLog[eventKey] && (now - lastEventLog[eventKey]) < 5000) return;
          lastEventLog[eventKey] = now;

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
                  log("INFO", `🎭 [NICKLOCK] Reverted ${uid} in ${threadID} to "${lockedNick}"`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    setTimeout(() => { group.cooldown = false; group.count = 0; }, NICKNAME_COOLDOWN);
                  }
                  await saveLocks();
                  await sleep(getDynamicDelay(group.count));
                } catch (e) { log("ERROR", `[ERROR] Nickname revert failed for ${uid} in ${threadID}: ${JSON.stringify(e, null, 2)}`); }
                finally { if (memberChangeSilence[threadID] && Date.now() >= memberChangeSilence[threadID]) delete memberChangeSilence[threadID]; }
              });
            }
          }

          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              try {
                const threadInfo = await safeGetThreadInfo(api, event.threadID, 10);
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
                    } catch (e) { log("ERROR", `[ERROR] Nickname set failed for ${u.id} in ${event.threadID}: ${JSON.stringify(e, null, 2)}`); }
                  });
                }
                await saveLocks();
              } catch (e) { log("ERROR", `[ERROR] Event handling failed for ${event.threadID}: ${JSON.stringify(e, null, 2)}`); }
            }
          }
        } catch (e) {
          log("ERROR", `[ERROR] MQTT event error: ${JSON.stringify(e, null, 2)}`);
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
        }
      });

      loginAttempts = 0;
      break;
    } catch (e) {
      log("ERROR", `[ERROR] Login failed: ${JSON.stringify(e, null, 2)}, retrying in ${Math.min(600, (loginAttempts + 1) * 30)}s`);
      await sleep(Math.min(600, (loginAttempts + 1) * 30) * 1000);
    }
  }
}

loginAndRun().catch((e) => {
  log("ERROR", `Fatal error: ${JSON.stringify(e, null, 2)}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch (_) {}
  log("ERROR", `[ERROR] Uncaught exception: ${JSON.stringify(err, null, 2)}, restarting in 15s`);
  setTimeout(() => loginAndRun(), 15000);
});

process.on("unhandledRejection", (reason) => {
  log("ERROR", `[ERROR] Unhandled rejection: ${JSON.stringify(reason, null, 2)}, restarting in 15s`);
  setTimeout(() => loginAndRun(), 15000);
});

async function gracefulExit() {
  shuttingDown = true;
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
