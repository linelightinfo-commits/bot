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

const BOSS_UID = "61578631626802";

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

  setInterval(() => {
    if (GROUP_THREAD_ID) {
      api.sendTypingIndicator(GROUP_THREAD_ID, true);
      setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
      console.log("💤 [Zzz] Bot thoda hil gaya... abhi zinda hai boss 🤭");
    }
  }, 300000);

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

    if (event.type === "message" && body.startsWith("/gclock")) {
      if (senderID !== BOSS_UID)
        return api.sendMessage("⛔ Aukat me reh le BC! 😤", threadID);

      try {
        const newName = event.body.slice(7).trim();
        GROUP_THREAD_ID = threadID;

        if (newName.length > 0) {
          await api.setTitle(newName, threadID);
          LOCKED_GROUP_NAME = newName;
          api.sendMessage(`🔒 Naam fix ho gaya bhai: "${LOCKED_GROUP_NAME}" 🤐`, threadID);
          console.log(`🛡️ [LOCKED] Naam lock hua custom: "${LOCKED_GROUP_NAME}"`);
        } else {
          const info = await api.getThreadInfo(threadID);
          LOCKED_GROUP_NAME = info.name;
          api.sendMessage(`🔒 Naam lock ho gaya: "${LOCKED_GROUP_NAME}"`, threadID);
          console.log(`🔐 [LOCKED] Naam pakad liya: "${LOCKED_GROUP_NAME}"`);
        }
      } catch (e) {
        api.sendMessage("❌ Naam lock nahi hua bhai 😩", threadID);
        console.error("❌ [GCLOCK ERROR]:", e);
      }
    }

    if (event.logMessageType === "log:thread-name" && threadID === GROUP_THREAD_ID) {
      const changedName = event.logMessageData.name;
      if (LOCKED_GROUP_NAME && changedName !== LOCKED_GROUP_NAME) {
        try {
          await api.setTitle(LOCKED_GROUP_NAME, threadID);
          api.sendMessage(
            `⚠️ Kisi ne naam badla! "${changedName}" se wapas "${LOCKED_GROUP_NAME}" 🛑`,
            threadID
          );
          console.log(`😤 [REVERT] Naam wapas ghuma diya: "${changedName}" -> "${LOCKED_GROUP_NAME}"`);
        } catch (e) {
          api.sendMessage("❌ Naam wapas nahi ghuma paya, admin bana mujhe! 😭", threadID);
          console.error("❌ [NAAM REVERT FAIL]:", e);
        }
      }
    }

    // 🔐 Nickname lock with delay and console-only block log
    if (event.type === "message" && body === "/nicklock on") {
      if (senderID !== BOSS_UID)
        return api.sendMessage("⛔ Sirf boss bol sakta hai mujhe 😎", threadID);

      try {
        const nickToLock = "😈😈 ᴢᴀʟɪᴍ࿐ʟᴀᴅᴋᴀ";
        const info = await api.getThreadInfo(threadID);
        const users = info.userInfo;

        originalNicknames = {};
        nickLockEnabled = true;

        api.sendMessage(`🔐 Nickname lock chalu ho gaya bhai... lagane de ab sabka! 😏`, threadID);

        // 🧠 Function to apply nickname with delay
        const applyNicknames = async () => {
          let count = 0;

          // Sabse pehle bot apna naam change kare
          const botUser = users.find((u) => u.id === api.getCurrentUserID());
          if (botUser) {
            try {
              originalNicknames[botUser.id] = nickToLock;
              await api.changeNickname(nickToLock, threadID, botUser.id);
              console.log(`✅ [BOT NICK] Apna nick change ho gaya`);
            } catch (err) {
              console.log("🚫 [BLOCKED] FB ne rok diya nickname change karne se (bot pe)");
            }
          }

          for (const u of users) {
            if (u.id === api.getCurrentUserID()) continue;

            try {
              await new Promise((res) =>
                setTimeout(res, Math.floor(Math.random() * 2000) + 3000)
              ); // 3-5 sec delay

              originalNicknames[u.id] = nickToLock;
              await api.changeNickname(nickToLock, threadID, u.id);
              console.log(`✅ Nickname changed: ${u.name} (${u.id})`);

              count++;
              if (count % 30 === 0) {
                console.log("⏳ [WAIT] 30 users ho gaye, 3 min ruk rahe...");
                await new Promise((res) => setTimeout(res, 180000));
              }
            } catch (err) {
              console.log(`🚫 [BLOCKED] FB ne rok diya: UID ${u.id}`);
            }
          }

          console.log("🎉 [DONE] Sabka nickname change ho gaya boss!");
          api.sendMessage(`✅ Nickname lock done! Ab koi bacha nahi... sab zalim ban gaye 😈`, threadID);
        };

        applyNicknames();
      } catch (err) {
        api.sendMessage("❌ Nickname lock nahi laga 😵", threadID);
        console.error("❌ [NICKLOCK ERROR]:", err);
      }
    }

    if (event.type === "message" && body === "/nicklock off") {
      if (senderID !== BOSS_UID)
        return api.sendMessage("⛔ Bhai boss hi bol sakta hai mujhe! 😤", threadID);

      nickLockEnabled = false;
      originalNicknames = {};
      api.sendMessage("🔓 Nickname lock hata diya gaya bhai 😌", threadID);
      console.log(`🚫 [NICKLOCK] Lock hata diya group: ${threadID}`);
    }

    if (nickLockEnabled && event.logMessageType === "log:user-nickname") {
      const changedUID = event.logMessageData.participant_id;
      const newNick = event.logMessageData.nickname;
      const originalNick = originalNicknames[changedUID];

      if (originalNick !== undefined && newNick !== originalNick) {
        try {
          await api.changeNickname(originalNick, threadID, changedUID);
          console.log(`↩️ [REVERT] "${newNick}" se wapas "${originalNick}" ban gaya (UID: ${changedUID})`);
        } catch (err) {
          console.error("❌ [NICK REVERT FAIL 😭]:", err);
        }
      }
    }
  });
});
