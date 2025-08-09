const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs").promises;
const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => console.log(`🌐 Bot server started on port ${PORT}`));

const BOSS_UID = "61578631626802";
const appStatePath = path.join(__dirname, "appstate.json");
const dataFile = path.join(__dirname, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = 45000;
const GROUP_NAME_REVERT_DELAY = 45000;
const NICKNAME_DELAY_MIN = 6000;
const NICKNAME_DELAY_MAX = 7000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 180000;
const TYPING_INTERVAL = 300000;
const APPSTATE_BACKUP_INTERVAL = 600000;

let groupLocks = {};
let groupNameChangeDetected = {};

async function loadLocks() {
  try {
    if (await fs.access(dataFile).then(() => true).catch(() => false)) {
      groupLocks = JSON.parse(await fs.readFile(dataFile, "utf8"));
      console.log("🔁 Loaded saved group locks.");
    }
  } catch (e) {
    console.error("❌ Failed to load groupData.json", e);
  }
}

async function saveLocks() {
  try {
    const tempPath = `${dataFile}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(groupLocks, null, 2));
    await fs.rename(tempPath, dataFile);
  } catch (e) {
    console.error("❌ Failed to save groupData.json", e);
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function randomDelay() {
  return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
}
function timestamp() {
  return new Date().toTimeString().split(" ")[0];
}

async function startPuppeteer() {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.goto("https://www.facebook.com", { waitUntil: "networkidle2" });
    console.log(`[${timestamp()}] 🛡 Puppeteer keep-alive started.`);

    setInterval(async () => {
      try {
        await page.reload({ waitUntil: "networkidle2" });
        console.log(`[${timestamp()}] 🔄 Puppeteer keep-alive refreshed.`);
      } catch (e) {
        console.error(`[${timestamp()}] ❌ Puppeteer refresh error:`, e.message);
      }
    }, 300000);
  } catch (e) {
    console.error(`[${timestamp()}] ❌ Puppeteer error:`, e.message);
  }
}

async function main() {
  startPuppeteer();

  let appState;
  try {
    appState = JSON.parse(await fs.readFile(appStatePath, "utf8"));
  } catch (e) {
    console.error("❌ Cannot read appstate.json! Exiting.", e);
    process.exit(1);
  }

  let api;
  try {
    api = await new Promise((resolve, reject) => {
      login({ appState }, (err, api) => (err ? reject(err) : resolve(api)));
    });
    api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
    console.log(`✅ Logged in as: ${api.getCurrentUserID()}`);
  } catch (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }

  await loadLocks();

  setInterval(async () => {
    for (const threadID of Object.keys(groupLocks)) {
      const group = groupLocks[threadID];
      if (!group?.gclock) continue;

      try {
        const info = await new Promise((resolve, reject) => {
          api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
        });

        if (info && info.threadName !== group.groupName) {
          if (!groupNameChangeDetected[threadID]) {
            groupNameChangeDetected[threadID] = Date.now();
          } else if (Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY) {
            await new Promise((resolve, reject) => {
              api.setTitle(group.groupName, threadID, (err) => (err ? reject(err) : resolve()));
            });
            console.log(`[${timestamp()}] [GCLOCK] Reverted group name for ${threadID}`);
            groupNameChangeDetected[threadID] = null;
          }
        } else {
          groupNameChangeDetected[threadID] = null;
        }
      } catch (e) {
        console.warn(`[${timestamp()}] [GCLOCK] Error for ${threadID}:`, e?.message || e);
      }
    }
  }, GROUP_NAME_CHECK_INTERVAL);

  setInterval(async () => {
    for (const id of Object.keys(groupLocks)) {
      try {
        await api.sendTypingIndicator(id, true);
        await delay(1500);
        await api.sendTypingIndicator(id, false);
      } catch {}
    }
  }, TYPING_INTERVAL);

  setInterval(async () => {
    try {
      await fs.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2));
      console.log(`[${timestamp()}] 💾 Appstate backed up.`);
    } catch {}
  }, APPSTATE_BACKUP_INTERVAL);

  api.listenMqtt(async (err, event) => {
    if (err) return;
    const threadID = event.threadID;
    const senderID = event.senderID;
    const body = (event.body || "").toLowerCase();

    if (event.logMessageType === "log:user-nickname") {
      const group = groupLocks[threadID];
      if (!group?.enabled || group.cooldown) return;

      const uid = event.logMessageData.participant_id;
      const currentNick = event.logMessageData.nickname;
      const lockedNick = group.original[uid];

      if (lockedNick && currentNick !== lockedNick) {
        try {
          await new Promise((resolve, reject) => {
            api.changeNickname(lockedNick, threadID, uid, (err) => (err ? reject(err) : resolve()));
          });
          group.count++;
          console.log(`[${timestamp()}] [NICKLOCK] Reverted nickname for ${uid} in ${threadID}`);
          if (group.count >= NICKNAME_CHANGE_LIMIT) {
            group.cooldown = true;
            setTimeout(() => {
              group.cooldown = false;
              group.count = 0;
            }, NICKNAME_COOLDOWN);
          } else {
            await delay(randomDelay());
          }
        } catch {}
      }
    }

    if (event.type === "message" && senderID === BOSS_UID) {
      if (body === "/nicklock on") {
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
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
            try {
              await new Promise((resolve, reject) => {
                api.changeNickname(lockedNick, threadID, user.id, (err) => (err ? reject(err) : resolve()));
              });
              await delay(randomDelay());
            } catch {}
          }
          await saveLocks();
          console.log(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
        } catch {}
      }

      if (body === "/nicklock off") {
        if (groupLocks[threadID]) delete groupLocks[threadID].enabled;
        await saveLocks();
        console.log(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);
      }

      if (body === "/nickall") {
        const data = groupLocks[threadID];
        if (!data?.enabled) return;
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
          for (const user of info.userInfo) {
            const nick = data.nick;
            groupLocks[threadID].original[user.id] = nick;
            try {
              await new Promise((resolve, reject) => {
                api.changeNickname(nick, threadID, user.id, (err) => (err ? reject(err) : resolve()));
              });
              await delay(randomDelay());
            } catch {}
          }
          await saveLocks();
          console.log(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
        } catch {}
      }

      if (body.startsWith("/gclock ")) {
        const customName = event.body.slice(8).trim();
        if (!customName) return;
        groupLocks[threadID] = groupLocks[threadID] || {};
        groupLocks[threadID].groupName = customName;
        groupLocks[threadID].gclock = true;
        try {
          await new Promise((resolve, reject) => {
            api.setTitle(customName, threadID, (err) => (err ? reject(err) : resolve()));
          });
          await saveLocks();
          console.log(`[${timestamp()}] [GCLOCK] Locked group name to '${customName}' for ${threadID}`);
        } catch {}
      }

      if (body === "/gclock") {
        try {
          const info = await new Promise((resolve, reject) => {
            api.getThreadInfo(threadID, (err, res) => (err ? reject(err) : resolve(res)));
          });
          groupLocks[threadID] = groupLocks[threadID] || {};
          groupLocks[threadID].groupName = info.threadName;
          groupLocks[threadID].gclock = true;
          await saveLocks();
          console.log(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID}`);
        } catch {}
      }

      if (body === "/unlockgname") {
        if (groupLocks[threadID]) delete groupLocks[threadID].gclock;
        await saveLocks();
        console.log(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`);
      }
    }
  });
}

main();
