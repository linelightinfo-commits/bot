const login = require("ws3-fca");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");

const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = {};

const groupNameCheckInterval = 45 * 1000;
const nicknameDelayMin = 4000;
const nicknameDelayMax = 5000;
const nicknameChangeLimit = 60;
const nicknameCooldown = 180000;
const typingInterval = 5 * 60 * 1000;
const appstateBackupInterval = 10 * 60 * 1000;

// Securely load appstate
let appState;
try {
  appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));
} catch (e) {
  console.error("❌ Cannot read appstate.json! Exiting.");
  process.exit(1);
}

// Load group data async
async function loadGroupData() {
  try {
    if (fs.existsSync(groupDataPath)) {
      const data = await fsPromises.readFile(groupDataPath, "utf8");
      groupData = JSON.parse(data);
    } else {
      groupData = {};
    }
  } catch (e) {
    console.warn("⚠️ Could not read groupData.json, starting fresh.", e);
    groupData = {};
  }
}

// Save group data async (atomic write)
async function saveGroupData() {
  try {
    const tempPath = groupDataPath + ".tmp";
    await fsPromises.writeFile(tempPath, JSON.stringify(groupData, null, 2));
    await fsPromises.rename(tempPath, groupDataPath);
  } catch (e) {
    console.error(`[${timestamp()}] ⚠️ Error saving groupData.json:`, e);
  }
}

// Sanitize group/nick names
function sanitizeInput(str) {
  return String(str).replace(/[\r\n\t]/g, " ").replace(/[^\w\s.,\-()!?:]/gi, '').trim().substring(0, 100);
}

// Utility delay
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (nicknameDelayMax - nicknameDelayMin + 1)) + nicknameDelayMin;
}

function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}

// Main logic after login
login({ appState }, async (err, api) => {
  if (err) return console.error("❌ Login failed:", err);
  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);

  // Load groupData
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

  // Anti-sleep
  const antiSleepInterval = setInterval(() => {
    for (const threadID in groupLocks) {
      api.sendTypingIndicator(threadID).catch((e) => {
        console.warn(`[${timestamp()}] Typing error in thread ${threadID}:`, e?.message || e);
      });
    }
  }, typingInterval);

  // Appstate backup
  const appstateBackupInt = setInterval(() => {
    try {
      fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState()));
      console.log(`[${timestamp()}] 💾 Appstate backed up`);
    } catch (e) {
      console.error(`[${timestamp()}] Appstate backup error:`, e);
    }
  }, appstateBackupInterval);

  // Group name lock loop
  const groupNameInt = setInterval(() => {
    for (const threadID in groupLocks) {
      api.getThreadInfo(threadID, (err, info) => {
        if (err) return console.error(`[${timestamp()}] getThreadInfo error:`, err);
        if (info && info.name !== groupLocks[threadID].groupName) {
          const cleanName = sanitizeInput(groupLocks[threadID].groupName);
          api.setTitle(cleanName, threadID, (err) => {
            if (!err) {
              console.log(`[${timestamp()}] ⛔ Group name reverted in ${threadID}`);
            } else {
              console.warn(`[${timestamp()}] Error reverting name for ${threadID}:`, err?.message || err);
            }
          });
        }
      });
    }
  }, groupNameCheckInterval);

  // Nickname lock loop
  async function runNicknameLock() {
    for (const threadID in groupLocks) {
      const data = groupLocks[threadID];
      const members = Object.entries(data.nicknames || {});
      for (let [uid, desiredNick] of members) {
        try {
          const info = await api.getUserInfo(uid);
          if (!info || !info[uid]) continue;
          const currentNick = info[uid].nickname || "";
          const safeNick = sanitizeInput(desiredNick);
          if (currentNick !== safeNick) {
            await wait(randomDelay());
            await api.setNickname(safeNick, threadID, uid);
            data.nickChangeCount++;
            data.lastNickChange = Date.now();
            console.log(`[${timestamp()}] 🔁 Nickname reverted in ${threadID} for ${uid}`);
            if (data.nickChangeCount >= nicknameChangeLimit) {
              console.log(`[${timestamp()}] ⏸ Cooldown after 60 changes in ${threadID}`);
              await wait(nicknameCooldown);
              data.nickChangeCount = 0;
            }
          }
        } catch (e) {
          console.warn(`[${timestamp()}] Nickname revert error for ${uid} in ${threadID}: ${e?.message || e}`);
        }
      }
    }
    setTimeout(runNicknameLock, randomDelay());
  }
  runNicknameLock();

  // Command handler (only from allowed ID!)
  const allowedSender = "61578631626802";

  api.listenMqtt(async (err, event) => {
    if (err || !event.body || !event.senderID || event.senderID !== allowedSender) return;
    const { threadID, body } = event;

    // Enable nickname lock
    if (body.startsWith("/nicklock on")) {
      try {
        const thread = await api.getThreadInfo(threadID);
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

    // Group name lock
    if (body.startsWith("/gclock ")) {
      const customName = sanitizeInput(body.replace("/gclock ", "").trim());
      if (!customName) return;
      if (!groupLocks[threadID]) groupLocks[threadID] = {};
      groupLocks[threadID].groupName = customName;
      groupData[threadID] = groupData[threadID] || {};
      groupData[threadID].groupName = customName;
      await saveGroupData();
      api.setTitle(customName, threadID, err => {
        if (err) {
          console.warn(`[${timestamp()}] Error setting group name:`, err.message || err);
        }
      });
      console.log(`[${timestamp()}] ✅ Group name locked to "${customName}" in ${threadID}`);
    }
  });

  // Safe exit: Save state and clear intervals
  const gracefulExit = async () => {
    console.log("\nSaving appstate and group data before exit...");
    try {
      fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState()));
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
});
