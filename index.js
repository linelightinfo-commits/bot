const login = require("ws3-fca");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config(); // Load environment variables

const groupDataPath = path.join(process.env.DATA_DIR || __dirname, "groupData.json");
const appStatePath = path.join(process.env.DATA_DIR || __dirname, "appstate.json");
let groupData = {};

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 45 * 1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 4000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 5000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;
const ALLOWED_SENDER = process.env.ALLOWED_SENDER || "61578631626802";

// Load appstate
async function loadAppState() {
  try {
    return JSON.parse(await fs.readFile(appStatePath, "utf8"));
  } catch (e) {
    console.error("❌ Cannot read appstate.json! Exiting.", e);
    process.exit(1);
  }
}

// Load group data
async function loadGroupData() {
  try {
    if (await fs.access(groupDataPath).then(() => true).catch(() => false)) {
      groupData = JSON.parse(await fs.readFile(groupDataPath, "utf8"));
    } else {
      groupData = {};
    }
  } catch (e) {
    console.warn("⚠️ Could not read groupData.json, starting fresh.", e);
    groupData = {};
  }
}

// Save group data (atomic write)
async function saveGroupData() {
  try {
    const tempPath = `${groupDataPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(groupData, null, 2));
    await fs.rename(tempPath, groupDataPath);
  } catch (e) {
    console.error(`[${timestamp()}] ⚠️ Error saving groupData.json:`, e);
  }
}

// Sanitize input
function sanitizeInput(str) {
  return String(str)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\w\s.,\-()!?:]/gi, "")
    .trim()
    .substring(0, 100);
}

// Utility delay
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}

function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}

// Promisify API methods
function promisifyApiMethod(method) {
  return (...args) =>
    new Promise((resolve, reject) => {
      method(...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

// Main logic
async function main() {
  const appState = await loadAppState();
  let api;

  try {
    api = await new Promise((resolve, reject) => {
      login({ appState }, (err, api) => (err ? reject(err) : resolve(api)));
    });
    console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);
  } catch (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }

  await loadGroupData();

  const groupLocks = {};
  for (const [threadID, data] of Object.entries(groupData)) {
    if (data.groupName) {
      groupLocks[threadID] = {
        groupName: data.groupName,
        nicknames: data.nicknames || {},
        lastNickChange: 0,
        nickChangeCount: 0,
      };
    }
  }

  // Promisified API methods
  const getThreadInfo = promisifyApiMethod(api.getThreadInfo.bind(api));
  const setTitle = promisifyApiMethod(api.setTitle.bind(api));
  const setNickname = promisifyApiMethod(api.setNickname.bind(api));
  const getUserInfo = promisifyApiMethod(api.getUserInfo.bind(api));

  // Anti-sleep
  const antiSleepInterval = setInterval(async () => {
    for (const threadID in groupLocks) {
      try {
        await api.sendTypingIndicator(threadID);
      } catch (e) {
        console.warn(`[${timestamp()}] Typing error in thread ${threadID}:`, e.message || e);
      }
    }
  }, TYPING_INTERVAL);

  // Appstate backup
  const appstateBackupInt = setInterval(async () => {
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState()));
      console.log(`[${timestamp()}] 💾 Appstate backed up`);
    } catch (e) {
      console.error(`[${timestamp()}] Appstate backup error:`, e);
    }
  }, APPSTATE_BACKUP_INTERVAL);

  // Group name lock loop
  const groupNameInt = setInterval(async () => {
    for (const threadID in groupLocks) {
      try {
        const info = await getThreadInfo(threadID);
        if (info && info.name !== groupLocks[threadID].groupName) {
          const cleanName = sanitizeInput(groupLocks[threadID].groupName);
          await setTitle(cleanName, threadID);
          console.log(`[${timestamp()}] ⛔ Group name reverted in ${threadID}`);
        }
      } catch (e) {
        console.warn(`[${timestamp()}] Error reverting name for ${threadID}:`, e.message || e);
      }
    }
  }, GROUP_NAME_CHECK_INTERVAL);

  // Nickname lock loop
  async function runNicknameLock() {
    for (const threadID in groupLocks) {
      const data = groupLocks[threadID];
      const members = Object.entries(data.nicknames || {});
      for (let [uid, desiredNick] of members) {
        try {
          const info = await getUserInfo([uid]);
          if (!info || !info[uid]) continue;
          const currentNick = info[uid].nickname || "";
          const safeNick = sanitizeInput(desiredNick);
          if (currentNick !== safeNick) {
            await wait(randomDelay());
            await setNickname(safeNick, threadID, uid);
            data.nickChangeCount++;
            data.lastNickChange = Date.now();
            console.log(`[${timestamp()}] 🔁 Nickname reverted in ${threadID} for ${uid}`);
            if (data.nickChangeCount >= NICKNAME_CHANGE_LIMIT) {
              console.log(`[${timestamp()}] ⏸ Cooldown after ${NICKNAME_CHANGE_LIMIT} changes in ${threadID}`);
              await wait(NICKNAME_COOLDOWN);
              data.nickChangeCount = 0;
            }
          }
        } catch (e) {
          console.warn(`[${timestamp()}] Nickname revert error for ${uid} in ${threadID}:`, e.message || e);
        }
      }
    }
    setTimeout(runNicknameLock, randomDelay());
  }
  runNicknameLock();

  // Command handler
  api.listenMqtt(async (err, event) => {
    if (err || !event.body || !event.senderID || event.senderID !== ALLOWED_SENDER) return;
    const { threadID, body } = event;

    if (body.startsWith("/nicklock on")) {
      try {
        const thread = await getThreadInfo(threadID);
        const nicknames = {};
        thread.userInfo.forEach((u) => {
          if (u.id !== api.getCurrentUserID()) {
            nicknames[u.id] = sanitizeInput(u.nickname || "");
          }
        });
        groupLocks[threadID] = {
          groupName: sanitizeInput(thread.name),
          nicknames,
          lastNickChange: 0,
          nickChangeCount: 0,
        };
        groupData[threadID] = { groupName: sanitizeInput(thread.name), nicknames };
        await saveGroupData();
        console.log(`[${timestamp()}] ✅ Nickname lock enabled for ${threadID}`);
      } catch (e) {
        console.error(`[${timestamp()}] Nicklock error:`, e);
      }
    }

    if (body.startsWith("/gclock ")) {
      const customName = sanitizeInput(body.replace("/gclock ", "").trim());
      if (!customName) return;
      if (!groupLocks[threadID]) groupLocks[threadID] = {};
      groupLocks[threadID].groupName = customName;
      groupData[threadID] = groupData[threadID] || {};
      groupData[threadID].groupName = customName;
      await saveGroupData();
      try {
        await setTitle(customName, threadID);
        console.log(`[${timestamp()}] ✅ Group name locked to "${customName}" in ${threadID}`);
      } catch (e) {
        console.warn(`[${timestamp()}] Error setting group name:`, e.message || e);
      }
    }
  });

  // Graceful exit
  const gracefulExit = async () => {
    console.log("\nSaving appstate and group data before exit...");
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState()));
      await saveGroupData();
    } catch (e) {
      console.error("Exit save error:", e);
    }
    clearInterval(antiSleepInterval);
    clearInterval(appstateBackupInt);
    clearInterval(groupNameInt);
    process.exit(0);
  };

  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}

main().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
