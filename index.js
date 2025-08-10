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

const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const appStatePath = path.join(process.env.DATA_DIR || __dirname, "appstate.json");
const dataFile = path.join(process.env.DATA_DIR || __dirname, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 45 * 1000;
const GROUP_NAME_REVERT_DELAY = 45000; // 45 seconds wait before reverting
const NICKNAME_DELAY_MIN = 6000; // 6 seconds min delay for nickname revert
const NICKNAME_DELAY_MAX = 7000; // 7 seconds max delay for nickname revert
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000; // 3 minutes cooldown after limit
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 300000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 600000;

let groupLocks = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};

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
  return new Promise(res => setTimeout(res, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}

function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}

async function main() {
  // Load appstate
  let appState;
  try {
    appState = JSON.parse(await fs.readFile(appStatePath, "utf8"));
  } catch (e) {
    console.error("❌ Cannot read appstate.json! Exiting.", e);
    process.exit(1);
  }

  // Login
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

  await loadLocks();

  // Group name lock loop with 45 sec delay on revert
  setInterval(async () => {
    for (const threadID in groupLocks) {
      const group = groupLocks[threadID];
      if (!group || !group.gclock) continue;

      if (groupNameRevertInProgress[threadID]) continue;

      try {
        const info = await new Promise((resolve, reject) => {
          api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
        });

        if (info && info.threadName !== group.groupName) {
          if (!groupNameChangeDetected[threadID]) {
            groupNameChangeDetected[threadID] = Date.now();
            console.log(`[${timestamp()}] 🕵️‍♂️ [GCLOCK] Detected group name change in ${threadID}, waiting 45s before revert.`);
          } else {
            const elapsed = Date.now() - groupNameChangeDetected[threadID];
            if (elapsed >= GROUP_NAME_REVERT_DELAY) {
              groupNameRevertInProgress[threadID] = true;
              await new Promise((resolve, reject) => {
                api.setTitle(group.groupName, threadID, (err) => (err ? reject(err) : resolve()));
              });
              console.log(`🎯 [${timestamp()}] [GCLOCK] Reverted group name for ${threadID} to "${group.groupName}"`);
              groupNameChangeDetected[threadID] = null;
              groupNameRevertInProgress[threadID] = false;
            }
          }
        } else {
          groupNameChangeDetected[threadID] = null;
        }
      } catch (e) {
        console.warn(`[${timestamp()}] ⚠️ [GCLOCK] Error in group ${threadID}:`, e?.message || e);
      }
    }
  }, GROUP_NAME_CHECK_INTERVAL);

  // Anti-sleep typing indicator every 5 minutes
  setInterval(async () => {
    for (const id of Object.keys(groupLocks)) {
      try {
        await api.sendTypingIndicator(id, true);
        await delay(1500);
        await api.sendTypingIndicator(id, false);
      } catch (e) {
        console.warn(`[${timestamp()}] ⚠️ Typing error in thread ${id}:`, e?.message || e);
      }
    }
  }, TYPING_INTERVAL);

  // Appstate backup every 10 minutes
  setInterval(async () => {
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
    } catch (e) {
      console.error(`[${timestamp()}] ❌ Appstate backup error:`, e);
    }
  }, APPSTATE_BACKUP_INTERVAL);

  // Event listener for commands and nickname revert
  api.listenMqtt(async (err, event) => {
    if (err) return console.error(`[${timestamp()}] ❌ Event error:`, err);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const body = (event.body || "").toLowerCase();

    // Commands controlled only by admin UID (BOSS_UID)
    if (event.type === "message" && senderID === BOSS_UID) {
      if (body === "/nicklock on") {
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
          const lockedNick = "😈😈 ᴢᴀʟɪᴍ࿐ʟᴀᴅᴋᴀ";
          groupLocks[threadID] = {
            enabled: true,
            nick: lockedNick,
            original: {},
            count: 0,
            cooldown: false,
          };
          for (const user of info.userInfo) {
            groupLocks[threadID].original[user.id] = lockedNick;
            try {
              await new Promise((resolve, reject) => {
                api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? reject(err) : resolve()));
              });
              await delay(randomDelay());
            } catch (e) {
              console.warn(`[${timestamp()}] ❌ Nicklock set error for user ${user.id} in ${threadID}:`, e?.message || e);
            }
          }
          await saveLocks();
          console.log(`🔒 [${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
        } catch (e) {
          console.error(`[${timestamp()}] ❌ Nicklock error:`, e);
        }
      }

      if (body === "/nicklock off") {
        if (groupLocks[threadID]) delete groupLocks[threadID].enabled;
        await saveLocks();
        console.log(`🔓 [${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);
      }

      if (body === "/nickall") {
        const data = groupLocks[threadID];
        if (!data || !data.enabled) return;
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
          for (const user of info.userInfo) {
            const nick = data.nick;
            groupLocks[threadID].original[user.id] = nick;
            try {
              await new Promise((resolve, reject) => {
                api.changeNickname(nick, threadID, user.id, (err) => (err ? reject(err) : resolve()));
              });
              await delay(randomDelay());
            } catch (e) {
              console.warn(`[${timestamp()}] ❌ Nickall set error for user ${user.id} in ${threadID}:`, e?.message || e);
            }
          }
          await saveLocks();
          console.log(`🔄 [${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
        } catch (e) {
          console.error(`[${timestamp()}] ❌ Nickall error:`, e);
        }
      }

      if (body.startsWith("/gclock ")) {
        const customName = event.body.slice(8).trim();
        if (!customName) return;
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupName = customName;
        groupLocks[threadID].gclock = true;
        try {
          await new Promise((resolve, reject) => {
            api.setTitle(customName, threadID, (err) => (err ? reject(err) : resolve()));
          });
          await saveLocks();
          console.log(`🔒 [${timestamp()}] [GCLOCK] Locked group name to '${customName}' for ${threadID}`);
        } catch (e) {
          console.error(`[${timestamp()}] ❌ Group name set error:`, e);
        }
      }

      if (body === "/gclock") {
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].groupName = info.threadName;
          groupLocks[threadID].gclock = true;
          await saveLocks();
          console.log(`🔒 [${timestamp()}] [GCLOCK] Locked current group name for ${threadID}`);
        } catch (e) {
          console.error(`[${timestamp()}] ❌ Gclock error:`, e);
        }
      }

      if (body === "/unlockgname") {
        if (groupLocks[threadID]) delete groupLocks[threadID].gclock;
        await saveLocks();
        console.log(`🔓 [${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`);
      }
    }

    // Nickname revert on nickname change events
    if (event.logMessageType === "log:user-nickname") {
      const group = groupLocks[threadID];
      if (!group || !group.enabled || group.cooldown) return;

      const uid = event.logMessageData.participant_id;
      const currentNick = event.logMessageData.nickname;
      const lockedNick = group.original[uid];

      if (lockedNick && currentNick !== lockedNick) {
        try {
          await new Promise((resolve, reject) => {
            api.changeNickname(lockedNick, threadID, uid, (err) => (err ? reject(err) : resolve()));
          });
          group.count++;
          console.log(`🎭 [${timestamp()}] [NICKLOCK] Reverted nickname for ${uid} in ${threadID}`);

          if (group.count >= NICKNAME_CHANGE_LIMIT) {
            console.log(`⏸️ [${timestamp()}] [COOLDOWN] Nickname revert cooldown started for ${threadID}`);
            group.cooldown = true;
            setTimeout(() => {
              group.cooldown = false;
              group.count = 0;
              console.log(`▶️ [${timestamp()}] [COOLDOWN] Nickname revert cooldown lifted for ${threadID}`);
            }, NICKNAME_COOLDOWN);
          } else {
            await delay(randomDelay());
          }
        } catch (e) {
          console.warn(`[${timestamp()}] ❌ Nick revert error for ${uid} in ${threadID}:`, e?.message || e);
        }
      }
    }
  });

  // Graceful exit
  const gracefulExit = async () => {
    console.log("\n💾 Saving appstate and group data before exit...");
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
      await saveLocks();
    } catch (e) {
      console.error("❌ Exit
