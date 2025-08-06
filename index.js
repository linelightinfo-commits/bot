const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs").promises;
const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => console.log(`🌐 Bot server started on port ${PORT}`));

// फाइल्स को रेपो की रूट से पढ़ो
const configPath = path.join(__dirname, "config.json");
const dataFile = path.join(__dirname, "groupData.json");
const EXEMPT_ADMINS = (process.env.EXEMPT_ADMINS || "").split(",").map(id => id.trim());
const NOTIFY_UID = process.env.NOTIFY_UID || "61578666851540";

// पर्यावरण सेटिंग्स
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 45000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 10000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 12000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 300000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 600000;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY) || 600000;

let groupLocks = {};
let nicknameQueue = [];
let groupConfigs = {};

async function loadConfigs() {
  try {
    if (await fs.access(configPath).then(() => true).catch(() => false)) {
      groupConfigs = JSON.parse(await fs.readFile(configPath, "utf8"));
      console.log("🔁 Loaded group configs from config.json.");
    }
  } catch (e) {
    console.error("❌ Failed to load config.json", e);
  }
}

async function saveConfigs() {
  try {
    const tempPath = `${configPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(groupConfigs, null, 2));
    await fs.rename(tempPath, configPath);
    console.log("💾 Group configs saved.");
  } catch (e) {
    console.error("❌ Failed to save config.json", e);
  }
}

async function loadLocks() {
  try {
    if (await fs.access(dataFile).then(() => true).catch(() => false)) {
      groupLocks = JSON.parse(await fs.readFile(dataFile, "utf8"));
      console.log("🔁 Loaded saved group locks.");
    }
  } catch (e) {
    console.error("❌ Failed to load groupData.json", e);
  }
}

async function saveLocks() {
  try {
    const tempPath = `${dataFile}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(groupLocks, null, 2));
    await fs.rename(tempPath, dataFile);
    console.log("💾 Group locks saved.");
  } catch (e) {
    console.error("❌ Failed to save groupData.json", e);
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

async function processNicknameQueue(api) {
  while (nicknameQueue.length > 0) {
    const { threadID, userID, nickname, retries = 0 } = nicknameQueue[0];
    const group = groupLocks[threadID];
    if (!group || group.cooldown || !groupConfigs[threadID]?.nickLock) {
      nicknameQueue.shift();
      continue;
    }

    try {
      await new Promise((resolve, reject) => {
        api.changeNickname(nickname, threadID, userID, (err) => (err ? reject(err) : resolve()));
      });
      group.count++;
      console.log(`[${timestamp()}] [NICKLOCK] Reverted nickname for ${userID} in ${threadID}`);
      if (group.count >= NICKNAME_CHANGE_LIMIT) {
        console.log(`[${timestamp()}] [COOLDOWN] Triggered for ${threadID}`);
        group.cooldown = true;
        setTimeout(() => {
          group.cooldown = false;
          group.count = 0;
          console.log(`[${timestamp()}] [COOLDOWN] Lifted for ${threadID}`);
        }, NICKNAME_COOLDOWN);
      }
      nicknameQueue.shift();
      await delay(randomDelay());
    } catch (e) {
      console.warn(`[${timestamp()}] ❌ Nick revert error for ${userID} in ${threadID}:`, e?.message || e);
      if (e?.error === 3252001 && retries < 3) {
        console.log(`[${timestamp()}] [BLOCKED] Temporarily blocked. Retrying in ${RETRY_DELAY / 1000} seconds for ${userID} in ${threadID}`);
        try {
          await api.sendMessage(
            `⚠️ Bot temporarily blocked (3252001) in group ${threadID}. Retrying in ${RETRY_DELAY / 1000} seconds.`,
            NOTIFY_UID
          );
          console.log(`[${timestamp()}] [NOTIFY] Sent blocking notification to ${NOTIFY_UID}`);
        } catch (notifyErr) {
          console.error(`[${timestamp()}] ❌ Failed to send blocking notification:`, notifyErr);
        }
        nicknameQueue[0].retries = (retries || 0) + 1;
        await delay(RETRY_DELAY);
      } else {
        nicknameQueue.shift();
      }
    }
  }
}

async function initializeGroupLocks(api, threadID) {
  try {
    const config = groupConfigs[threadID] || {
      groupName: process.env.DEFAULT_GROUP_NAME || "🙄🤔🙄🤔🙄🤔",
      nickname: process.env.DEFAULT_NICKNAME || "😈😈 ᴢᴀʟɪᴍ࿐ʟᴀᴅᴋᴀ",
      groupLock: true,
      nickLock: false
    };
    groupLocks[threadID] = {
      enabled: config.nickLock,
      nick: config.nickname,
      groupName: config.groupName,
      gclock: config.groupLock,
      original: {},
      count: 0,
      cooldown: false,
    };
    // ग्रुप नेम लॉक
    if (config.groupLock) {
      try {
        await new Promise((resolve, reject) => {
          api.sendMessage(`/settitle ${config.groupName}`, threadID, (err) => (err ? reject(err) : resolve()));
        });
        console.log(`[${timestamp()}] [GCLOCK] Initialized group name to '${config.groupName}' for ${threadID}`);
      } catch (e) {
        if (e?.error === 1357031) {
          console.warn(`[${timestamp()}] [GCLOCK] Group ${threadID} not accessible (1357031). Skipping.`);
          delete groupConfigs[threadID];
          delete groupLocks[threadID];
          await saveConfigs();
          await saveLocks();
        } else {
          console.error(`[${timestamp()}] [GCLOCK] Error setting group name for ${threadID}:`, e);
        }
      }
    }
    // निकनेम लॉक (ऑफ)
    if (config.nickLock) {
      const info = await new Promise((resolve, reject) => {
        api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
      });
      for (const user of info.userInfo) {
        if (!EXEMPT_ADMINS.includes(user.id)) {
          groupLocks[threadID].original[user.id] = config.nickname;
          nicknameQueue.push({ threadID, userID: user.id, nickname: config.nickname, retries: 0 });
        }
      }
      console.log(`[${timestamp()}] [NICKLOCK] Initialized for ${threadID}`);
    }
    await saveLocks();
    await saveConfigs();
  } catch (e) {
    console.error(`[${timestamp()}] ❌ Error initializing locks for ${threadID}:`, e);
  }
}

async function main() {
  // appstate को Environment Variable से पढ़ो
  let appState;
  try {
    appState = JSON.parse(process.env.APPSTATE_JSON || '[]');
    if (!appState || appState.length === 0) {
      console.error("❌ APPSTATE_JSON is empty or invalid! Exiting.");
      process.exit(1);
    }
  } catch (e) {
    console.error("❌ Cannot parse APPSTATE_JSON! Exiting.", e);
    process.exit(1);
  }

  // लॉगिन
  let api;
  try {
    api = await new Promise((resolve, reject) => {
      login(
        { appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" },
        (err, api) => (err ? reject(err) : resolve(api))
      );
    });
    api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
    console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);
  } catch (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }

  await loadConfigs();
  await loadLocks();

  // टारगेट ग्रुप्स के लिए लॉक्स इनिशियलाइज़ करो
  const targetGroups = Object.keys(groupConfigs);
  for (const threadID of targetGroups) {
    if (threadID) await initializeGroupLocks(api, threadID);
  }

  // निकनेम क्यू प्रोसेसर
  setInterval(() => processNicknameQueue(api), 1000);

  // ग्रुप नेम लॉक लूप
  setInterval(async () => {
    for (const threadID in groupLocks) {
      const group = groupLocks[threadID];
      if (!group || !group.gclock) continue;
      try {
        const info = await new Promise((resolve, reject) => {
          api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
        });
        if (info && info.threadName !== group.groupName) {
          await new Promise((resolve, reject) => {
            api.sendMessage(`/settitle ${group.groupName}`, threadID, (err) => (err ? reject(err) : resolve()));
          });
          console.log(`[${timestamp()}] [GCLOCK] Reverted group name for ${threadID}`);
        }
      } catch (e) {
        console.warn(`[${timestamp()}] [GCLOCK] Group name check error for ${threadID}:`, e?.message || e);
        if (e?.error === 1357031) {
          console.warn(`[${timestamp()}] [GCLOCK] Group ${threadID} not accessible (1357031). Skipping.`);
          delete groupConfigs[threadID];
          delete groupLocks[threadID];
          await saveConfigs();
          await saveLocks();
        }
      }
    }
  }, GROUP_NAME_CHECK_INTERVAL);

  // एंटी-स्लीप
  setInterval(async () => {
    for (const id of Object.keys(groupLocks)) {
      try {
        await api.sendTypingIndicator(id, true);
        await delay(1500);
        await api.sendTypingIndicator(id, false);
      } catch (e) {
        console.warn(`[${timestamp()}] Typing error in thread ${id}:`, e?.message || e);
      }
    }
    console.log(`[${timestamp()}] 💤 Anti-sleep triggered.`);
  }, TYPING_INTERVAL);

  // appstate बैकअप
  setInterval(async () => {
    try {
      process.env.APPSTATE_JSON = JSON.stringify(api.getAppState(), null, 2);
      console.log(`[${timestamp()}] 💾 Appstate backed up to APPSTATE_JSON.`);
    } catch (e) {
      console.error(`[${timestamp()}] ❌ Appstate backup error:`, e);
    }
  }, APPSTATE_BACKUP_INTERVAL);

  // इवेंट लिसनर
  api.listenMqtt(async (err, event) => {
    if (err) return console.error(`[${timestamp()}] ❌ Event error:`, err);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const group = groupLocks[threadID];
    const body = (event.body || "").toLowerCase();

    // लॉक/अनलॉक कमांड्स
    if (event.type === "message" && EXEMPT_ADMINS.includes(senderID)) {
      if (body === "/lock") {
        if (groupConfigs[threadID]) {
          groupConfigs[threadID].groupLock = true;
          groupConfigs[threadID].nickLock = false;
          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].gclock = true;
          groupLocks[threadID].enabled = false;
          await initializeGroupLocks(api, threadID);
          await api.sendMessage(`🔒 Group ${threadID} locked (group name only).`, threadID);
          console.log(`[${timestamp()}] [LOCK] Enabled for ${threadID}`);
        }
      } else if (body === "/unlock") {
        if (groupConfigs[threadID]) {
          groupConfigs[threadID].groupLock = false;
          groupConfigs[threadID].nickLock = false;
          if (groupLocks[threadID]) {
            groupLocks[threadID].gclock = false;
            groupLocks[threadID].enabled = false;
          }
          await saveConfigs();
          await saveLocks();
          await api.sendMessage(`🔓 Group ${threadID} unlocked (group name & nicknames).`, threadID);
          console.log(`[${timestamp()}] [UNLOCK] Disabled for ${threadID}`);
        }
      }
    }

    // निकनेम चेंज हैंडलर (ऑफ)
    if (event.logMessageType === "log:user-nickname" && group && group.enabled && groupConfigs[threadID]?.nickLock) {
      const uid = event.logMessageData.participant_id;
      if (EXEMPT_ADMINS.includes(uid)) return;
      const currentNick = event.logMessageData.nickname;
      const lockedNick = group.original[uid];

      if (lockedNick && currentNick !== lockedNick) {
        nicknameQueue.push({ threadID, userID: uid, nickname: lockedNick, retries: 0 });
        console.log(`[${timestamp()}] [NICKLOCK] Queued nickname revert for ${uid} in ${threadID}`);
      }
    }
  });

  // ग्रेसफुल एक्ज़िट
  const gracefulExit = async () => {
    console.log("\nSaving appstate and group data before exit...");
    try {
      await saveLocks();
      await saveConfigs();
    } catch (e) {
      console.error("Exit save error:", e);
    }
    process.exit(0);
  };

  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}

main().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
