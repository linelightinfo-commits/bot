const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");

const appStateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");

let groupLocks = fs.existsSync(groupDataFile) ? JSON.parse(fs.readFileSync(groupDataFile)) : {};
const ADMIN_UID = "61578631626802";

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

function logActivity(text) {
  console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
}

login({ appState: JSON.parse(fs.readFileSync(appStateFile, "utf8")) }, (err, api) => {
  if (err) return console.error("Login error:", err);
  logActivity(`✅ Logged in as: ${api.getCurrentUserID()}`);

  api.setOptions({ listenEvents: true });

  // Nickname changer
  async function enforceNicknames() {
    let changeCount = 0;
    for (const threadID in groupLocks) {
      const group = groupLocks[threadID];
      if (group.nickLock && group.nicknames) {
        for (const uid in group.nicknames) {
          try {
            const userInfo = await api.getUserInfo(uid);
            const currentNick = userInfo[uid]?.nickname || "";
            if (currentNick !== group.nicknames[uid]) {
              await api.changeNickname(group.nicknames[uid], threadID, uid);
              logActivity(`🔄 Nickname reverted for ${uid} in ${threadID}`);
              changeCount++;
              await new Promise(res => setTimeout(res, 3000 + Math.random() * 1000));
              if (changeCount % 60 === 0) await new Promise(res => setTimeout(res, 180000));
            }
          } catch {}
        }
      }
    }
  }

  // Group name lock
  async function checkGroupNames() {
    for (const threadID in groupLocks) {
      const group = groupLocks[threadID];
      if (group.nameLock && group.lockedName) {
        try {
          const info = await api.getThreadInfo(threadID);
          if (info.name !== group.lockedName) {
            await api.setTitle(group.lockedName, threadID);
            logActivity(`♻️ Group name reverted in ${threadID}`);
          }
        } catch {}
      }
    }
  }

  // Anti-sleep
  setInterval(() => {
    Object.keys(groupLocks).forEach(threadID => {
      api.sendTypingIndicator(threadID).catch(() => {});
    });
  }, 5 * 60 * 1000);

  // Appstate auto backup
  setInterval(() => {
    fs.writeFileSync(appStateFile, JSON.stringify(api.getAppState()));
    logActivity("💾 Appstate backed up.");
  }, 10 * 60 * 1000);

  // Periodic enforcers
  setInterval(enforceNicknames, 40 * 1000);
  setInterval(checkGroupNames, 30 * 1000);

  // Event listener
  api.listenMqtt(async (err, event) => {
    if (err || !event || event.type !== "message" || !event.body) return;
    const { threadID, senderID, body } = event;

    const cmd = body.toLowerCase().trim();
    if (senderID !== ADMIN_UID) return;

    if (!groupLocks[threadID]) groupLocks[threadID] = {};

    if (cmd === "/nicklock on") {
      groupLocks[threadID].nickLock = true;
      const info = await api.getThreadInfo(threadID);
      groupLocks[threadID].nicknames = {};
      info.participantIDs.forEach(id => groupLocks[threadID].nicknames[id] = info.nicknames[id] || "");
      saveGroupData();
      logActivity(`🔒 Nickname lock enabled for ${threadID}`);
    }

    if (cmd === "/nicklock off") {
      groupLocks[threadID].nickLock = false;
      delete groupLocks[threadID].nicknames;
      saveGroupData();
      logActivity(`🔓 Nickname lock disabled for ${threadID}`);
    }

    if (cmd === "/nickall") {
      const info = await api.getThreadInfo(threadID);
      info.participantIDs.forEach(id => {
        const nick = info.nicknames[id] || "";
        api.changeNickname(nick, threadID, id).catch(() => {});
      });
      logActivity(`🌀 Nicknames reset in ${threadID}`);
    }

    if (cmd === "/unlocknick") {
      delete groupLocks[threadID].nickLock;
      delete groupLocks[threadID].nicknames;
      saveGroupData();
      logActivity(`❌ Nickname lock removed in ${threadID}`);
    }

    if (cmd.startsWith("/gclock ")) {
      const name = body.slice(8).trim();
      if (!name) return;
      groupLocks[threadID].nameLock = true;
      groupLocks[threadID].lockedName = name;
      saveGroupData();
      await api.setTitle(name, threadID);
      logActivity(`🏷️ Group name locked to '${name}' in ${threadID}`);
    }

    if (cmd === "/unlockgname") {
      delete groupLocks[threadID].nameLock;
      delete groupLocks[threadID].lockedName;
      saveGroupData();
      logActivity(`❌ Group name lock removed in ${threadID}`);
    }
  });

  // Dummy HTTP server
  http.createServer((_, res) => res.end("Bot is running")).listen(10000);
});
