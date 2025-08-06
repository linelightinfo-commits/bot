const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { setTimeout: wait } = require("timers/promises");

dotenv.config();

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));
const groupData = JSON.parse(fs.readFileSync("groupData.json", "utf8"));
const PORT = process.env.PORT || 10000;
const ADMIN_UID = process.env.ADMIN_UID;

const app = express();
app.get("/", (_, res) => res.send("Bot is running."));
app.listen(PORT, () => console.log(`[🌐] Express live on port ${PORT}`));

login({ appState }).then(async (api) => {
  console.log("[✅] Logged in successfully.");

  api.setOptions({ listenEvents: true });

  api.listenMqtt(async () => {
    console.log("[📡] MQTT connected. Starting locks...");
    await initializeGroupLocks(api);
    startAntiSleep(api);
  });

  api.listen(async (err, event) => {
    if (err || !event || event.type !== "message" || !event.body) return;

    const body = event.body.toLowerCase().trim();
    const senderID = event.senderID;

    if (senderID !== ADMIN_UID) return;

    const threadID = event.threadID;

    if (body === "/nicklock on" && groupData[threadID]) {
      groupData[threadID].nicknameLock = true;
      fs.writeFileSync("groupData.json", JSON.stringify(groupData, null, 2));
      console.log(`[🔒] Nickname lock ENABLED for ${threadID}`);
    }

    if (body === "/nicklock off" && groupData[threadID]) {
      groupData[threadID].nicknameLock = false;
      fs.writeFileSync("groupData.json", JSON.stringify(groupData, null, 2));
      console.log(`[🔓] Nickname lock DISABLED for ${threadID}`);
    }

    if (body === "/gclock" && groupData[threadID]) {
      const groupName = event.threadName;
      groupData[threadID].groupName = groupName;
      groupData[threadID].groupNameLock = true;
      fs.writeFileSync("groupData.json", JSON.stringify(groupData, null, 2));
      console.log(`[🔒] Group name locked as "${groupName}" for ${threadID}`);
    }

    if (body === "/unlockgname" && groupData[threadID]) {
      groupData[threadID].groupNameLock = false;
      fs.writeFileSync("groupData.json", JSON.stringify(groupData, null, 2));
      console.log(`[🔓] Group name lock disabled for ${threadID}`);
    }
  });
});

async function initializeGroupLocks(api) {
  for (const threadID of Object.keys(groupData)) {
    const group = groupData[threadID];

    // Nickname lock
    if (group.nicknameLock && group.nicknames) {
      const members = await api.getThreadInfo(threadID).then(res => res.participantIDs).catch(() => []);
      let changeCount = 0;

      for (const userID of members) {
        if (group.nicknames[userID]) {
          await wait(randomDelay(3000, 4000));
          try {
            await api.changeNickname(group.nicknames[userID], threadID, userID);
            console.log(`[👤] Nick set for ${userID} in ${threadID}`);
            changeCount++;
            if (changeCount % 60 === 0) {
              console.log(`[⏸️] Cooling down for 3 mins...`);
              await wait(180000);
            }
          } catch (err) {
            console.log(`[⚠️] Failed to set nick for ${userID}: ${err.message}`);
          }
        }
      }
    }

    // Group name lock
    if (group.groupNameLock && group.groupName) {
      setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          if (info.threadName !== group.groupName) {
            await api.setTitle(group.groupName, threadID);
            console.log(`[🔁] Reverted group name in ${threadID}`);
          }
        } catch (err) {
          console.log(`[❌] Error checking group name: ${err.message}`);
        }
      }, 45000);
    }
  }
}

function startAntiSleep(api) {
  setInterval(() => {
    for (const threadID of Object.keys(groupData)) {
      api.sendTypingIndicator(threadID).catch(() => {});
    }
    console.log(`[💤] Anti-sleep ping sent.`);
  }, 5 * 60 * 1000);
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
