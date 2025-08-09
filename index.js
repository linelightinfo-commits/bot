const fs = require("fs");
const path = require("path");
const http = require("http");
const { promisify } = require("util");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const LOGIN_RETRY_DELAY = 1200000; // 20 मिनट
const ADMIN_UID = process.env.ADMIN_UID || "61578666851540";
const PORT = process.env.PORT || 10000;
const USE_PUPPETEER = true;

// Try require ws3-fca or fallback to fca-unofficial
let login;
try {
  const ws3 = require("ws3-fca");
  login = typeof ws3 === "function" ? ws3 : (ws3.login || ws3.default || ws3);
} catch (e) {
  try {
    const fca = require("fca-unofficial");
    login = typeof fca === "function" ? fca : (fca.login || fca.default || fca);
    console.warn(`[${new Date().toLocaleTimeString()}] ⚠ ws3-fca failed, using fca-unofficial`);
  } catch (e2) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Neither ws3-fca nor fca-unofficial installed. Install one first.`);
    process.exit(1);
  }
}

// Load and validate appstate
let appState;
const appStatePath = path.join(__dirname, "appstate.json");
if (process.env.APPSTATE_JSON) {
  try {
    const parsed = JSON.parse(process.env.APPSTATE_JSON);
    if (Array.isArray(parsed) && parsed.every(item => item.key && item.value && item.domain)) {
      appState = parsed;
    } else {
      console.error(`[${new Date().toLocaleTimeString()}] ❌ APPSTATE_JSON is not a valid appstate array`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Failed to parse APPSTATE_JSON env var: ${e.message}`);
    process.exit(1);
  }
} else if (fs.existsSync(appStatePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    if (Array.isArray(parsed) && parsed.every(item => item.key && item.value && item.domain)) {
      appState = parsed;
    } else {
      console.error(`[${new Date().toLocaleTimeString()}] ❌ appstate.json is not a valid appstate array`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Failed to read appstate.json: ${e.message}`);
    process.exit(1);
  }
} else {
  console.error(`[${new Date().toLocaleTimeString()}] ❌ No appstate found. Provide appstate.json or APPSTATE_JSON env var`);
  process.exit(1);
}

// Load groupData
const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = {};
if (fs.existsSync(groupDataPath)) {
  try {
    groupData = JSON.parse(fs.readFileSync(groupDataPath, "utf8"));
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Failed to parse groupData.json. Starting empty.`);
    groupData = {};
  }
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
  try {
    fs.writeFileSync(groupDataPath, JSON.stringify(groupData, null, 2));
    console.log(`[${new Date().toLocaleTimeString()}] 💾 groupData.json saved`);
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Failed to save groupData: ${e.message}`);
  }
}

async function backupAppState(api) {
  try {
    if (api && api.getAppState) {
      const s = api.getAppState();
      if (Array.isArray(s) && s.every(item => item.key && item.value && item.domain)) {
        fs.writeFileSync(appStatePath, JSON.stringify(s, null, 2));
        console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
      }
    }
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Appstate backup failed: ${e.message}`);
  }
}

async function refreshAppState(api) {
  try {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Refreshing appstate...`);
    const newAppState = api.getAppState();
    if (Array.isArray(newAppState) && newAppState.every(item => item.key && item.value && item.domain)) {
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
    } catch (e) {
      console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Puppeteer not installed. Install 'puppeteer' for fallback.`);
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
        if (kv && typeof kv === "object") {
          if (kv.key && kv.value && kv.domain) {
            cookies.push({ name: kv.key, value: kv.value, domain: kv.domain, path: "/", httpOnly: false, secure: true });
          } else if (kv.name && kv.value && kv.domain) {
            cookies.push({ name: kv.name, value: kv.value, domain: kv.domain, path: "/", httpOnly: false, secure: true });
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] ⚠ appstate->cookies parsing error: ${e.message}`);
  }
  const uniq = [];
  const seen = new Set();
  for (const c of cookies) {
    const key = `${c.name}@${c.domain}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(c);
    }
  }
  return uniq;
}

