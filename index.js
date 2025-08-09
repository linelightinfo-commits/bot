const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");

const appStateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "data.json");

let groupData = fs.existsSync(groupDataFile)
  ? JSON.parse(fs.readFileSync(groupDataFile, "utf8"))
  : {};

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function randomDelay(min, max) {
  return new Promise(resolve =>
    setTimeout(resolve, Math.random() * (max - min) + min)
  );
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

  log("✅ Bot started...");

  // Nickname lock loop
  async function enforceNicknames() {
    while (true) {
      for (const threadID of Object.keys(groupData)) {
        const data = groupData[threadID];
        if (!data.nicknamesLocked || !data.nicknames) continue;

        try {
          const info = await api.getThreadInfo(threadID);
          if (!info || !info.userInfo) continue;

          for (const user of info.userInfo) {
            const correctNick = data.nicknames[user.id];
            if (correctNick && user.nickname !== correctNick) {
              log(`🔄 Changing nickname for ${user.name} in ${threadID}`);
              await randomDelay(45000, 46000); // 45 sec delay
              await api.changeNickname(correctNick, threadID, user.id);
            }
          }
        } catch (e) {
          log(`❌ Error nickname lock for ${threadID}: ${e.message}`);
        }
      }
      await randomDelay(5000, 8000);
    }
  }

  // Group name lock loop
  async function enforceGroupNames() {
    while (true) {
      for (const threadID of Object.keys(groupData)) {
        const data = groupData[threadID];
        if (!data.groupNameLocked || !data.groupName) continue;

        try {
          const info = await api.getThreadInfo(threadID);
          if (!info || !info.threadName) continue;

          if (info.threadName !== data.groupName) {
            log(`🔁 Changing group name for ${threadID}`);
            await api.setTitle(data.groupName, threadID);
          }
        } catch (e) {
          log(`❌ Error group name lock for ${threadID}: ${e.message}`);
        }
      }
      await randomDelay(40000, 50000); // every ~45 sec
    }
  }

  // Typing indicator to keep session alive
  setInterval(() => {
    for (const threadID of Object.keys(groupData)) {
      api.sendTypingIndicator(threadID).catch(() => {});
    }
  }, 300000);

  // Auto appstate backup every 10 min
  setInterval(() => {
    if (api && api.getAppState) {
      fs.writeFileSync(appStateFile, JSON.stringify(api.getAppState(), null, 2));
      log("💾 Appstate backup saved.");
    }
  }, 600000);

  // Start loops
  enforceNicknames();
  enforceGroupNames();

  // HTTP server for Render
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running.");
  }).listen(process.env.PORT || 10000, () => {
    log(`🌐 HTTP server running on port ${process.env.PORT || 10000}`);
  });
});
