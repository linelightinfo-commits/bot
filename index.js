const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

const ADMIN_UID = "61578631626802";

let groupLocks = {}; // In-memory lock data

// Load group lock settings from JSON
if (fs.existsSync(groupDataFile)) {
  try {
    groupLocks = JSON.parse(fs.readFileSync(groupDataFile, "utf8"));
  } catch (err) {
    console.error("❌ Error reading groupData.json:", err.message);
  }
}

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

login({ appState: JSON.parse(fs.readFileSync(appstateFile, "utf8")) }, async (err, api) => {
  if (err) return console.error("Login error:", err);

  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);

  api.setOptions({ listenEvents: true, selfListen: false });

  // Appstate backup every 10 mins
  setInterval(() => {
    fs.writeFileSync(appstateFile, JSON.stringify(api.getAppState()));
  }, 10 * 60 * 1000);

  // Group name lock checker
  setInterval(() => {
    Object.entries(groupLocks).forEach(([threadID, config]) => {
      if (config.groupNameLock && config.lockedGroupName) {
        api.getThreadInfo(threadID, (err, info) => {
          if (err || !info || !info.threadName) return;
          if (info.threadName !== config.lockedGroupName) {
            api.setTitle(config.lockedGroupName, threadID, err => {
              if (!err) console.log(`[${new Date().toLocaleTimeString()}] 🔒 Reverted group name in ${threadID}`);
            });
          }
        });
      }
    });
  }, 30 * 1000); // Every 30 seconds

  // Anti-sleep typing
  setInterval(() => {
    Object.keys(groupLocks).forEach(threadID => {
      api.sendTypingIndicator(threadID);
    });
  }, 5 * 60 * 1000); // Every 5 minutes

  // Nickname locking function
  async function lockNicknames(threadID) {
    const config = groupLocks[threadID];
    if (!config || !config.nicknameLock || !config.lockedNicknames) return;

    let count = 0;
    const threadInfo = await api.getThreadInfo(threadID);
    if (!threadInfo || !threadInfo.userInfo) return;

    for (const user of threadInfo.userInfo) {
      const targetUID = user.id;
      let targetNickname = null;

      if (config.lockedNicknames.ALL) {
        targetNickname = config.lockedNicknames.ALL;
      } else if (config.lockedNicknames[targetUID]) {
        targetNickname = config.lockedNicknames[targetUID];
      }

      if (targetNickname !== null && threadInfo.nicknames[targetUID] !== targetNickname) {
        api.setNickname(targetNickname, threadID, targetUID, err => {
          if (!err) console.log(`[${new Date().toLocaleTimeString()}] 🔒 Nickname set for UID ${targetUID}`);
        });

        count++;
        await delay(3000 + Math.random() * 1000); // 3–4 sec delay

        if (count % 60 === 0) {
          console.log(`⏸️ Taking 3 min cooldown after 60 nickname changes`);
          await delay(3 * 60 * 1000); // Cooldown
        }
      }
    }
  }

  // Periodically lock nicknames
  setInterval(() => {
    Object.keys(groupLocks).forEach(threadID => lockNicknames(threadID));
  }, 40 * 1000); // Every 40 seconds

  api.listenMqtt((err, event) => {
    if (err || !event || !event.threadID) return;

    // Auto handle nickname revert on change
    if (event.type === "event" && event.logMessageType === "log:thread-nickname") {
      const config = groupLocks[event.threadID];
      if (!config || !config.nicknameLock || !config.lockedNicknames) return;

      const changedUID = event.logMessageData.participant_id;
      const desiredNickname = config.lockedNicknames.ALL || config.lockedNicknames[changedUID];

      if (desiredNickname) {
        api.setNickname(desiredNickname, event.threadID, changedUID, err => {
          if (!err)
            console.log(`[${new Date().toLocaleTimeString()}] 🔄 Reverted nickname for UID ${changedUID}`);
        });
      }
    }

    // Auto handle group name change
    if (event.type === "event" && event.logMessageType === "log:thread-name") {
      const config = groupLocks[event.threadID];
      if (config?.groupNameLock && config.lockedGroupName) {
        api.setTitle(config.lockedGroupName, event.threadID, err => {
          if (!err)
            console.log(`[${new Date().toLocaleTimeString()}] 🔄 Reverted group name for ${event.threadID}`);
        });
      }
    }
  });
});
