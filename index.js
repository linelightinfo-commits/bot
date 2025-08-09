const fs = require("fs");
const login = require("ws3-fca");
const express = require("express");
const app = express();
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
const APPSTATE_FILE = path.join(__dirname, "appstate.json");

// Agar data.json missing hai to default file banado
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
    console.log("📂 data.json file created!");
}

// Agar appstate.json missing hai to error
if (!fs.existsSync(APPSTATE_FILE)) {
    console.error("❌ Missing appstate.json! Please upload your Appstate file.");
    process.exit(1);
}

let groupData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(groupData, null, 2));
}

// Express server (Render alive rakhega)
app.get("/", (req, res) => res.send("✅ Bot is running..."));
app.listen(10000, () => console.log("🌐 HTTP server running on port 10000"));

// Facebook login
login({ appState: JSON.parse(fs.readFileSync(APPSTATE_FILE, "utf8")) }, (err, api) => {
    if (err) return console.error(err);

    console.log("✅ Bot logged in successfully!");

    api.listenMqtt((err, event) => {
        if (err) return console.error(err);

        // Group Name Change
        if (event.type === "event" && event.logMessageType === "log:thread-name") {
            let groupID = event.threadID;
            if (groupData[groupID]?.groupNameLock) {
                setTimeout(() => {
                    api.setTitle(groupData[groupID].groupName, groupID, (err) => {
                        if (!err) console.log(`🔒 Group name reset: ${groupData[groupID].groupName}`);
                    });
                }, 45000); // 45 second delay
            }
        }

        // Nickname Change
        if (event.type === "event" && event.logMessageType === "log:user-nickname") {
            let groupID = event.threadID;
            if (groupData[groupID]?.nicknameLock) {
                setTimeout(() => {
                    for (let uid in groupData[groupID].nicknames) {
                        api.changeNickname(groupData[groupID].nicknames[uid], groupID, uid, (err) => {
                            if (!err) console.log(`🔒 Nickname reset for ${uid}`);
                        });
                    }
                }, 45000); // 45 second delay
            }
        }
    });
});
