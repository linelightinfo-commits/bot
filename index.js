const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));
const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = fs.existsSync(groupDataPath) ? JSON.parse(fs.readFileSync(groupDataPath, "utf8")) : {};

const groupNameCheckInterval = 45 * 1000;
const nicknameDelayMin = 4000;
const nicknameDelayMax = 5000;
const nicknameChangeLimit = 60;
const nicknameCooldown = 180000;
const typingInterval = 5 * 60 * 1000;
const appstateBackupInterval = 10 * 60 * 1000;

login({ appState }, async (err, api) => {
  if (err) return console.error("❌ Login failed:", err);
  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);

  const originalSetTitle = api.setTitle;
  const originalSetNickname = api.setNickname;

  const groupLocks = {};

  for (const [threadID, data] of Object.entries(groupData)) {
    if (data.groupName) {
      groupLocks[threadID] = {
        groupName: data.groupName,
        nicknames: data.nicknames || {},
        lastNickChange: 0,
        nickChangeCount: 0,
      };
    }
  }

  // Anti-sleep
  setInterval(() => {
    for (const threadID in groupLocks) {
      api.sendTypingIndicator(threadID).catch(() => {});
    }
  }, typingInterval);

  // Appstate backup
  setInterval(() => {
    fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState()));
    console.log(`[${timestamp()}] 💾 Appstate backed up`);
  }, appstateBackupInterval);

  // Group name lock loop
  setInterval(() => {
    for (const threadID in groupLocks) {
      api.getThreadInfo(threadID, (err, info) => {
        if (!err && info && info.name !== groupLocks[threadID].groupName) {
          originalSetTitle(groupLocks[threadID].groupName, threadID, (err) => {
            if (!err) console.log(`[${timestamp()}] ⛔ Group name reverted in ${threadID}`);
          });
        }
      });
    }
  }, groupNameCheckInterval);

  // Nickname lock loop
  async function runNicknameLock() {
    for (const threadID in groupLocks) {
      const data = groupLocks[threadID];
      const members = Object.entries(data.nicknames || {});
      for (let [uid, desiredNick] of members) {
        try {
          const info = await api.getUserInfo(uid);
          if (!info) continue;
          const currentNick = info[uid].nickname || "";
          if (currentNick !== desiredNick) {
            await new Promise((res) => setTimeout(res, randomDelay()));
            await originalSetNickname(desiredNick, threadID, uid);
            data.nickChangeCount++;
            data.lastNickChange = Date.now();
            console.log(`[${timestamp()}] 🔁 Nickname reverted in ${threadID} for ${uid}`);
            if (data.nickChangeCount >= nicknameChangeLimit) {
              console.log(`[${timestamp()}] ⏸ Cooldown after 60 changes in ${threadID}`);
              await new Promise((r) => setTimeout(r, nicknameCooldown));
              data.nickChangeCount = 0;
            }
          }
        } catch {}
      }
    }
    setTimeout(runNicknameLock, randomDelay());
  }
  runNicknameLock();

  // Command handler
  api.listenMqtt(async (err, event) => {
    if (err || !event.body || !event.senderID || event.senderID !== "61578631626802") return;
    const { threadID, body } = event;

    if (body.startsWith("/nicklock on")) {
      const thread = await api.getThreadInfo(threadID);
      const nicknames = {};
      thread.userInfo.forEach((u) => {
        if (u.id !== api.getCurrentUserID()) nicknames[u.id] = u.nickname || "";
      });
      groupLocks[threadID] = {
        groupName: thread.name,
        nicknames,
        lastNickChange: 0,
        nickChangeCount: 0,
      };
      groupData[threadID] = { groupName: thread.name, nicknames };
      fs.writeFileSync(groupDataPath, JSON.stringify(groupData, null, 2));
      console.log(`[${timestamp()}] ✅ Nickname lock enabled for ${threadID}`);
    }

    if (body.startsWith("/gclock ")) {
      const customName = body.replace("/gclock ", "").trim();
      if (!customName) return;
      if (!groupLocks[threadID]) groupLocks[threadID] = {};
      groupLocks[threadID].groupName = customName;
      groupData[threadID] = groupData[threadID] || {};
      groupData[threadID].groupName = customName;
      fs.writeFileSync(groupDataPath, JSON.stringify(groupData, null, 2));
      api.setTitle(customName, threadID);
      console.log(`[${timestamp()}] ✅ Group name locked to "${customName}" in ${threadID}`);
    }
  });
});

function randomDelay() {
  return Math.floor(Math.random() * (nicknameDelayMax - nicknameDelayMin + 1)) + nicknameDelayMin;
}

function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}
