// == Modified Nickname Lock with 3–4s Delay and 3min Break after 60 ==

const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

let groupLocks = {};

if (fs.existsSync(groupDataFile)) {
  groupLocks = JSON.parse(fs.readFileSync(groupDataFile, "utf8"));
  console.log("🔁 Loaded saved group locks.");
}

function saveGroupLocks() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

function backupAppstate() {
  fs.copyFileSync(appstateFile, path.join(__dirname, "appstate_backup.json"));
  console.log("💾 Appstate backed up.");
}

function antiSleep(api) {
  setInterval(() => {
    api.sendTypingIndicator(api.getCurrentUserID());
    console.log("💤 Anti-sleep triggered.");
  }, 5 * 60 * 1000); // Every 5 minutes
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

login({ appState: JSON.parse(fs.readFileSync(appstateFile, "utf8")) }, async (err, api) => {
  if (err) return console.error(err);

  console.log("🌐 Bot server started on port 10000");
  http.createServer(() => {}).listen(10000);

  console.log("✅ Logged in as:", api.getCurrentUserID());
  antiSleep(api);
  setInterval(backupAppstate, 10 * 60 * 1000);

  api.setOptions({ listenEvents: true });
  const adminUID = "61578631626802";

  const nicknameChangeCooldown = new Map();

  api.listenMqtt(async (err, event) => {
    if (err) return console.error(err);

    const threadID = event.threadID;
    const senderID = event.senderID;

    if (event.type === "event") {
      const data = groupLocks[threadID];

      if (event.logMessageType === "log:thread-name" && data?.groupNameLock) {
        const originalName = data.groupNameLock;
        api.setTitle(originalName, threadID, err => {
          if (err) console.error("Group name revert failed:", err);
        });
      }

      if (
        event.logMessageType === "log:thread-nickname" &&
        data?.nicknameLock
      ) {
        const { nicknameLock } = data;
        const targetID = Object.keys(event.logMessageData).find(
          key => key !== "nickname"
        );

        const originalNick = nicknameLock[targetID];
        if (originalNick && event.logMessageData.nickname !== originalNick) {
          api.changeNickname(originalNick, threadID, targetID, err => {
            if (err) console.error("Nickname revert failed:", err);
          });
        }
      }
    }

    if (event.type === "message" && event.body && senderID === adminUID) {
      const args = event.body.trim().split(/ +/);
      const cmd = args[0].toLowerCase();

      if (cmd === "/gclock") {
        const newName = args.slice(1).join(" ");
        if (!newName) return;

        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupNameLock = newName;
        saveGroupLocks();

        api.setTitle(newName, threadID);
      }

      if (cmd === "/unlockgname") {
        if (groupLocks[threadID]) delete groupLocks[threadID].groupNameLock;
        saveGroupLocks();
      }

      if (cmd === "/nicklock") {
        const sub = args[1];
        if (sub === "on") {
          const info = await api.getThreadInfo(threadID);
          const nickObj = {};

          for (const user of info.participantIDs) {
            const nickname = info.nicknames[user] || "";
            nickObj[user] = nickname;
          }

          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].nicknameLock = nickObj;
          saveGroupLocks();
        } else if (sub === "off") {
          if (groupLocks[threadID]) delete groupLocks[threadID].nicknameLock;
          saveGroupLocks();
        }
      }

      if (cmd === "/nickall") {
        const data = groupLocks[threadID]?.nicknameLock;
        if (!data) return;

        let count = 0;
        for (const id in data) {
          await api.changeNickname(data[id], threadID, id);
          await delay(Math.random() * 1000 + 3000); // 3s to 4s delay

          count++;
          if (count % 60 === 0) {
            console.log("⏳ Cooldown after 60 nicknames");
            await delay(180000); // 3-minute cooldown
          }
        }
      }
    }
  });

  setInterval(async () => {
    for (const threadID in groupLocks) {
      const data = groupLocks[threadID];
      if (!data.nicknameLock) continue;

      const info = await api.getThreadInfo(threadID);
      for (const id in data.nicknameLock) {
        const currentNick = info.nicknames[id] || "";
        if (currentNick !== data.nicknameLock[id]) {
          api.changeNickname(data.nicknameLock[id], threadID, id);
          await delay(Math.random() * 1000 + 3000); // 3s to 4s delay
        }
      }
    }
  }, 45000); // Reapply every 45 sec
});
