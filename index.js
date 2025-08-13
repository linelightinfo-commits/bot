const fs = require("fs").promises;
const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const GROUP_NAME_CHECK_INTERVAL = 20 * 1000; // 20 seconds
const NICKNAME_CHECK_INTERVAL = 6 * 1000; // 6 seconds
const TYPING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const BOSS_UID = process.env.BOSS_UID || "61578666851540";
const appState = process.env.APPSTATE ? JSON.parse(process.env.APPSTATE) : null;

const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(process.env.PORT || 10000, () => console.log(`[${timestamp()}] 🌐 Server started on port ${process.env.PORT || 10000}`));

const groupLocks = {};
let api;

function timestamp() {
  return new Date().toLocaleTimeString();
}
function info(...args) {
  console.log(`[INFO] [${timestamp()}]`, ...args);
}
function warn(...args) {
  console.warn(`[WARN] [${timestamp()}]`, ...args);
}
function error(...args) {
  console.error(`[ERR] [${timestamp()}]`, ...args);
}

async function loadGroupData() {
  try {
    const data = await fs.readFile("groupData.json", "utf8");
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid groupData.json format");
    Object.assign(groupLocks, parsed);
    info("Loaded saved group locks.");
  } catch (e) {
    warn("Failed to load groupData.json:", e.message);
    error("Please ensure groupData.json is valid JSON. Using empty groupLocks.");
    Object.assign(groupLocks, {});
  }
}

async function saveGroupData() {
  try {
    await fs.writeFile("groupData.json", JSON.stringify(groupLocks, null, 2));
    info("Saved group locks.");
  } catch (e) {
    error("Failed to save groupData.json:", e.message);
  }
}

async function safeGetThreadInfo(apiObj, threadID) {
  try {
    const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
    if (!info) {
      warn(`getThreadInfo returned null for ${threadID}`);
      return null;
    }
    return {
      threadName: info.threadName || "",
      participantIDs: info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id) : []),
      nicknames: info.nicknames || {},
      userInfo: info.userInfo || []
    };
  } catch (e) {
    warn(`getThreadInfo failed for ${threadID}:`, e.message || e);
    if (e.message?.includes("Cannot read properties of undefined")) {
      warn(`Retrying with fca-unofficial for ${threadID}`);
      try {
        const fca = require("fca-unofficial");
        const info = await new Promise((res, rej) => fca.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
        if (!info) {
          warn(`fca-unofficial getThreadInfo returned null for ${threadID}`);
          return null;
        }
        return {
          threadName: info.threadName || "",
          participantIDs: info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id) : []),
          nicknames: info.nicknames || {},
          userInfo: info.userInfo || []
        };
      } catch (e2) {
        warn(`fca-unofficial getThreadInfo failed for ${threadID}:`, e2.message || e2);
        return null;
      }
    }
    return null;
  }
}

async function initCheckLoop() {
  const threads = Object.keys(groupLocks);
  for (const threadID of threads) {
    if (!groupLocks[threadID].enabled) continue;
    const info = await safeGetThreadInfo(api, threadID);
    if (!info) {
      warn(`Skipping ${threadID} due to getThreadInfo failure`);
      continue;
    }
    groupLocks[threadID].original = {
      threadName: info.threadName,
      nicknames: info.nicknames
    };
    info(`Initialized group lock for ${threadID}: ${info.threadName}`);
  }
}

async function checkGroupNames() {
  const threads = Object.keys(groupLocks);
  for (const threadID of threads) {
    if (!groupLocks[threadID].enabled || !groupLocks[threadID].gclock) continue;
    const info = await safeGetThreadInfo(api, threadID);
    if (!info) continue;
    if (info.threadName !== groupLocks[threadID].groupName && !groupLocks[threadID].cooldown) {
      groupLocks[threadID].count++;
      info(`[GCLOCK] Detected change in ${threadID} -> "${info.threadName}". Will revert after 47s.`);
      groupLocks[threadID].cooldown = true;
      setTimeout(async () => {
        try {
          await api.changeGroupName(groupLocks[threadID].groupName, threadID);
          info(`[GCLOCK] Reverted ${threadID} -> "${groupLocks[threadID].groupName}"`);
        } catch (e) {
          error(`[GCLOCK] Failed to revert ${threadID}:`, e.message || e);
        }
        groupLocks[threadID].cooldown = false;
        await saveGroupData();
      }, 47 * 1000);
    }
  }
}

async function checkNicknames() {
  const threads = Object.keys(groupLocks);
  for (const threadID of threads) {
    if (!groupLocks[threadID].enabled || !groupLocks[threadID].gclock) continue;
    const info = await safeGetThreadInfo(api, threadID);
    if (!info) continue;
    for (const userID of info.participantIDs) {
      const currentNick = info.nicknames[userID] || "";
      const lockedNick = groupLocks[threadID].nick || "";
      if (currentNick !== lockedNick) {
        try {
          await api.changeNickname(lockedNick, threadID, userID);
          info(`[NICKLOCK] Reverted ${userID} in ${threadID} to "${lockedNick}"`);
        } catch (e) {
          error(`[NICKLOCK] Failed for ${userID} in ${threadID}:`, e.message || e);
        }
      }
    }
  }
}

