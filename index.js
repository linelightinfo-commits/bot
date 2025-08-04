const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

let appstate = JSON.parse(fs.readFileSync(appstateFile, "utf8"));
let groupLocks = fs.existsSync(groupDataFile) ? JSON.parse(fs.readFileSync(groupDataFile, "utf8")) : {};
let nickChangeCounter = {};

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

function backupAppState() {
  fs.writeFileSync("appstate.backup.json", JSON.stringify(appstate, null, 2));
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

login({ appState: appstate }, async (err, api) => {
  if (err) return console.error("Login Error:", err);

  appstate = api.getAppState();
  console.log("✅ Logged in as:", api.getCurrentUserID());

  api.setOptions({ listenEvents: true, selfListen: false });
  const adminUID = "61578631626802";

  setInterval(() => backupAppState(), 10 * 60 * 1000);
  setInterval(() => {
    Object.keys(groupLocks).forEach(threadID => {
      api.sendTypingIndicator(threadID).catch(() => {});
    });
    console.log("💤 Anti-sleep triggered.");
  }, 5 * 60 * 1000);

  api.listenMqtt(async event => {
    if (event.type === "message" && event.body && event.senderID === adminUID) {
      const args = event.body.trim().split(" ");
      const command = args[0].toLowerCase();
      const threadID = event.threadID;

      if (command === "/nicklock") {
        if (args[1] === "on") {
          const threadInfo = await api.getThreadInfo(threadID);
          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].nicknames = {};
          threadInfo.userInfo.forEach(u => {
            if (u.nickname) groupLocks[threadID].nicknames[u.id] = u.nickname;
          });
          saveGroupData();
        } else if (args[1] === "off") {
          if (groupLocks[threadID]) delete groupLocks[threadID].nicknames;
          saveGroupData();
        }
      }

      if (command === "/gclock") {
        const name = args.slice(1).join(" ");
        if (!groupLocks[threadID]) groupLocks[threadID] = {};
        groupLocks[threadID].groupName = name;
        saveGroupData();
        await api.setTitle(name, threadID);
      }

      if (command === "/unlockgname") {
        if (groupLocks[threadID]) delete groupLocks[threadID].groupName;
        saveGroupData();
      }

      if (command === "/unlocknick") {
        if (groupLocks[threadID]) delete groupLocks[threadID].nicknames;
        saveGroupData();
      }

      if (command === "/nickall") {
        const threadInfo = await api.getThreadInfo(threadID);
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].nicknames = {};
        threadInfo.userInfo.forEach(u => {
          if (u.nickname) groupLocks[threadID].nicknames[u.id] = u.nickname;
        });
        saveGroupData();
      }
    }

    if (event.type === "event") {
      const threadID = event.threadID;
      const lock = groupLocks[threadID];

      if (event.logMessageType === "log:thread-name" && lock?.groupName && event.author !== api.getCurrentUserID()) {
        if (event.logMessageData?.name !== lock.groupName) {
          console.log(`[${new Date().toLocaleTimeString()}] 🔒 Reverting GC name`);
          await api.setTitle(lock.groupName, threadID).catch(() => {});
        }
      }

      if (event.logMessageType === "log:user-nickname" && lock?.nicknames && event.author !== api.getCurrentUserID()) {
        const userID = event.logMessageData.participant_id;
        const expectedNick = lock.nicknames[userID];
        if (expectedNick && event.logMessageData.nickname !== expectedNick) {
          console.log(`[${new Date().toLocaleTimeString()}] 🔒 Reverting nickname`);
          if (!nickChangeCounter[threadID]) nickChangeCounter[threadID] = 0;

          await sleep(3000 + Math.random() * 1000);
          await api.changeNickname(expectedNick, threadID, userID).catch(() => {});
          nickChangeCounter[threadID]++;

          if (nickChangeCounter[threadID] >= 60) {
            console.log("⏸️ Cooling down for 3 minutes...");
            await sleep(3 * 60 * 1000);
            nickChangeCounter[threadID] = 0;
          }
        }
      }
    }
  });

  // Revert GC name every 45 seconds
  setInterval(async () => {
    for (const threadID in groupLocks) {
      const lock = groupLocks[threadID];
      if (lock?.groupName) {
        const info = await api.getThreadInfo(threadID);
        if (info?.threadName !== lock.groupName) {
          console.log(`[${new Date().toLocaleTimeString()}] 🔒 Reverting GC name`);
          await api.setTitle(lock.groupName, threadID).catch(() => {});
        }
      }
    }
  }, 45 * 1000);
});

http.createServer((_, res) => {
  res.end("Bot is running.");
}).listen(10000);
