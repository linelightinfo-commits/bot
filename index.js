const login = require("ws3-fca");
const fs = require("fs");
const http = require("http");

const appstate = require("./appstate.json");
const groupDataFile = "groupData.json";

const ADMIN_UID = "61578631626802";
const groupLocks = fs.existsSync(groupDataFile) ? JSON.parse(fs.readFileSync(groupDataFile)) : {};

function saveLocks() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

login({ appState: appstate }, (err, api) => {
  if (err) return console.error("Login error:", err);

  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);
  api.setOptions({ listenEvents: true, selfListen: false });

  // Silent HTTP server for render
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running!");
  }).listen(10000);

  // --- Auto appstate backup ---
  setInterval(() => {
    fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState()));
  }, 10 * 60 * 1000);

  // --- Anti Sleep ---
  setInterval(() => {
    for (const groupID in groupLocks) {
      api.sendTypingIndicator(groupID);
    }
  }, 5 * 60 * 1000);

  // --- Group name lock check ---
  setInterval(async () => {
    for (const groupID in groupLocks) {
      const lock = groupLocks[groupID];
      if (!lock.groupName) continue;
      try {
        const info = await api.getThreadInfo(groupID);
        if (info.threadName !== lock.groupName) {
          await api.setTitle(lock.groupName, groupID);
          console.log(`[${new Date().toLocaleTimeString()}] ⛔ Group name reverted in ${groupID}`);
        }
      } catch (e) {}
    }
  }, 45 * 1000);

  // --- Nickname lock logic ---
  async function lockNicknames(threadID) {
    const lock = groupLocks[threadID];
    if (!lock || !lock.nicknames) return;

    const info = await api.getThreadInfo(threadID);
    let changeCount = 0;

    for (const userID in lock.nicknames) {
      const currentNick = info.nicknames[userID];
      const targetNick = lock.nicknames[userID];
      if (currentNick !== targetNick) {
        await new Promise(res => setTimeout(res, 3000 + Math.random() * 1000));
        try {
          await api.changeNickname(targetNick, threadID, userID);
          console.log(`[${new Date().toLocaleTimeString()}] 🔁 Nickname reverted for ${userID} in ${threadID}`);
        } catch (e) {}
        changeCount++;
        if (changeCount % 60 === 0) {
          await new Promise(r => setTimeout(r, 3 * 60 * 1000));
        }
      }
    }
  }

  api.listenMqtt(async (err, event) => {
    if (err || !event.threadID) return;
    const { threadID, body, senderID } = event;

    if (!groupLocks[threadID]) groupLocks[threadID] = {};
    const lock = groupLocks[threadID];

    // Command Handling (Admin UID only)
    if (senderID === ADMIN_UID && body) {
      if (body.startsWith("/nicklock on")) {
        const info = await api.getThreadInfo(threadID);
        lock.nicknames = {};
        for (const u of info.userInfo) {
          lock.nicknames[u.id] = info.nicknames[u.id] || u.firstName;
        }
        saveLocks();
        console.log(`[${new Date().toLocaleTimeString()}] 🔒 Nickname lock enabled in ${threadID}`);
      }

      if (body.startsWith("/nicklock off")) {
        delete lock.nicknames;
        saveLocks();
        console.log(`[${new Date().toLocaleTimeString()}] 🔓 Nickname lock disabled in ${threadID}`);
      }

      if (body.startsWith("/gclock ")) {
        const name = body.slice(8).trim();
        lock.groupName = name;
        saveLocks();
        api.setTitle(name, threadID);
        console.log(`[${new Date().toLocaleTimeString()}] 🔒 Group name locked: ${name}`);
      }

      if (body.startsWith("/unlockgname")) {
        delete lock.groupName;
        saveLocks();
        console.log(`[${new Date().toLocaleTimeString()}] 🔓 Group name unlock in ${threadID}`);
      }

      if (body.startsWith("/nickall ")) {
        const nickname = body.slice(9).trim();
        const info = await api.getThreadInfo(threadID);
        for (const u of info.userInfo) {
          await new Promise(r => setTimeout(r, 3000 + Math.random() * 1000));
          try {
            await api.changeNickname(nickname, threadID, u.id);
          } catch (e) {}
        }
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 All nicknames changed in ${threadID}`);
      }
    }

    // Enforce nickname lock
    if (lock.nicknames) lockNicknames(threadID);
  });
});
