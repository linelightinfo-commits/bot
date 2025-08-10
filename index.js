// index.js
const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs").promises;
const express = require("express");
const path = require("path");

// load .env if present
require("dotenv").config();

// --- Console styling (simple ANSI) ---
const C = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function log(...args) {
  console.log(C.cyan + "[BOT]" + C.reset, ...args);
}
function info(...args) {
  console.log(C.green + "[INFO]" + C.reset, ...args);
}
function warn(...args) {
  console.log(C.yellow + "[WARN]" + C.reset, ...args);
}
function error(...args) {
  console.log(C.red + "[ERR]" + C.reset, ...args);
}

// --- Express (keep-alive) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// --- Config ---
const BOSS_UID = process.env.BOSS_UID || "61578631626802"; // admin only
const appStatePath = path.join(process.env.DATA_DIR || __dirname, "appstate.json");
const dataFile = path.join(process.env.DATA_DIR || __dirname, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 45 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 45 * 1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000; // 3min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 300000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 600000;

const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// --- State ---
let groupLocks = {};
let groupNameChangeDetected = {}; // threadID -> timestamp
let groupNameRevertInProgress = {}; // threadID -> boolean
let groupQueues = {}; // per-thread nickname queue (to throttle work)
let puppeteerPage = null;
let puppeteerBrowser = null;
let puppeteerAvailable = false;

// --- Helpers ---
async function loadLocks() {
  try {
    if (await fs.access(dataFile).then(() => true).catch(() => false)) {
      groupLocks = JSON.parse(await fs.readFile(dataFile, "utf8"));
      info("Loaded saved group locks.");
    } else {
      groupLocks = {};
    }
  } catch (e) {
    error("Failed to load groupData.json", e.message || e);
    groupLocks = {};
  }
}

async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fs.rename(tmp, dataFile);
    info("Group locks saved.");
  } catch (e) {
    error("Failed to save groupData.json", e.message || e);
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}
function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}

function ensureQueue(threadID) {
  if (!groupQueues[threadID]) {
    groupQueues[threadID] = {
      running: false,
      tasks: [],
    };
  }
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
      await fn();
    } catch (e) {
      warn(`[${timestamp()}] Queue task error for ${threadID}:`, e.message || e);
    }
    // tiny gap to avoid immediate bursts
    await delay(250);
  }
  q.running = false;
}

// --- Puppeteer fallback (optional) ---
async function startPuppeteerIfEnabled() {
  if (!ENABLE_PUPPETEER) {
    info("Puppeteer disabled (ENABLE_PUPPETEER not true). Title fallback will not use UI.");
    return;
  }
  try {
    const puppeteer = require("puppeteer");
    const launchOpts = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };
    if (CHROME_EXECUTABLE) launchOpts.executablePath = CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15");
    await puppeteerPage.goto("https://www.facebook.com", { waitUntil: "networkidle2", timeout: 30000 });
    puppeteerAvailable = true;
    info("Puppeteer ready (UI fallback enabled).");
  } catch (err) {
    puppeteerAvailable = false;
    warn("Puppeteer start failed:", err.message || err);
    warn("If you want Puppeteer fallback working on Render, set ENABLE_PUPPETEER=true and install Chrome (see README).");
  }
}

async function changeGroupTitleViaPuppeteer(threadID, newTitle) {
  if (!puppeteerAvailable || !puppeteerPage) throw new Error("Puppeteer not available");
  // NOTE: Facebook DOM changes frequently. These selectors are best-effort.
  const url = `https://www.facebook.com/messages/t/${threadID}`;
  try {
    await puppeteerPage.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // open conversation info panel (selector may vary)
    await puppeteerPage.waitForTimeout(1000);
    // Try a few selectors for conversation info
    const infoSelectors = [
      'div[aria-label="Conversation information"]',
      'div[aria-label="Conversation Information"]',
      'a[aria-label="Conversation information"]',
      'a[aria-label="Conversation Information"]',
    ];
    let clicked = false;
    for (const sel of infoSelectors) {
      try {
        await puppeteerPage.waitForSelector(sel, { timeout: 3000 });
        await puppeteerPage.click(sel);
        clicked = true;
        break;
      } catch {}
    }
    if (!clicked) {
      warn(`[${timestamp()}] Puppeteer: conversation info button not found (thread ${threadID})`);
      throw new Error("info button not found");
    }
    // wait for name edit — selector may vary (inspect when needed)
    await puppeteerPage.waitForTimeout(1000);
    const nameInputSelectors = [
      'input[aria-label="Edit name"]',
      'input[name="name"]',
      'div[role="dialog"] input',
    ];
    let inputSel = null;
    for (const s of nameInputSelectors) {
      try {
        await puppeteerPage.waitForSelector(s, { timeout: 3000 });
        inputSel = s;
        break;
      } catch {}
    }
    if (!inputSel) {
      warn(`[${timestamp()}] Puppeteer: group name input not found (thread ${threadID})`);
      throw new Error("name input not found");
    }
    await puppeteerPage.evaluate((sel, title) => {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        el.value = "";
      }
    }, inputSel, newTitle);
    await puppeteerPage.type(inputSel, newTitle, { delay: 50 });
    // click Save/Done button (try common aria-labels)
    const saveSelectors = ['div[aria-label="Save"]', 'button[aria-label="Save"]', 'button:has(span:contains("Save"))'];
    for (const s of saveSelectors) {
      try {
        await puppeteerPage.click(s);
        break;
      } catch {}
    }
    await puppeteerPage.waitForTimeout(1500);
    info(`[${timestamp()}] [PUPP] Attempted to change title (${threadID}) -> "${newTitle}"`);
  } catch (err) {
    warn(`[${timestamp()}] Puppeteer title change failed for ${threadID}:`, err.message || err);
    throw err;
  }
}

