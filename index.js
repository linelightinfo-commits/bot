const login = require("ws3-fca");
const fs = require("fs");
const http = require("http");
const path = require("path");

const appstateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");
const allowedUID = "61578631626802";

let api;
let groupLocks = {};
let nicknameChangeCount = 0;
let lastCooldownTime = 0;

// HTTP server to keep bot alive
http.createServer((_, res) => res.end("Bot is running")).listen(10000);

// Load saved data
if (fs.existsSync(groupDataFile)) {
  groupLocks = JSON.parse(fs.readFileSync(groupDataFile, "utf-8"));
}

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupLocks, null, 2));
}

// Appstate backup
setInterval(() => {
  fs.copyFileSync(appstateFile, "appstate.backup.json");
}, 10 * 60 * 1000); // Every 10 min

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCooldownDue() {
  return nicknameChangeCount >= 60 && (Date.now() - lastCooldownTime) > 3 * 60 * 1000;
}

async function lockNicknames(threadID) {
  const data = groupLocks[threadID];
  if (!data || !data.nicknameLock || !data.nickname) return;

  const { nickname, nicknameTargets } = data;

  api.getThreadInfo(threadID, async (err, info) => {
    if (err || !info || !info.participantIDs) return;

    const participants = info.participantIDs;

    for (const uid of participants) {
      const shouldLock = nicknameTargets === "all" || (Array.isArray(nicknameTargets) && nicknameTargets.includes(uid));
      if (!shouldLock) continue;

      await sleep(3000 + Math.random() * 1000);

      api.changeNickname(nickname, threadID, uid, err => {
        if (!err) {
          console.log(`[${new Date().toLocaleTimeString()}] Nickname locked: ${uid} => "${nickname}"`);
        }
      });

      nicknameChangeCount++;

      if (nicknameChangeCount >= 60) {
        console.log("🔄 Cooling down for 3 minutes...");
        await sleep(3 * 60 * 1000);
        nicknameChangeCount = 0;
        lastCooldownTime = Date.now();
      }
    }
  });
}

function lockGroupName(threadID) {
  const data = groupLocks[threadID];
  if (!data || !data.groupNameLock || !data.groupName) return;

  api.getThreadInfo(threadID, (err, info) => {
    if (err || !info) return;

    if (info.threadName !== data.groupName) {
      api.setTitle(data.groupName, threadID, err => {
        if (!err) {
          console.log(`[${new Date().toLocaleTimeString()}] Group name reverted to "${data.groupName}"`);
        }
      });
    }
  });
}

// Anti-sleep: Send typing every 5 min
setInterval(() => {
  for (const threadID in groupLocks) {
    api.sendTypingIndicator(threadID);
  }
}, 5 * 60 * 1000);

// Periodic checks
setInterval(() => {
  for (const threadID in groupLocks) {
    lockGroupName(threadID);
    lockNicknames(threadID);
  }
}, 45 * 1000);

// Login
login({ appState: JSON.parse(fs.readFileSync(appstateFile, "utf-8")) }, (err, apix) => {
  if (err) return console.error("❌ Login failed:", err);

  api = apix;
  console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);
});
