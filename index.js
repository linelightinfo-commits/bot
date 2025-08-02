const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Facebook Bot is dancing online! Logs are in console 🎉");
});
app.listen(PORT, () => {
  console.log(`🌐 [SERVER] Bot ka chhota server ab nach raha hai on port ${PORT} 🚀`);
});

const BOSS_UID = "61578631626802"; // 👑 Mera malik

const appStatePath = "appstate.json";
const appState = JSON.parse(fs.readFileSync(appStatePath, "utf-8"));

let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let nickLockEnabled = false;
let originalNicknames = {};

const loginOptions = {
  appState,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/350.0.0.8.103",
};

login(loginOptions, (err, api) => {
  if (err) return console.error("❌ [LOGIN TUT GAYA 😭]:", err);

  api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });

  console.log("🤖 [BOT] Ab mai jag gaya hoon! Bol kya kaam hai boss 😈");

  // 💤 Anti-sleep every 5 min
  setInterval(() => {
    if (GROUP_THREAD_ID) {
      api.sendTypingIndicator(GROUP_THREAD_ID, true);
      setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
      console.log("💤 [Zzz] Bot thoda hil gaya... abhi zinda hai boss 🤭");
    }
  }, 300000);

  // 💾 Appstate auto-save
  setInterval(() => {
    try {
      const newAppState = api.getAppState();
      fs.writeFileSync(appStatePath, JSON.stringify(newAppState, null, 2));
      console.log("💾 [Backup] Appstate safe kar diya bhai 🚨");
    } catch (e) {
      console.error("❌ [Backup fail hogya 😵]:", e);
    }
  }, 600000);

  api.listenMqtt(async (err, event) => {
    if (err) return console.error("❌ [SUNAI NHI DE RAHA BHAI 😵‍💫]:", err);

    const senderID = event.senderID;
    const threadID = event.threadID;
    const body = (event.body || "").toLowerCase();

    if (event.type === "message") {
      console.log(`📩 [MSG] ${senderID} ne bola: ${event.body} | Group: ${threadID}`);
    }

    // 🔒 Group Name Lock
    if (event.type === "message" && body.startsWith("/gclock")) {
      const newName = event.body.slice(7).trim();
      GROUP_THREAD_ID = threadID;

      try {
        if (newName.length > 0) {
          await api.setTitle(newName, threadID);
          LOCKED_GROUP_NAME = newName;
          api.sendMessage(`🔒 Naam fix ho gaya bhai: "${LOCKED_GROUP_NAME}" 🤐`, threadID);
        } else {
          const info = await api.getThreadInfo(threadID);
          LOCKED_GROUP_NAME = info.name;
          api.sendMessage(`🔒 Naam lock ho gaya: "${LOCKED_GROUP_NAME}"`, threadID);
        }
      } catch (e) {
        api.sendMessage("❌ Naam lock nahi hua bhai 😩", threadID);
      }
    }

    // 🔁 Revert group name
    if (event.logMessageType === "log:thread-name") {
      const changedName = event.logMessageData.name;
      if (LOCKED_GROUP_NAME && changedName !== LOCKED_GROUP_NAME) {
        try {
          await api.setTitle(LOCKED_GROUP_NAME, threadID);
          api.sendMessage(`⚠️ Naam change detect hua! Wapas "${LOCKED_GROUP_NAME}" 🔁`, threadID);
        } catch (e) {
          api.sendMessage("❌ Naam wapas nahi ghuma paya, admin bana mujhe! 😭", threadID);
        }
      }
    }

    // 🔐 Nickname lock ON
    if (event.type === "message" && body === "/nicklock on") {
      const nickToLock = "💀 𒆜 𝕯𝖊𝖆𝖙𝖍 𝕸𝖆𝖘𝖙𝖊𝖗 𒆜";
      try {
        const info = await api.getThreadInfo(threadID);
        originalNicknames = {};
        nickLockEnabled = true;
        for (const u of info.userInfo) {
          originalNicknames[u.id] = nickToLock;
          await api.changeNickname(nickToLock, threadID, u.id);
        }
        api.sendMessage(`🔐 Nickname lock lag gaya bhai! Sab ban gaye: "${nickToLock}" 😆`, threadID);
      } catch (err) {
        api.sendMessage("❌ Nickname lock nahi laga 😵", threadID);
      }
    }

    // 🔓 Nickname lock OFF
    if (event.type === "message" && body === "/nicklock off") {
      nickLockEnabled = false;
      originalNicknames = {};
      api.sendMessage("🔓 Nickname lock hata diya gaya bhai 😌", threadID);
    }

    // 🔁 Revert nickname if changed
    if (nickLockEnabled && event.logMessageType === "log:user-nickname") {
      const changedUID = event.logMessageData.participant_id;
      const newNick = event.logMessageData.nickname;
      const originalNick = originalNicknames[changedUID];

      if (originalNick !== undefined && newNick !== originalNick) {
        try {
          await api.changeNickname(originalNick, threadID, changedUID);
          console.log(`↩️ Nickname revert: "${newNick}" -> "${originalNick}"`);
        } catch (err) {
          console.error("❌ [NICK REVERT FAIL]:", err);
        }
      }
    }

    // 🆕 /nickall [nickname]
    if (event.type === "message" && body.startsWith("/nickall ")) {
      const nick = event.body.slice(9).trim();
      try {
        const info = await api.getThreadInfo(threadID);
        for (const u of info.userInfo) {
          await api.changeNickname(nick, threadID, u.id);
        }
        api.sendMessage(`✅ Sabka nickname ban gaya: "${nick}" 😎`, threadID);
      } catch (err) {
        api.sendMessage("❌ Nickname change nahi hua 😩", threadID);
      }
    }
  });
});
