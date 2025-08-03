const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

if (!fs.existsSync(groupDataFile)) fs.writeFileSync(groupDataFile, "{}");

const groupData = JSON.parse(fs.readFileSync(groupDataFile, "utf-8"));

const saveGroupData = () => {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupData, null, 2));
};

login({ appState: JSON.parse(fs.readFileSync(appstateFile, "utf-8")) }, (err, api) => {
  if (err) return console.error("Login error:", err);

  api.setOptions({ listenEvents: true });

  api.listenMqtt(async (err, event) => {
    if (err) return console.error(err);

    const threadID = event.threadID;
    const senderID = event.senderID;

    if (!groupData[threadID]) groupData[threadID] = {};
    const data = groupData[threadID];

    // COMMAND HANDLING
    if (event.body && event.body.startsWith("/")) {
      const args = event.body.trim().split(" ");
      const cmd = args[0].toLowerCase();
      const content = args.slice(1).join(" ");

      // Nickname lock
      if (cmd === "/nickall") {
        data.nickLock = content;
        saveGroupData();
        console.log(`[LOCK] Nickname locked to: ${content}`);
        applyNicknames(api, threadID, content);
      }

      if (cmd === "/unlocknick") {
        delete data.nickLock;
        saveGroupData();
        console.log("[UNLOCK] Nickname lock removed.");
      }

      // Group name lock
      if (cmd === "/gclock") {
        data.groupNameLock = content;
        saveGroupData();
        console.log(`[LOCK] Group name locked to: ${content}`);
        changeGroupName(api, threadID, content);
      }

      if (cmd === "/unlockgname") {
        delete data.groupNameLock;
        saveGroupData();
        console.log("[UNLOCK] Group name lock removed.");
      }
    }

    // Group name auto revert
    if (event.logMessageType === "log:thread-name" && data.groupNameLock) {
      const newName = event.logMessageData.name;
      if (newName !== data.groupNameLock) {
        setTimeout(() => {
          api.setTitle(data.groupNameLock, threadID, err => {
            if (err?.error === 3252001) {
              console.log("❌ [BLOCKED] Group name change blocked.");
            } else {
              console.log("🔄 [REVERT] Group name reverted silently.");
            }
          });
        }, randDelay());
      }
    }

    // Nickname auto revert
    if (event.type === "event" && event.logMessageType === "log:subscribe") {
      if (data.nickLock) {
        const newUsers = event.logMessageData.addedParticipants;
        for (const user of newUsers) {
          setTimeout(() => {
            setNick(api, threadID, user.userFbId, data.nickLock);
          }, randDelay());
        }
      }
    }

    if (event.type === "event" && event.logMessageType === "log:thread-nickname") {
      if (data.nickLock) {
        const changedFor = event.logMessageData.participant_id;
        setTimeout(() => {
          setNick(api, threadID, changedFor, data.nickLock);
        }, randDelay());
      }
    }
  });

  console.log("✅ Bot is now active.");
});

// Delay function (1.5s to 2.5s)
function randDelay() {
  return Math.floor(1500 + Math.random() * 1000);
}

// Apply nickname to all members with burst delay
async function applyNicknames(api, threadID, nickname) {
  api.getThreadInfo(threadID, async (err, info) => {
    if (err) return console.log("Error getting thread info:", err);

    let count = 0;
    for (const user of info.participantIDs) {
      await new Promise(resolve => {
        setTimeout(() => {
          setNick(api, threadID, user, nickname);
          resolve();
        }, randDelay());
      });

      count++;
      if (count % 30 === 0) {
        console.log(`⏳ [BURST DELAY] Pausing 2.5 minutes after ${count} users.`);
        await new Promise(r => setTimeout(r, 150000 + Math.random() * 30000));
      }
    }
  });
}

// Set nickname silently
function setNick(api, threadID, userID, nickname) {
  api.changeNickname(nickname, threadID, userID, err => {
    if (err?.error === 3252001) {
      console.log("❌ [BLOCKED] Nickname change blocked.");
    } else {
      console.log(`✅ Nickname set for ${userID}`);
    }
  });
}

// Change group name silently
function changeGroupName(api, threadID, name) {
  api.setTitle(name, threadID, err => {
    if (err?.error === 3252001) {
      console.log("❌ [BLOCKED] Group name change blocked.");
    } else {
      console.log("✅ Group name set successfully.");
    }
  });
}
