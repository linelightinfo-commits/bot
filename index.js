const login = require("ws3-fca");
const fs = require("fs");
const path = require("path");

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));
const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = fs.existsSync(groupDataPath) ? JSON.parse(fs.readFileSync(groupDataPath, "utf8")) : {};

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.random() * (max - min) + min));

login({ appState }, (err, api) => {
    if (err) return console.error(err);

    console.log(`[${new Date().toLocaleTimeString()}] Bot started with groupData.json auto lock`);

    // Anti-sleep
    setInterval(() => {
        Object.keys(groupData).forEach(tid => {
            api.sendTypingIndicator(tid, err => {
                if (!err) console.log(`[${new Date().toLocaleTimeString()}] Sent typing to ${tid}`);
            });
        });
    }, 5 * 60 * 1000);

    // Group name lock check
    setInterval(async () => {
        for (const tid of Object.keys(groupData)) {
            const lock = groupData[tid];
            if (lock.groupName) {
                api.getThreadInfo(tid, (err, info) => {
                    if (!err && info.threadName !== lock.groupName) {
                        api.setTitle(lock.groupName, tid, () => {
                            console.log(`[${new Date().toLocaleTimeString()}] Reverted group name for ${tid}`);
                        });
                    }
                });
            }
        }
    }, 45 * 1000);

    // Nickname lock loop
    async function nicknameLockLoop() {
        for (const tid of Object.keys(groupData)) {
            const lock = groupData[tid];
            if (lock.nicknames) {
                api.getThreadInfo(tid, async (err, info) => {
                    if (!err) {
                        for (const uid of Object.keys(lock.nicknames)) {
                            const targetNick = lock.nicknames[uid];
                            const member = info.participantIDs.find(id => id == uid);
                            if (member) {
                                const currentNick = info.nicknames[uid] || "";
                                if (currentNick !== targetNick) {
                                    api.changeNickname(targetNick, uid, tid, () => {
                                        console.log(`[${new Date().toLocaleTimeString()}] Nickname reverted for ${uid} in ${tid}`);
                                    });
                                    await randomDelay(3000, 4000);
                                }
                            }
                        }
                    }
                });
            }
        }
        setTimeout(nicknameLockLoop, 5000);
    }

    nicknameLockLoop();
});