/* ---------------------- Core: Login + Features ---------------------- */
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
        } catch (e) {
          reject(e);
        }
      });
      api.setOptions({ listenEvents: true, selfListen: false });
      isLoggedIn = true;
      console.log(`[${new Date().toLocaleTimeString()}] ✅ Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"}`);
      return true;
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ❌ Login via appstate failed: ${e?.message || e}`);
      isLoggedIn = false;
      return false;
    }
  }

  // Initial login
  if (!(await attemptLogin())) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Login failed. Exiting.`);
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

  // In-memory nickname queue
  const nicknameQueue = [];
  const nickState = {};
  function queueNickname(threadID, userID, nick) {
    nicknameQueue.push({ threadID, userID, nick, retries: 0 });
  }

  // Initialize: populate queue for mismatched nicknames
  async function initCheck() {
    for (const threadID of Object.keys(groupData)) {
      if (!/^[0-9]+$/.test(threadID)) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Invalid group ID ${threadID}. Skipping.`);
        continue;
      }
      console.log(`[${new Date().toLocaleTimeString()}] 🔍 Initializing group ${threadID}`);
      const g = groupData[threadID];
      if (!g) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Invalid group data for ${threadID}`);
        continue;
      }
      if (g.nicknameLock && g.nicknames) {
        try {
          const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => (err ? rej(err) : res(d))));
          const participants = info.participantIDs || info.userInfo?.map((u) => u.id) || [];
          for (const uid of participants) {
            const desired = g.nicknames[uid];
            if (!desired) continue;
            const current = (info.nicknames && info.nicknames[uid]) || info.userInfo?.find((u) => u.id === uid)?.nickname;
            if (current !== desired) {
              queueNickname(threadID, uid, desired);
              console.log(`[${new Date().toLocaleTimeString()}] ✏️ Queued nick revert for ${uid} in ${threadID}`);
            }
          }
        } catch (e) {
          console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Failed to initialize nicknames for ${threadID}: ${e?.message || e}`);
        }
      }
    }
  }

  // Nickname processor
  (async function nicknameWorker() {
    while (true) {
      if (nicknameQueue.length === 0) {
        await sleep(1000);
        continue;
      }
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

  // Group name changer
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
    if (!pupp) {
      console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Puppeteer not available`);
      return false;
    }
    let browser;
    try {
      browser = await pupp.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: true,
        defaultViewport: null,
      });
      const page = await browser.newPage();
      const cookies = appstateToCookies(appState);
      if (cookies && cookies.length) {
        for (const c of cookies) {
          try {
            const cookieCopy = Object.assign({}, c);
            cookieCopy.url = "https://www.messenger.com";
            await page.setCookie(cookieCopy);
          } catch (e) {}
        }
      }
      const url = `https://www.messenger.com/t/${threadID}`;
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForTimeout(2000);
      const detailSelectors = [
        'div[aria-label="Conversation information"]',
        'a[role="button"][aria-label*="Conversation information"]',
        'div[aria-label="Conversation info"]',
        'header div[role="button"]',
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
        } catch (e) {}
      }
      if (!opened) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Puppeteer: could not open conversation info for ${threadID}`);
        await browser.close();
        return false;
      }
      await page.waitForTimeout(1500);
      const titleSelectors = [
        'input[aria-label*="Name"]',
        'input[aria-label*="conversation name"]',
        'div[role="dialog"] input',
      ];
      let success = false;
      try {
        const inputs = await page.$$("input");
        for (const inp of inputs) {
          try {
            const aria = await (await inp.getProperty("ariaLabel")).jsonValue().catch(() => null);
            if (aria && /(name|conversation|title)/i.test(aria)) {
              await inp.click({ clickCount: 3 });
              await inp.type(newTitle, { delay: 50 });
              await page.keyboard.press("Enter");
              success = true;
              break;
            }
          } catch (e) {}
        }
      } catch (e) {}
      if (success) {
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 Puppeteer: changed title for ${threadID}`);
      } else {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Puppeteer: could not find title input for ${threadID}. UI may have changed.`);
      }
      await page.waitForTimeout(1500);
      await browser.close();
      return success;
    } catch (e) {
      if (browser) try { await browser.close(); } catch (_) {}
      console.error(`[${new Date().toLocaleTimeString()}] ❌ Puppeteer fallback error: ${e?.message || e}`);
      return false;
    }
  }

  // Periodic group name watcher
  (async function groupNameWatcher() {
    while (true) {
      try {
        const groupIDs = Object.keys(groupData).filter((id) => /^[0-9]+$/.test(id));
        console.log(`[${new Date().toLocaleTimeString()}] 🔍 Starting group name check cycle for ${groupIDs.length} groups`);
        if (groupIDs.length === 0) {
          console.warn(`[${new Date().toLocaleTimeString()}] ⚠ No valid groups in groupData.json`);
          await sleep(45000);
          continue;
        }
        for (let i = 0; i < groupIDs.length; i++) {
          const threadID = groupIDs[i];
          console.log(`[${new Date().toLocaleTimeString()}] 🔍 Checking group ${threadID} (${i + 1}/${groupIDs.length})`);
          const g = groupData[threadID];
          if (!g || !g.groupNameLock || !g.groupName) {
            console.log(`[${new Date().toLocaleTimeString()}] ℹ️ Group name lock disabled or no name set for ${threadID}`);
            continue;
          }
          try {
            const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => (err ? rej(err) : res(d))));
            const currentName = info.threadName || info.name || null;
            if (currentName === null) {
              console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Thread ${threadID} returned null name`);
              continue;
            }
            if (currentName !== g.groupName) {
              console.log(`[${new Date().toLocaleTimeString()}] 🔍 Detected name
