const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

let groupData = {};
if (fs.existsSync(groupDataFile)) {
  try {
    groupData = JSON.parse(fs.readFileSync(groupDataFile, "utf8"));
  } catch (e) {
    console.error("❌ Error reading groupData.json:", e);
  }
}

const saveAppState = (appState) => {
  fs.writeFileSync(appstateFile, JSON.stringify(appState, null, 2));
  console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
};

login({ appState: JSON.parse(fs.readFileSync(appstateFile, "utf8")) }, async (err, api) => {
  if (err) return console.error("❌ Login error:", err);

  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);

  api.setOptions({
    listenEvents: true,
    selfListen: false,
    updatePresence: true,
    forceLogin: true,
  });

  // Backup appstate every 10 minutes
  setInterval(() => saveAppState(api.getAppState()), 10 * 60 * 1000);

  // Anti-sleep: send typing every 5 minutes
  setInterval(() => {
    for (const threadID in groupData) {
      api.sendTypingIndicator(threadID);
    }
  }, 5 * 60 * 1000);

  // Group name lock every 45 sec
  setInterval(() => {
    for (const threadID in groupData) {
      const data = groupData[threadID];
      if (data.groupNameLock && data.lockedGroupName) {
        api.getThreadInfo(threadID, (err, info) => {
          if (!err && info.threadName !== data.lockedGroupName) {
            api.setTitle(data.lockedGroupName, threadID, () => {
              console.log(`[${new Date().toLocaleTimeString()}] 🔁 Group name reverted in ${threadID}`);
            });
          }
        });
      }
    }
  }, 45 * 1000);

  // Nickname lock controller
  let nicknameCount = 0;
  const nicknameWorker = async () => {
    for (const threadID in groupData) {
      const data = groupData[threadID];
      if (!data.nicknameLock || !data.lockedNicknames) continue;

      for (const uid in data.lockedNicknames) {
        const targetNick = data.lockedNicknames[uid];
        try {
          api.getThreadInfo(threadID, async (err, info) => {
            if (err || !info || !info.nicknames) return;

            const currentNick = info.nicknames[uid];
            if (currentNick !== targetNick) {
              await api.setNickname(targetNick, threadID, uid);
              nicknameCount++;
              console.log(`[${new Date().toLocaleTimeString()}] 🔄 Nickname fixed for UID ${uid} in ${threadID}`);
            }
          });
        } catch (e) {
          console.error("❌ Nickname update error:", e.message);
        }

        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1000) + 3000)); // 3–4s delay

        if (nicknameCount >= 60) {
          console.log(`[${new Date().toLocaleTimeString()}] ⏸️ 3 min cooldown (60 nicknames done)`);
          nicknameCount = 0;
          await new Promise((r) => setTimeout(r, 3 * 60 * 1000));
        }
      }
    }
    setTimeout(nicknameWorker, 5000);
  };
  nicknameWorker();
});
