const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs").promises;
const express = require("express");
const path = require("path");
require("dotenv").config();
const { setTimeout: wait } = require("timers/promises");

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_UID = process.env.ADMIN_UID || "61578666851540";

app.get("/", (_, res) => res.send("✅ Bot is running."));
app.listen(PORT, () => console.log(`[🌐] Express live on port ${PORT}`));

async function initializeGroupLocks(api) {
  const groupDataPath = path.join(__dirname, "groupData.json");
  let groupData = {};
  try {
    if (await fs.access(groupDataPath).then(() => true).catch(() => false)) {
      groupData = JSON.parse(await fs.readFile(groupDataPath, "utf8"));
      console.log("[🔁] Loaded group data from groupData.json.");
    }
  } catch (e) {
    console.error("[❌] Failed to load groupData.json:", e);
  }

  for (const threadID of Object.keys(groupData)) {
    const group = groupData[threadID];

    // डिफॉल्ट सेटिंग्स
    group.groupNameLock = group.groupNameLock !== undefined ? group.groupNameLock : true;
    group.nicknameLock = group.nicknameLock !== undefined ? group.nicknameLock : false;

    // निकनेम लॉक (ऑफ)
    if (group.nicknameLock && group.nicknames) {
      const members = await api.getThreadInfo(threadID).then(res => res.participantIDs).catch(() => []);
      let changeCount = 0;

      for (const userID of members) {
        if (group.nicknames[userID]) {
          await wait(randomDelay(3000, 4000));
          try {
            await api.changeNickname(group.nicknames[userID], threadID, userID);
            console.log(`[👤] Nick set for ${userID} in ${threadID}`);
            changeCount++;
            if (changeCount % 60 === 0) {
              console.log(`[⏸️] Cooling down for 3 mins...`);
              await wait(180000);
            }
          } catch (err) {
            console.log(`[⚠️] Failed to set nick for ${userID}:`, err.message);
          }
        }
      }
    }

    // ग्रुप नेम लॉक
    if (group.groupNameLock && group.groupName) {
      setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          if (info.threadName !== group.groupName) {
            await new Promise((resolve, reject) => {
              api.sendMessage(`/settitle ${group.groupName}`, threadID, (err) => (err ? reject(err) : resolve()));
            });
            console.log(`[🔁] Reverted group name in ${threadID}`);
          }
        } catch (err) {
          console.log(`[❌] Error checking group name for ${threadID}:`, err.message);
          if (err?.error === 1357031) {
            console.warn(`[❌] Group ${threadID} not accessible (1357031). Skipping.`);
            delete groupData[threadID];
            await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
          }
        }
      }, 45000);
    }
  }

  // groupData.json अपडेट करो
  try {
    await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
    console.log("[💾] Group data saved.");
  } catch (e) {
    console.error("[❌] Failed to save groupData.json:", e);
  }
}

function startAntiSleep(api) {
  setInterval(() => {
    const groupDataPath = path.join(__dirname, "groupData.json");
    let groupData = {};
    try {
      groupData = JSON.parse(fs.readFileSync(groupDataPath, "utf8"));
    } catch (e) {
      console.error("[❌] Failed to read groupData.json for anti-sleep:", e);
    }

    for (const threadID of Object.keys(groupData)) {
      api.sendTypingIndicator(threadID).catch(() => {});
    }
    console.log(`[💤] Anti-sleep ping sent.`);
  }, 5 * 60 * 1000);
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  // appstate को Environment Variable से पढ़ो
  let appState;
  try {
    appState = JSON.parse(process.env.APPSTATE_JSON || '[]');
    if (!appState || appState.length === 0) {
      console.error("[❌] APPSTATE_JSON is empty or invalid! Exiting.");
      process.exit(1);
    }
  } catch (e) {
    console.error("[❌] Cannot parse APPSTATE_JSON! Exiting.", e);
    process.exit(1);
  }

  // लॉगिन
  let api;
  try {
    api = await new Promise((resolve, reject) => {
      login(
        { appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" },
        (err, api) => (err ? reject(err) : resolve(api))
      );
    });
    api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
    console.log(`[✅] Logged in as: ${api.getCurrentUserID()}`);
  } catch (err) {
    console.error("[❌] Login failed:", err);
    process.exit(1);
  }

  // ग्रुप लॉक्स इनिशियलाइज़ करो
  await initializeGroupLocks(api);
  startAntiSleep(api);

  // इवेंट लिसनर
  api.listenMqtt(async (err, event) => {
    if (err || !event || event.type !== "message" || !event.body) return;

    const body = event.body.toLowerCase().trim();
    const senderID = event.senderID;
    const threadID = event.threadID;
    const groupDataPath = path.join(__dirname, "groupData.json");
    let groupData = {};
    try {
      groupData = JSON.parse(await fs.readFile(groupDataPath, "utf8"));
    } catch (e) {
      console.error("[❌] Failed to read groupData.json:", e);
    }

    if (senderID !== ADMIN_UID) return;

    if (body === "/nicklock on" && groupData[threadID]) {
      groupData[threadID].nicknameLock = true;
      try {
        await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
        console.log(`[🔒] Nickname lock ENABLED for ${threadID}`);
        await api.sendMessage(`🔒 Nickname lock enabled for group ${threadID}.`, threadID);
      } catch (e) {
        console.error("[❌] Failed to save groupData.json:", e);
      }
    }

    if (body === "/nicklock off" && groupData[threadID]) {
      groupData[threadID].nicknameLock = false;
      try {
        await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
        console.log(`[🔓] Nickname lock DISABLED for ${threadID}`);
        await api.sendMessage(`🔓 Nickname lock disabled for group ${threadID}.`, threadID);
      } catch (e) {
        console.error("[❌] Failed to save groupData.json:", e);
      }
    }

    if (body === "/gclock" && groupData[threadID]) {
      const groupName = event.threadName || groupData[threadID].groupName;
      groupData[threadID].groupName = groupName;
      groupData[threadID].groupNameLock = true;
      try {
        await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
        console.log(`[🔒] Group name locked as "${groupName}" for ${threadID}`);
        await api.sendMessage(`🔒 Group name locked as "${groupName}" for group ${threadID}.`, threadID);
      } catch (e) {
        console.error("[❌] Failed to save groupData.json:", e);
      }
    }

    if (body === "/unlockgname" && groupData[threadID]) {
      groupData[threadID].groupNameLock = false;
      try {
        await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
        console.log(`[🔓] Group name lock disabled for ${threadID}`);
        await api.sendMessage(`🔓 Group name lock disabled for group ${threadID}.`, threadID);
      } catch (e) {
        console.error("[❌] Failed to save groupData.json:", e);
      }
    }
  });

  // ग्रेसफुल एक्ज़िट
  const gracefulExit = async () => {
    console.log("[💾] Saving group data before exit...");
    try {
      const groupDataPath = path.join(__dirname, "groupData.json");
      let groupData = {};
      if (await fs.access(groupDataPath).then(() => true).catch(() => false)) {
        groupData = JSON.parse(await fs.readFile(groupDataPath, "utf8"));
      }
      await fs.writeFile(groupDataPath, JSON.stringify(groupData, null, 2));
    } catch (e) {
      console.error("[❌] Exit save error:", e);
    }
    process.exit(0);
  };

  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}

main().catch((err) => {
  console.error("[❌] Startup error:", err);
  process.exit(1);
});
