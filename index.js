const fs = require("fs");
const path = require("path");
const http = require("http");
const { promisify } = require("util");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const LOGIN_RETRY_DELAY = 900000; // 15 मिनट
const ADMIN_UID = process.env.ADMIN_UID || "61578666851540";
const PORT = process.env.PORT || 10000;
const USE_PUPPETEER = true;

// try require ws3-fca
let login;
try {
  const ws3 = require("ws3-fca");
  login = typeof ws3 === "function" ? ws3 : (ws3.login || ws3.default || ws3);
} catch (e) {
  console.error("❌ ws3-fca not installed or failed to load. Install it first.");
  process.exit(1);
}

// attempt to load appstate
let appState;
const appStatePath = path.join(__dirname, "appstate.json");
if (process.env.APPSTATE_JSON) {
  try {
    appState = JSON.parse(process.env.APPSTATE_JSON);
  } catch (e) {
    console.error("❌ Failed to parse APPSTATE_JSON env var:", e.message);
    process.exit(1);
  }
} else if (fs.existsSync(appStatePath)) {
  try {
    appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  } catch (e) {
    console.error("❌ Failed to read appstate.json:", e.message);
    process.exit(1);
  }
} else {
  console.error("❌ No appstate found. Provide appstate.json or APPSTATE_JSON env var");
  process.exit(1);
}

// load groupData
const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = {};
if (fs.existsSync(groupDataPath)) {
  try { groupData = JSON.parse(fs.readFileSync(groupDataPath, "utf8")); } catch(e){ console.warn("⚠ Failed to parse groupData.json. Starting empty."); groupData = {}; }
} else {
  fs.writeFileSync(groupDataPath, JSON.stringify({}, null, 2));
}

// HTTP health server
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running.\n");
}).listen(PORT, () => console.log(`[${new Date().toLocaleTimeString()}] 🌐 HTTP server listening on port ${PORT}`));

/* ---------------------- Helpers ---------------------- */
function saveGroupData() {
  try { fs.writeFileSync(groupDataPath, JSON.stringify(groupData, null, 2)); } catch(e) { console.error("Failed save groupData:", e.message); }
}
async function backupAppState(api) {
  try {
    if (api && api.getAppState) {
      const s = api.getAppState();
      fs.writeFileSync(appStatePath, JSON.stringify(s, null, 2));
      console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
    }
  } catch (e) { console.warn("Appstate backup failed:", e.message); }
}

// appstate refresh
async function refreshAppState(api) {
  try {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Refreshing appstate...`);
    const newAppState = api.getAppState();
    if (newAppState && Array.isArray(newAppState)) {
      appState = newAppState;
      fs.writeFileSync(appStatePath, JSON.stringify(appState, null, 2));
      console.log(`[${new Date().toLocaleTimeString()}] ✅ Appstate refreshed and saved`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] ❌ Appstate refresh failed: ${e?.message || e}`);
    return false;
  }
}

/* ---------------------- Puppeteer fallback ---------------------- */
let puppeteer;
async function loadPuppeteer() {
  if (!USE_PUPPETEER) return null;
  if (!puppeteer) {
    try {
      puppeteer = require("puppeteer");
    } catch(e) {
      console.warn("Puppeteer not installed. Install 'puppeteer' to enable fallback.");
      return null;
    }
  }
  return puppeteer;
}