// unified change title: try API methods, then Puppeteer
async function changeThreadTitle(api, threadID, title) {
  // Try known API methods gracefully
  if (typeof api.setTitle === "function") {
    return new Promise((res, rej) => api.setTitle(title, threadID, (err) => (err ? rej(err) : res())));
  }
  if (typeof api.changeThreadTitle === "function") {
    return new Promise((res, rej) => api.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : res())));
  }
  // else fallback to puppeteer if enabled
  if (ENABLE_PUPPETEER && puppeteerAvailable) {
    return changeGroupTitleViaPuppeteer(threadID, title);
  }
  // else cannot change
  throw new Error("No API method for changing thread title and Puppeteer fallback not available");
}

// --- Main ---
async function main() {
  // start puppeteer only if requested (non-blocking)
  startPuppeteerIfEnabled().catch(e => warn("Puppeteer init error:", e.message || e));

  // Load appstate
  let appState;
  try {
    appState = JSON.parse(await fs.readFile(appStatePath, "utf8"));
  } catch (e) {
    error("Cannot read appstate.json! Exiting.", e.message || e);
    process.exit(1);
  }

  // Login ws3-fca
  let api;
  try {
    api = await new Promise((resolve, reject) => {
      login(
        { appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15" },
        (err, api) => (err ? reject(err) : resolve(api))
      );
    });
    api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
    info(`Logged in as: ${api.getCurrentUserID()}`);
  } catch (err) {
    error("Login failed:", err.message || err);
    process.exit(1);
  }

  await loadLocks();

  // group-name monitoring loop (checks all locked groups every GROUP_NAME_CHECK_INTERVAL)
  setInterval(async () => {
    const threadIDs = Object.keys(groupLocks);
    // limit concurrent threads processed per tick for safety (helps scale to 15+)
    const MAX_PER_TICK = 15;
    for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
      const threadID = threadIDs[i];
      const group = groupLocks[threadID];
      if (!group || !group.gclock) continue;
      if (groupNameRevertInProgress[threadID]) continue;
      try {
        const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
        if (info && info.threadName !== group.groupName) {
          if (!groupNameChangeDetected[threadID]) {
            groupNameChangeDetected[threadID] = Date.now();
            info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID}. Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s if still changed.`);
          } else {
            const elapsed = Date.now() - groupNameChangeDetected[threadID];
            if (elapsed >= GROUP_NAME_REVERT_DELAY) {
              groupNameRevertInProgress[threadID] = true;
              try {
                await changeThreadTitle(api, threadID, group.groupName);
                info(`[${timestamp()}] [GCLOCK] Reverted group name for ${threadID} -> "${group.groupName}"`);
              } catch (e) {
                warn(`[${timestamp()}] [GCLOCK] Failed to revert title for ${threadID}:`, e.message || e);
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

  // Anti-sleep typing indicator
  setInterval(async () => {
    for (const id of Object.keys(groupLocks)) {
      try {
        await api.sendTypingIndicator(id, true);
        await delay(1200);
        await api.sendTypingIndicator(id, false);
      } catch (e) {
        warn(`[${timestamp()}] Typing indicator failed for ${id}:`, e.message || e);
      }
    }
    // info(`[${timestamp()}] Anti-sleep tick.`);
  }, TYPING_INTERVAL);

  // Appstate backup
  setInterval(async () => {
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
      info(`[${timestamp()}] Appstate backed up.`);
    } catch (e) {
      warn(`[${timestamp()}] Appstate backup error:`, e.message || e);
    }
  }, APPSTATE_BACKUP_INTERVAL);

  // Event listener
  api.listenMqtt(async (err, event) => {
    if (err) return error(`[${timestamp()}] Event error:`, err.message || err);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const body = (event.body || "").toLowerCase();

    // Debug event log (minimal)
    // info(`[${timestamp()}] Event: type=${event.type || event.logMessageType} from=${senderID} thread=${threadID} body="${event.body||''}"`);

    // Boss-only commands
    if (event.type === "message" && senderID === BOSS_UID) {
      if (body === "/nicklock on") {
        try {
          const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
          const lockedNick = "😈😈 ᴢᴀʟɪᴍ࿐ʟᴀᴅᴋᴀ";
          groupLocks[threadID] = {
            enabled: true,
            nick: lockedNick,
            original: {},
            count: 0,
            cooldown: false,
            gclock: groupLocks[threadID]?.gclock || false,
            groupName: groupLocks[threadID]?.groupName || null,
          };
          // queue mass changes to avoid bursts
          for (const user of infoThread.userInfo) {
            groupLocks[threadID].original[user.id] = lockedNick;
            queueTask(threadID, async () => {
              try {
                await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? rej(err) : res())));
                info(`[${timestamp()}] Changed nick for ${user.id} in ${threadID}`);
              } catch (e) {
                warn(`[${timestamp()}] changeNickname failed for ${user.id} in ${threadID}:`, e.message || e);
              }
              await delay(randomDelay());
            });
          }
          await saveLocks();
          info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
        } catch (e) {
          error(`[${timestamp()}] Nicklock activation failed:`, e.message || e);
        }
      }

      if (body === "/nicklock off") {
        if (groupLocks[threadID]) {
          groupLocks[threadID].enabled = false;
          await saveLocks();
          info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);
        }
      }

      if (body === "/nickall") {
        const data = groupLocks[threadID];
        if (!data?.enabled) return;
        try {
          const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
          for (const user of infoThread.userInfo) {
            const nick = data.nick;
            groupLocks[threadID].original[user.id] = nick;
            queueTask(threadID, async () => {
              try {
                await new Promise((res, rej) => api.changeNickname(nick, threadID, user.id, (err) => (err ? rej(err) : res())));
                info(`[${timestamp()}] Reapplied nick for ${user.id}`);
              } catch (e) {
                warn(`[${timestamp()}] Nick apply failed for ${user.id}:`, e.message || e);
              }
              await delay(randomDelay());
            });
          }
          await saveLocks();
          info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
        } catch (e) {
          error(`[${timestamp()}] /nickall failed:`, e.message || e);
        }
      }

      if (body.startsWith("/gclock ")) {
        const customName = event.body.slice(8).trim();
        if (!customName) return;
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupName = customName;
        groupLocks[threadID].gclock = true;
        try {
          await changeThreadTitle(api, threadID, customName);
          await saveLocks();
          info(`[${timestamp()}] [GCLOCK] Locked group name to "${customName}" for ${threadID}`);
        } catch (e) {
          warn(`[${timestamp()}] Could not set group name via API/UI:`, e.message || e);
        }
      }

      if (body === "/gclock") {
        try {
          const infoThread = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].groupName = infoThread.threadName;
          groupLocks[threadID].gclock = true;
          await saveLocks();
          info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
        } catch (e) {
          error(`[${timestamp()}] /gclock failed:`, e.message || e);
        }
      }

      if (body === "/unlockgname") {
        if (groupLocks[threadID]) {
          delete groupLocks[threadID].gclock;
          await saveLocks();
          info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`);
        }
      }
    }

    // Nickname revert events
    if (event.logMessageType === "log:user-nickname") {
      const group = groupLocks[threadID];
      if (!group || !group.enabled || group.cooldown) return;

      const uid = event.logMessageData.participant_id;
      const currentNick = event.logMessageData.nickname;
      const lockedNick = group.original[uid];

      if (lockedNick && currentNick !== lockedNick) {
        // queue revert to avoid concurrent reverts
        queueTask(threadID, async () => {
          try {
            await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
            group.count = (group.count || 0) + 1;
            info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
            if (group.count >= NICKNAME_CHANGE_LIMIT) {
              group.cooldown = true;
              warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} hit limit — cooling down ${NICKNAME_COOLDOWN/1000}s`);
              setTimeout(() => {
                group.cooldown = false;
                group.count = 0;
                info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`);
              }, NICKNAME_COOLDOWN);
            } else {
              await delay(randomDelay());
            }
          } catch (e) {
            warn(`[${timestamp()}] Nick revert failed for ${uid} in ${threadID}:`, e.message || e);
          }
        });
      }
    }
  });

  // exit handling
  const gracefulExit = async () => {
    info("Shutting down — saving state...");
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
      await saveLocks();
      if (puppeteerBrowser) await puppeteerBrowser.close();
    } catch (e) {
      warn("Error during shutdown save:", e.message || e);
    }
    process.exit(0);
  };
  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}

main().catch((err) => {
  error("Startup error:", err.message || err);
  process.exit(1);
});
