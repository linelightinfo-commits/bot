const fs = require("fs");
const express = require("express");
const login = require("ws3-fca");

const app = express();
const port = process.env.PORT || 10000;

// Load appState and group config
const appStateFile = "appstate.json";
const groupDataFile = "data.json";

let groupData = JSON.parse(fs.readFileSync(groupDataFile, "utf8"));

// Create HTTP server for Render
app.get("/", (req, res) => {
  res.send("Facebook Group Bot is running!");
});

app.listen(port, () => {
  console.log(`[HTTP] Server running on port ${port}`);
});

// Login
login({ appState: JSON.parse(fs.readFileSync(appStateFile, "utf8")) }, (err, api) => {
  if (err) return console.error(err);

  console.log("[BOT] Logged in successfully!");

  api.setOptions({
    listenEvents: true,
    selfListen: false
  });

  api.listenMqtt((err, event) => {
    if (err) return console.error(err);

    // Group name change detection
    if (event.type === "log:subscribe" || event.type === "log:unsubscribe") return;

    if (event.type === "event") {
      // Group name change
      if (event.logMessageType === "log:thread-name") {
        const groupId = event.threadID;
        if (groupData[groupId] && groupData[groupId].groupNameLock) {
          const desiredName = groupData[groupId].groupName;
          if (event.logMessageData.name !== desiredName) {
            console.log(`[GroupNameLock] Reverting name in group ${groupId}...`);
            api.setTitle(desiredName, groupId, (err) => {
              if (err) console.error(err);
            });
          }
        }
      }

      // Nickname change
      if (event.logMessageType === "log:user-nickname") {
        const groupId = event.threadID;
        if (groupData[groupId] && groupData[groupId].nicknameLock) {
          const userId = event.logMessageData.participant_id;
          const desiredNickname = groupData[groupId].nicknames[userId];

          if (desiredNickname && event.logMessageData.nickname !== desiredNickname) {
            console.log(`[NicknameLock] Nickname change detected for user ${userId} in group ${groupId}, reverting in 45s...`);
            setTimeout(() => {
              api.changeNickname(desiredNickname, userId, groupId, (err) => {
                if (err) console.error(err);
              });
            }, 45000); // 45 seconds
          }
        }
      }
    }
  });
});
