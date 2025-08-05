

const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => console.log(`🌐 Bot server started on port ${PORT}`));

const BOSS_UID = "61578631626802";
const appState = JSON.parse(fs.readFileSync("appstate.json", "utf-8"));
const dataFile = path.join(__dirname, "groupData.json");

let groupLocks = {};
if (fs.existsSync(dataFile)) {
  try {
    groupLocks = JSON.parse(fs.readFileSync(dataFile));
    console.log("🔁 Loaded saved group locks.");
  } catch (e) {
    console.error("❌ Failed to load groupData.json", e);
  }
}

function saveLocks() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(groupLocks, null, 2));
  } catch (e) {
    console.error("❌ Failed to save groupData.json", e);
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

login({ appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0...)" }, (err, api) => {
  if (err) return console.error("❌ Login failed:", err);
  api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });

  setInterval(() => {
    Object.keys(groupLocks).forEach((id) => {
      api.sendTypingIndicator(id, true);
      setTimeout(() => api.sendTypingIndicator(id, false), 1500);
    });
    console.log("💤 Anti-sleep triggered.");
  }, 300000);

  setInterval(() => {
    try {
      fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));
      console.log("💾 Appstate backed up.");
    } catch (e) {
      console.error("❌ Appstate backup error:", e);
    }
  }, 600000);

  api.listenMqtt(async (err, event) => {
    if (err) return console.error("❌ Event error:", err);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const body = (event.body || "").toLowerCase();

    if (event.type === "message" && senderID === BOSS_UID) {
      if (body === "/nicklock on") {
        try {
          const info = await api.getThreadInfo(threadID);
          const lockedNick = "😈😈 ᴢᴀʟɪᴍ࿐ʟᴀᴅᴋᴀ";
          groupLocks[threadID] = {
            enabled: true,
            nick: lockedNick,
            original: {},
            count: 0,
            cooldown: false,
          };
          for (const user of info.userInfo) {
            groupLocks[threadID].original[user.id] = lockedNick;
            await api.changeNickname(lockedNick, threadID, user.id);
            await delay(Math.random() * 1400 + 1800);
          }
          saveLocks();
          console.log(`[NICKLOCK] Activated for ${threadID}`);
        } catch (e) {
          console.error("❌ Nicklock error:", e);
        }
      }

      if (body === "/nicklock off") {
        if (groupLocks[threadID]) delete groupLocks[threadID].enabled;
        saveLocks();
        console.log(`[NICKLOCK] Deactivated for ${threadID}`);
      }

      if (body === "/nickall") {
        const data = groupLocks[threadID];
        if (!data || !data.enabled) return;
        const info = await api.getThreadInfo(threadID);
        for (const user of info.userInfo) {
          const nick = data.nick;
          groupLocks[threadID].original[user.id] = nick;
          await api.changeNickname(nick, threadID, user.id);
          await delay(Math.random() * 1400 + 1800);
        }
        saveLocks();
        console.log(`[REAPPLY] Nicknames reapplied for ${threadID}`);
      }

      if (body.startsWith("/gclock ")) {
        const customName = event.body.slice(8).trim();
        if (!customName) return;
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupName = customName;
        groupLocks[threadID].gclock = true;
        await api.setTitle(customName, threadID);
        saveLocks();
        console.log(`[GCLOCK] Locked group name to '${customName}' for ${threadID}`);
      }

      if (body === "/gclock") {
        const info = await api.getThreadInfo(threadID);
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupName = info.threadName;
        groupLocks[threadID].gclock = true;
        saveLocks();
        console.log(`[GCLOCK] Locked current group name for ${threadID}`);
      }

      if (body === "/unlockgname") {
        if (groupLocks[threadID]) delete groupLocks[threadID].gclock;
        saveLocks();
        console.log(`[GCLOCK] Unlocked group name for ${threadID}`);
      }
    }

    if (event.logMessageType === "log:user-nickname") {
      const group = groupLocks[threadID];
      if (!group || !group.enabled || group.cooldown) return;

      const uid = event.logMessageData.participant_id;
      const currentNick = event.logMessageData.nickname;
      const lockedNick = group.original[uid];

      if (lockedNick && currentNick !== lockedNick) {
        try {
          await api.changeNickname(lockedNick, threadID, uid);
          group.count++;
          if (group.count >= 60) {
            console.log(`[COOLDOWN] Triggered for ${threadID}`);
            group.cooldown = true;
            setTimeout(() => {
              group.cooldown = false;
              group.count = 0;
              console.log(`[COOLDOWN] Lifted for ${threadID}`);
            }, 180000);
          } else {
            await delay(Math.random() * 1400 + 1800);
          }
        } catch (e) {
          console.error("❌ Nick revert error:", e);
        }
      }
    }

    if (event.logMessageType === "log:thread-name") {
      const group = groupLocks[threadID];
      if (!group || !group.gclock) return;

      const currentName = event.logMessageData.name;
      if (group.groupName && currentName !== group.groupName) {
        try {
          await api.setTitle(group.groupName, threadID);
          console.log(`[GCLOCK] Reverted group name for ${threadID}`);
        } catch (e) {
          console.error("❌ Group name revert error:", e);
        }
      }
    }
  });
});