function appstateToCookies(appState) {
  const cookies = [];
  try {
    if (Array.isArray(appState)) {
      for (const kv of appState) {
        if (kv && typeof kv === 'object') {
          if (kv.name && kv.value) {
            cookies.push({ name: kv.name, value: kv.value, domain: ".facebook.com", path: "/", httpOnly: false, secure: true });
          } else if (kv.key && kv.value) {
            cookies.push({ name: kv.key, value: kv.value, domain: ".facebook.com", path: "/", httpOnly: false, secure: true });
          } else if (kv.cookies && Array.isArray(kv.cookies)) {
            for (const c of kv.cookies) cookies.push(Object.assign({ domain: ".facebook.com", path: "/" }, c));
          } else if (kv.name && kv.value && kv.domain) {
            cookies.push(Object.assign({ path: "/" }, kv));
          }
        }
      }
    }
  } catch (e) {
    console.warn("appstate->cookies parsing error:", e.message);
  }
  const uniq = [];
  const seen = new Set();
  for (const c of cookies) {
    const key = `${c.name}@${c.domain}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(c); }
  }
  return uniq;
}

/* ---------------------- Core: WS3-FCA login + features ---------------------- */
(async () => {
  let api;
  let isLoggedIn = false;
  async function attemptLogin() {
    if (isLoggedIn) {
      console.log(`[${new Date().toLocaleTimeString()}] ℹ️ Already logged in. Skipping login attempt.`);
      return true;
    }
    try {
      api = await new Promise((resolve, reject) => {
        try {
          login({ appState, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" }, (err, api2) => (err ? reject(err) : resolve(api2)));
        } catch (e) { reject(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: false });
      isLoggedIn = true;
      console.log(`[${new Date().toLocaleTimeString()}] ✅ Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : '(unknown)'}`);
      return true;
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ❌ Login via appstate failed: ${e?.message || e}`);
      isLoggedIn = false;
      return false;
    }
  }

  // Initial login
  if (!(await attemptLogin())) {
    console.error("❌ Login failed. Exiting.");
    process.exit(1);
  }

  // Periodic appstate refresh
  setInterval(async () => {
    if (!(await refreshAppState(api))) {
      console.log(`[${new Date().toLocaleTimeString()}] 🔄 Attempting re-login...`);
      isLoggedIn = false;
      await attemptLogin();
    }
  }, 5 * 60 * 1000);

  // in-memory nickname queue
  const nicknameQueue = [];
  const nickState = {};
  function queueNickname(threadID, userID, nick) {
    nicknameQueue.push({ threadID, userID, nick, retries: 0 });
  }

  // initialize: populate queue for mismatched nicks
  async function initCheck() {
    for (const threadID of Object.keys(groupData)) {
      console.log(`[${new Date().toLocaleTimeString()}] 🔍 Initializing group ${threadID}`);
      const g = groupData[threadID];
      if (g.nicknameLock && g.nicknames) {
        try {
          const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => err ? rej(err) : res(d)));
          const participants = info.participantIDs || info.userInfo?.map(u=>u.id) || [];
          for (const uid of participants) {
            const desired = g.nicknames[uid];
            if (!desired) continue;
            const current = (info.nicknames && info.nicknames[uid]) || info.userInfo?.find(u=>u.id===uid)?.nickname;
            if (current !== desired) queueNickname(threadID, uid, desired);
          }
        } catch (e) {
          console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Failed to initialize nicknames for ${threadID}: ${e?.message || e}`);
        }
      }
    }
  }

  // nickname processor
  (async function nicknameWorker() {
    while (true) {
      if (nicknameQueue.length === 0) { await sleep(1000); continue; }
      const job = nicknameQueue.shift();
      const { threadID, userID, nick } = job;
      try {
        if (!groupData[threadID] || !groupData[threadID].nicknameLock) continue;
        nickState[threadID] = nickState[threadID] || { count: 0 };
        if (nickState[threadID].count >= 60) {
          console.log(`[${new Date().toLocaleTimeString()}] ⏸️ Cooldown for ${threadID} (3 min)`);
          await sleep(3 * 60 * 1000);
          nickState[threadID].count = 0;
        }
        await new Promise((res, rej) => {
          api.changeNickname(nick, threadID, userID, (err) => (err ? rej(err) : res()));
        });
        nickState[threadID].count++;
        console.log(`[${new Date().toLocaleTimeString()}] ✏️ Nick reverted for ${userID} in ${threadID}`);
        await sleep(Math.floor(Math.random() * (7000 - 6000 + 1)) + 6000); // 6-7 सेकंड डिले
      } catch (e) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Nick revert failed for ${userID} in ${threadID}: ${e?.message || e}`);
        if (e?.error === 3252001) {
          console.log(`[${new Date().toLocaleTimeString()}] ⚠ Blocked (3252001). Retrying after ${LOGIN_RETRY_DELAY / 1000} seconds...`);
          await sleep(LOGIN_RETRY_DELAY);
        }
        job.retries = (job.retries || 0) + 1;
        if (job.retries < 3) {
          await sleep(60000);
          nicknameQueue.push(job);
        }
      }
    }
  })();

  // group name checker
  async function changeGroupTitleViaApi(threadID, newTitle) {
    try {
      if (typeof api.setTitle === "function") {
        await new Promise((res, rej) => api.setTitle(newTitle, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via API success for ${threadID}`);
        return true;
      } else {
        await new Promise((res, rej) => api.sendMessage(`/settitle ${newTitle}`, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via sendMessage success for ${threadID}`);
        return true;
      }
    } catch (e) {
      console.warn(`[${new Date().toLocaleTimeString()}] ❌ API setTitle failed for ${threadID}: ${e?.message || e}`);
      return false;
    }
  }

  async function fallbackPuppetChangeTitle(threadID, newTitle) {
    const pupp = await loadPuppeteer();
    if (!pupp) { console.warn("Puppeteer not available"); return false; }
    let browser;
    try {
      browser = await pupp.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
        defaultViewport: null
      });
      const page = await browser.newPage();
      const cookies = appstateToCookies(appState);
      if (cookies && cookies.length) {
        for (const c of cookies) {
          try {
            const cookieCopy = Object.assign({}, c);
            cookieCopy.url = 'https://www.messenger.com';
            await page.setCookie(cookieCopy);
          } catch (e) {}
        }
      }
      const url = `https://www.messenger.com/t/${threadID}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForTimeout(2000);
      const detailSelectors = [
        'div[aria-label="Conversation information"]',
        'a[role="button"][aria-label*="Conversation information"]',
        'div[aria-label="Conversation info"]',
        'header div[role="button"]'
      ];
      let opened = false;
      for (const sel of detailSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click();
            opened = true;
            break;
          }
        } सिrf ek group ka anti sleep ping aa raha hai aur wo bhi sent nhi ho raha kya dikkat hai aur kisi bhi group ka name change nhi ho raha kya dikkat hai aur 15 group ke liye kaise thik karein
        } catch (e) {}
      }
      await page.waitForTimeout(1500);
      const titleSelectors = [
        'input[aria-label*="Name"]',
        'input[aria-label*="conversation name"]',
        'div[role="dialog"] input'
      ];
      let success = false;
      try {
        const inputs = await page.$$('input');
        for (const inp of inputs) {
          try {
            const aria = await (await inp.getProperty('ariaLabel')).jsonValue().catch(()=>null);
            if (aria && /(name|conversation|title)/i.test(aria)) {
              await inp.click({ clickCount: 3 });
              await inp.type(newTitle, { delay: 50 });
              await page.keyboard.press('Enter');
              success = true;
              break;
            }
          } catch(e){}
        }
      } catch(e){}
      if (success) {
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 Puppeteer: changed title for ${threadID}`);
      } else {
        console.warn(`[${new Date().toLocaleTimeString()}] Puppeteer: could not find title input for ${threadID}. UI may have changed.`);
      }
      await page.waitForTimeout(1500);
      await browser.close();
      return success;
    } catch (e) {
      if (browser) try { await browser.close(); } catch(_) {}
      console.error("Puppeteer fallback error:", e?.message || e);
      return false;
    }
  }

  // periodic group name watcher
  (async function groupNameWatcher() {
    while (true) {
      try {
        const groupIDs = Object.keys(groupData);
        console.log(`[${new Date().toLocaleTimeString()}] 🔍 Starting group name check cycle for ${groupIDs.length} groups`);
        if (groupIDs.length === 0) {
          console.warn(`[${new Date().toLocaleTimeString()}] ⚠ No groups in groupData.json`);
          await sleep(45000);
          continue;
        }
        for (let i = 0; i < groupIDs.length; i++) {
          const threadID = groupIDs[i];
          console.log(`[${new Date().toLocaleTimeString()}] 🔍 Checking group ${threadID} (${i+1}/${groupIDs.length})`);
          const g = groupData[threadID];
          if (!g || !g.groupNameLock || !g.groupName) {
            console.log(`[${new Date().toLocaleTimeString()}] ℹ️ Group name lock disabled or no name set for ${threadID}`);
            continue;
          }
          try {
            const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => err ? rej(err) : res(d)));
            const currentName = info.threadName || info.name || null;
            if (currentName === null) {
              console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Thread ${threadID} returned null name`);
              continue;
            }
            if (currentName !== g.groupName) {
              console.log(`[${new Date().toLocaleTimeString()}] 🔍 Detected name mismatch for ${threadID}: "${currentName}" → "${g.groupName}"`);
              const okApi = await changeGroupTitleViaApi(threadID, g.groupName);
              if (!okApi) {
                const okP = await fallbackPuppetChangeTitle(threadID, g.groupName);
                if (!okP) {
                  console.warn(`[${new Date().toLocaleTimeString()}] ❌ Both API and Puppeteer failed to change title for ${threadID}`);
                }
              }
            } else {
              console.log(`[${new Date().toLocaleTimeString()}] ✅ Group name in ${threadID} is already ${g.groupName}`);
            }
          } catch (e) {
            console.warn(`[${new Date().toLocaleTimeString()}] ❌ groupNameWatcher error for ${threadID}: ${e?.message || e}`);
            if (e?.error === 1357031) {
              console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Group ${threadID} not accessible (1357031). Removing from groupData.`);
              delete groupData[threadID];
              saveGroupData();
            } else if (e?.error === 3252001) {
              console.log(`[${new Date().toLocaleTimeString()}] ⚠ Blocked (3252001). Retrying after ${LOGIN_RETRY_DELAY / 1000} seconds...`);
              await sleep(LOGIN_RETRY_DELAY);
              isLoggedIn = false;
              await attemptLogin();
            }
          }
          await sleep(2000); // 2 सेकंड डिले प्रति ग्रुप
        }
        await sleep(Math.max(45000 - (groupIDs.length * 2000), 1000)); // 45 सेकंड साइकिल
      } catch (e) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ groupNameWatcher crashed: ${e?.message || e}`);
        await sleep(60000); // 1 मिनट रिकवर
      }
    }
  })();

  // anti-sleep typing
  setInterval(async () => {
    try {
      const groupIDs = Object.keys(groupData);
      console.log(`[${new Date().toLocaleTimeString()}] 🔍 Starting anti-sleep cycle for ${groupIDs.length} groups`);
      if (groupIDs.length === 0) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ No groups in groupData.json for anti-sleep`);
        return;
      }
      for (let i = 0; i < groupIDs.length; i++) {
        const threadID = groupIDs[i];
        console.log(`[${new Date().toLocaleTimeString()}] 🔍 Sending anti-sleep ping to ${threadID} (${i+1}/${groupIDs.length})`);
        try {
          await new Promise((res, rej) => api.sendTypingIndicator(threadID, (err) => err ? rej(err) : res()));
          console.log(`[${new Date().toLocaleTimeString()}] 💤 Anti-sleep ping sent to ${threadID}`);
        } catch(e) {
          console.warn(`[${new Date().toLocaleTimeString()}] ❌ Anti-sleep ping failed for ${threadID}: ${e?.message || e}`);
          if (e?.error === 1357031) {
            console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Group ${threadID} not accessible (1357031). Removing from groupData.`);
            delete groupData[threadID];
            saveGroupData();
          }
        }
        await sleep(1000); // 1 सेकंड डिले प्रति ग्रुप
      }
      console.log(`[${new Date().toLocaleTimeString()}] ✅ Anti-sleep cycle completed`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ❌ Anti-sleep cycle crashed: ${e?.message || e}`);
    }
  }, 10 * 60 * 1000); // 10 मिनट साइकिल

  // appstate backup
  setInterval(() => backupAppState(api), 10 * 60 * 1000);

  // Event listener for admin commands
  api.listenMqtt(async (err, event) => {
    if (err || !event) {
      console.warn(`[${new Date().toLocaleTimeString()}] ❌ MQTT error: ${err?.message || err}`);
      isLoggedIn = false;
      await attemptLogin();
      return;
    }
    try {
      console.log(`[${new Date().toLocaleTimeString()}] 🔍 Received event:`, JSON.stringify(event, null, 2));
      if (event.type !== "message" || !event.body) return;
      const sender = event.senderID;
      const body = event.body.trim();
      const threadID = event.threadID;

      if (sender !== ADMIN_UID) return;

      if (body.startsWith("/gclock ")) {
        const newName = body.slice(8).trim();
        if (!newName) return;
        groupData[threadID] = groupData[threadID] || {};
        groupData[threadID].groupName = newName;
        groupData[threadID].groupNameLock = true;
        saveGroupData();
        console.log(`[${new Date().toLocaleTimeString()}] 🔒 Admin requested gclock -> ${newName}`);
        const okApi = await changeGroupTitleViaApi(threadID, newName);
        if (!okApi) {
          await fallbackPuppetChangeTitle(threadID, newName);
        }
        api.sendMessage(`🔒 Group name locked to "${newName}"`, threadID);
      }

      if (body === "/unlockgname") {
        if (groupData[threadID]) { 
          groupData[threadID].groupNameLock = false; 
          saveGroupData(); 
          console.log(`[${new Date().toLocaleTimeString()}] 🔓 Group unlocked for ${threadID}`); 
          api.sendMessage(`🔓 Group name lock disabled`, threadID);
        }
      }
    } catch (e) {
      console.warn(`[${new Date().toLocaleTimeString()}] ❌ Command handler error: ${e?.message || e}`);
    }
  });

  // initial mismatch scan for nicknames
  await initCheck();

  // monitor nickname changes
  api.listenMqtt((err, event) => {
    if (err || !event) return;
    try {
      if (event.logMessageType === "log:user-nickname") {
        const threadID = event.threadID;
        const uid = event.logMessageData?.participant_id;
        if (!uid || !threadID) return;
        if (!groupData[threadID] || !groupData[threadID].nicknameLock) return;
        const desired = groupData[threadID].nicknames?.[uid];
        const current = event.logMessageData?.nickname;
        if (desired && current !== desired) {
          queueNickname(threadID, uid, desired);
          console.log(`[${new Date().toLocaleTimeString()}] ✏️ Queued nick revert for ${uid} in ${threadID}`);
        }
      }
    } catch(e){}
  });

})();
