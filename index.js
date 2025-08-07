const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const appStateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

let groupData = fs.existsSync(groupDataFile) ? JSON.parse(fs.readFileSync(groupDataFile, "utf8")) : {};

const adminUID = "61578631626802";

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupData, null, 2));
}

function backupAppState(appState) {
  fs.writeFileSync(appStateFile, JSON.stringify(appState, null, 2));
}

function randomDelay(min, max) {
  return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

login({ appState: JSON.parse(fs.readFileSync(appStateFile, "utf8")) }, async (err, api) => {
  if (err) return console.error("❌ Login failed:", err);

  api.setOptions({
    listenEvents: true,
    selfListen: false,
    forceLogin: true,
    updatePresence: false,
    autoMarkDelivery: true
  });

  log("✅ Bot is running silently...");

  // Handle nickname lock loop
  async function enforceNicknames() {
    let counter = 0;
    while (true) {
      for (const threadID of Object.keys(groupData)) {
        const data = groupData[threadID];
        if (!data.nicknamesLocked || !data.nicknames) continue;

        try {
          const users = await api.getThreadInfo(threadID);
          if (!users || !users.userInfo) continue;

          for (const user of users.userInfo) {
            const correctNick = data.nicknames[user.id];
            if (correctNick && user.nickname !== correctNick) {
              await api.changeNickname(correctNick, threadID, user.id);
              log(`🔄 Nickname reverted for UID ${user.id} in ${threadID}`);
              counter++;
              if (counter % 60 === 0) {
                log("⏳ Cooling down for 3 minutes...");
                await new Promise(r => setTimeout(r, 180000));
              }
              await randomDelay(3000, 4000);
            }
          }
        } catch (e) {
          log(`❌ Error while enforcing nicknames for ${threadID}: ${e.message}`);
        }
      }
    }
  }

  // Handle group name lock loop
  async function enforceGroupNames() {
    while (true) {
      for (const threadID of Object.keys(groupData)) {
        const data = groupData[threadID];
        if (!data.groupNameLocked || !data.groupName) continue;

        try {
          const info = await api.getThreadInfo(threadID);
          if (!info || !info.threadName) {
            if (info === null || info.error === 1357031 || !info.threadName) {
              delete groupData[threadID];
              saveGroupData();
              log(`🧹 Removed invalid group: ${threadID}`);
            }
            continue;
          }

          if (info.threadName !== data.groupName) {
            await api.setTitle(data.groupName, threadID);
            log(`🔁 Group name reverted for ${threadID}`);
          }
        } catch (e) {
          log(`❌ Error checking group name for ${threadID}: ${e.message}`);
        }
      }
      await new Promise(r => setTimeout(r, 45000));
    }
  }

  // Typing indicator (anti-sleep)
  setInterval(() => {
    for (const threadID of Object.keys(groupData)) {
      api.sendTypingIndicator(threadID).catch(() => {});
    }
  }, 300000); // 5 min

  // AppState backup every 10 minutes
  setInterval(() => {
    if (api && api.getAppState) {
      const newAppState = api.getAppState();
      backupAppState(newAppState);
      log("💾 Appstate backup saved.");
    }
  }, 600000); // 10 min

  // Command listener
  api.listenMqtt(async (err, event) => {
    if (err || !event || event.type !== "message" || !event.body) return;

    const senderID = event.senderID;
    const threadID = event.threadID;
    const message = event.body.trim();

    if (senderID !== adminUID) return;

    if (!groupData[threadID]) groupData[threadID] = {};

    if (message === "/nicklock on") {
      const info = await api.getThreadInfo(threadID);
      const nickData = {};
      for (const user of info.userInfo) {
        if (user.nickname) {
          nickData[user.id] = user.nickname;
        }
      }
      groupData[threadID].nicknames = nickData;
      groupData[threadID].nicknamesLocked = true;
      saveGroupData();
    }

    if (message === "/nicklock off") {
      groupData[threadID].nicknamesLocked = false;
      saveGroupData();
    }

    if (message.startsWith("/gclock ")) {
      const name = message.slice(8).trim();
      if (name) {
        groupData[threadID].groupName = name;
        groupData[threadID].groupNameLocked = true;
        saveGroupData();
      }
    }

    if (message === "/unlockgname") {
      groupData[threadID].groupNameLocked = false;
      saveGroupData();
    }

    if (message === "/nickall") {
      const info = await api.getThreadInfo(threadID);
      for (const user of info.userInfo) {
        if (groupData[threadID].nicknames && groupData[threadID].nicknames[user.id]) {
          const nick = groupData[threadID].nicknames[user.id];
          await api.changeNickname(nick, threadID, user.id);
          await randomDelay(2000, 3000);
        }
      }
    }
  });

  // Start locking loops
  enforceNicknames();
  enforceGroupNames();

  // HTTP server (Render ping)
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running.");
  }).listen(process.env.PORT || 10000);
});