async function sendTypingIndicator() {
  const threads = Object.keys(groupLocks);
  for (const threadID of threads) {
    if (!groupLocks[threadID].enabled) continue;
    try {
      await api.sendTypingIndicator(threadID);
      info(`💤 Anti-sleep ping sent to ${threadID}`);
    } catch (e) {
      error(`Failed to send typing indicator to ${threadID}:`, e.message || e);
    }
  }
}

async function loginAndRun() {
  let loginLib;
  try {
    const ws3 = require("ws3-fca");
    loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
    info(`Using ws3-fca`);
  } catch (e) {
    try {
      const fca = require("fca-unofficial");
      loginLib = typeof fca === "function" ? fca : (fca.default || fca.login || fca);
      warn(`ws3-fca failed, using fca-unofficial`);
    } catch (e2) {
      error(`Neither ws3-fca nor fca-unofficial installed. Install one first.`);
      process.exit(1);
    }
  }

  try {
    info(`Attempt login (attempt 1)`);
    api = await new Promise((res, rej) => loginLib({ appState }, (err, api) => (err ? rej(err) : res(api))));
    info(`Logged in as: ${api.getCurrentUserID()}`);
  } catch (e) {
    error(`Login/Run error:`, e.message || e);
    setTimeout(() => loginAndRun().catch(e => error(`[${timestamp()}] relogin failed:`, e.message || e)), 5000);
    return;
  }

  api.listen(async (err, event) => {
    if (err) {
      error(`Listener error:`, err.message || err);
      return;
    }
    if (event.type !== "message" || event.senderID !== BOSS_UID) return;
    const args = event.body.trim().split(/\s+/);
    const command = args[0]?.toLowerCase();
    const threadID = event.threadID;

    try {
      if (!groupLocks[threadID]) groupLocks[threadID] = { enabled: false, gclock: false, count: 0, cooldown: false };
      switch (command) {
        case "/gclock":
          if (args[1]) {
            groupLocks[threadID].groupName = args.slice(1).join(" ");
            groupLocks[threadID].gclock = true;
            groupLocks[threadID].enabled = true;
            await api.changeGroupName(groupLocks[threadID].groupName, threadID);
            info(`[GCLOCK] Locked group name for ${threadID} to "${groupLocks[threadID].groupName}"`);
            await api.sendMessage(`Group name locked to: ${groupLocks[threadID].groupName}`, threadID);
            await saveGroupData();
          } else {
            await api.sendMessage("Please provide a group name: /gclock <name>", threadID);
          }
          break;
        case "/nicklock":
          if (args[1] === "on") {
            groupLocks[threadID].gclock = true;
            groupLocks[threadID].enabled = true;
            info(`[NICKLOCK] Activated for ${threadID}`);
            await api.sendMessage("Nickname lock enabled", threadID);
            await saveGroupData();
          } else if (args[1] === "off") {
            groupLocks[threadID].gclock = false;
            info(`[NICKLOCK] Deactivated for ${threadID}`);
            await api.sendMessage("Nickname lock disabled", threadID);
            await saveGroupData();
          } else {
            await api.sendMessage("Use: /nicklock on|off", threadID);
          }
          break;
        case "/nickall":
          if (args[1]) {
            groupLocks[threadID].nick = args.slice(1).join(" ");
            const info = await safeGetThreadInfo(api, threadID);
            if (info) {
              for (const userID of info.participantIDs) {
                await api.changeNickname(groupLocks[threadID].nick, threadID, userID);
              }
              info(`[REAPPLY] Nicknames reapplied for ${threadID}`);
              await api.sendMessage(`Nicknames set to: ${groupLocks[threadID].nick}`, threadID);
              await saveGroupData();
            }
          } else {
            await api.sendMessage("Please provide a nickname: /nickall <nickname>", threadID);
          }
          break;
        case "/unlockgname":
          groupLocks[threadID].gclock = false;
          groupLocks[threadID].enabled = false;
          info(`[GCLOCK] Unlocked group name for ${threadID}`);
          await api.sendMessage("Group name unlocked", threadID);
          await saveGroupData();
          break;
        default:
          await api.sendMessage("Commands: /gclock <name>, /nicklock on|off, /nickall <nickname>, /unlockgname", threadID);
      }
    } catch (e) {
      error(`Command error in ${threadID}:`, e.message || e);
      await api.sendMessage(`Error: ${e.message || e}`, threadID);
    }
  });

  await initCheckLoop();
  setInterval(checkGroupNames, GROUP_NAME_CHECK_INTERVAL);
  setInterval(checkNicknames, NICKNAME_CHECK_INTERVAL);
  setInterval(sendTypingIndicator, TYPING_INTERVAL);
}

process.on("unhandledRejection", (reason) => {
  warn(`unhandledRejection:`, reason?.message || reason);
  if (reason?.message?.includes("Cannot read properties of undefined")) {
    warn(`Detected getThreadInfo error, avoiding relogin...`);
    return;
  }
  setTimeout(() => loginAndRun().catch(e => error(`[${timestamp()}] relogin after rejection failed:`, e.message || e)), 5000);
});

(async () => {
  await loadGroupData();
  await loginAndRun();
})();
