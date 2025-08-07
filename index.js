const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const http = require("http");

const appStateFile = path.join(__dirname, "appstate.json");
const groupDataFile = path.join(__dirname, "groupData.json");
let groupData = fs.existsSync(groupDataFile) ? JSON.parse(fs.readFileSync(groupDataFile, "utf8")) : {};

function saveGroupData() {
  fs.writeFileSync(groupDataFile, JSON.stringify(groupData, null, 2));
}

login({ appState: JSON.parse(fs.readFileSync(appStateFile, "utf8")) }, (err, api) => {
  if (err) {
    console.error("[Login Error]", err);
    return;
  }

  console.log(`[${new Date().toLocaleTimeString()}] ✅ Bot is running silently...`);

  const lockedGroups = Object.keys(groupData);

  // Set interval to update group name every 45s
  setInterval(() => {
    lockedGroups.forEach(async (groupID) => {
      try {
        const res = await api.getThreadInfo(groupID);
        const currentName = res.name;
        const expectedName = groupData[groupID]?.groupName;
        if (expectedName && currentName !== expectedName) {
          api.setTitle(expectedName, groupID, (err) => {
            if (!err) console.log(`[${new Date().toLocaleTimeString()}] 🔒 Group name reset for ${groupID}`);
          });
        }
      } catch {}
    });
  }, 45000);

  // nickname changer loop
  const nicknameQueue = [];

  setInterval(() => {
    if (nicknameQueue.length > 0) return; // already processing
    lockedGroups.forEach((groupID) => {
      if (groupData[groupID]?.nicknameLock) {
        api.getThreadInfo(groupID, (err, info) => {
          if (err) return;
          info.participantIDs.forEach((uid) => {
            const expectedNick = groupData[groupID].nicknames?.[uid];
            const current = info.nicknames?.[uid];
            if (expectedNick && current !== expectedNick) {
              nicknameQueue.push({ groupID, uid, nickname: expectedNick });
            }
          });
        });
      }
    });
  }, 60000);

  // process nickname queue
  let nicknameCounter = 0;
  const processQueue = async () => {
    if (nicknameQueue.length === 0) return;
    if (nicknameCounter >= 60) {
      nicknameCounter = 0;
      console.log(`[${new Date().toLocaleTimeString()}] ⏸️ Cooldown 3 mins`);
      return setTimeout(processQueue, 180000);
    }

    const { groupID, uid, nickname } = nicknameQueue.shift();
    api.changeNickname(nickname, groupID, uid, (err) => {
      if (!err) {
        nicknameCounter++;
        console.log(`[${new Date().toLocaleTimeString()}] ✏️ Nickname fixed in ${groupID}`);
      }
    });

    setTimeout(processQueue, Math.floor(Math.random() * 1200) + 3000); // 3–4.2s delay
  };
  setInterval(processQueue, 5000);

  // anti sleep
  setInterval(() => {
    lockedGroups.forEach((groupID) => {
      api.sendTypingIndicator(groupID);
    });
  }, 300000); // every 5 minutes

  // appstate backup every 10 min
  setInterval(() => {
    const appstate = api.getAppState();
    fs.writeFileSync(appStateFile, JSON.stringify(appstate, null, 2));
    console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
  }, 600000);
});

// ✅ Render HTTP health port
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is active.\n");
}).listen(port, () => {
  console.log(`[${new Date().toLocaleTimeString()}] 🌐 HTTP server running on port ${port}`);
});
