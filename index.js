/**
 * optimized-bot.js
 *
 * Features:
 * - Login via appstate (file or APPSTATE_JSON env)
 * - Nickname lock with disk-persistent queue and retries
 * - Per-user short cooldown to avoid duplicate queueing
 * - 3-min break after 60 changes per-group
 * - Random delay between nickname changes (1.8s - 3.2s)
 * - Group name lock (45s check) -> API first, Puppeteer fallback
 * - Puppeteer browser instance reused (launch on demand)
 * - Anti-sleep typing every 5m
 * - Appstate backup every 10m
 * - Single mqtt listener handles messages + log events
 * - Admin UID via ADMIN_UID env
 *
 * Files used:
 * - appstate.json OR APPSTATE_JSON env
 * - groupData.json (create if missing)
 * - nickQueue.json (auto-created & updated)
 *
 * NOTE: Deploy environments (Render) may need extra puppeteer/chrome setup.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { promisify } = require("util");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ADMIN_UID = process.env.ADMIN_UID || "61578631626802";
const PORT = process.env.PORT || 10000;
const USE_PUPPETEER = true; // set false to disable fallback
const NICK_QUEUE_PATH = path.join(__dirname, "nickQueue.json");
const GROUPDATA_PATH = path.join(__dirname, "groupData.json");
const APPSTATE_PATH = path.join(__dirname, "appstate.json");

// --- load ws3-fca ---
let login;
try {
  const ws3 = require("ws3-fca");
  login = typeof ws3 === "function" ? ws3 : (ws3.login || ws3.default || ws3);
} catch (e) {
  console.error("❌ ws3-fca not installed or failed to load. Install it first.");
  process.exit(1);
}

// --- load appstate (file or env) ---
let appState;
if (process.env.APPSTATE_JSON) {
  try {
    appState = JSON.parse(process.env.APPSTATE_JSON);
  } catch (e) {
    console.error("❌ Failed to parse APPSTATE_JSON:", e.message);
    process.exit(1);
  }
} else if (fs.existsSync(APPSTATE_PATH)) {
  try {
    appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
  } catch (e) {
    console.error("❌ Failed to read appstate.json:", e.message);
    process.exit(1);
  }
} else {
  console.error("❌ No appstate found. Provide appstate.json or APPSTATE_JSON env var");
  process.exit(1);
}

// --- load groupData (create if missing) ---
let groupData = {};
if (fs.existsSync(GROUPDATA_PATH)) {
  try { groupData = JSON.parse(fs.readFileSync(GROUPDATA_PATH, "utf8")); } catch (e) { console.warn("⚠ Failed to parse groupData.json, starting empty."); groupData = {}; }
} else {
  fs.writeFileSync(GROUPDATA_PATH, JSON.stringify({}, null, 2));
  groupData = {};
}

function saveGroupData() {
  try { fs.writeFileSync(GROUPDATA_PATH, JSON.stringify(groupData, null, 2)); } catch (e) { console.error("Failed to save groupData:", e.message); }
}

// --- HTTP health server ---
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running.\n");
}).listen(PORT, () => console.log(`[${new Date().toLocaleTimeString()}] 🌐 HTTP server listening on port ${PORT}`));

// --- nick queue persistence ---
let nickQueue = [];
function loadNickQueue() {
  try {
    if (fs.existsSync(NICK_QUEUE_PATH)) {
      nickQueue = JSON.parse(fs.readFileSync(NICK_QUEUE_PATH, "utf8")) || [];
    } else {
      nickQueue = [];
      fs.writeFileSync(NICK_QUEUE_PATH, JSON.stringify(nickQueue, null, 2));
    }
  } catch (e) {
    console.warn("⚠ Could not load nickQueue:", e.message);
    nickQueue = [];
  }
}
function saveNickQueue() {
  try { fs.writeFileSync(NICK_QUEUE_PATH, JSON.stringify(nickQueue, null, 2)); } catch (e) { console.warn("⚠ Failed to save nickQueue:", e.message); }
}
// periodic save every 10s to be safe (and on changes)
setInterval(saveNickQueue, 10 * 1000);

// load on startup
loadNickQueue();

// --- helper: throttled batch runner (limit concurrency) ---
function pLimit(concurrency = 5) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (queue.length === 0) return;
    if (active >= concurrency) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then((v) => { active--; resolve(v); next(); }).catch((err) => { active--; reject(err); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// --- Puppeteer lazy loader & appstate->cookies helper ---
let puppeteer = null;
let browserInstance = null;
async function loadPuppeteer() {
  if (!USE_PUPPETEER) return null;
  if (!puppeteer) {
    try {
      puppeteer = require("puppeteer-core");
    } catch (e) {
      try { puppeteer = require("puppeteer"); } catch (e2) { console.warn("Puppeteer not installed. Install 'puppeteer' to enable fallback."); return null; }
    }
  }
  return puppeteer;
}

function appstateToCookies(appState) {
  const cookies = [];
  try {
    if (Array.isArray(appState)) {
      for (const kv of appState) {
        if (!kv || typeof kv !== "object") continue;
        if (kv.name && kv.value) cookies.push({ name: kv.name, value: kv.value, domain: ".facebook.com", path: "/" });
        else if (kv.key && kv.value) cookies.push({ name: kv.key, value: kv.value, domain: ".facebook.com", path: "/" });
        else if (kv.cookies && Array.isArray(kv.cookies)) {
          for (const c of kv.cookies) cookies.push(Object.assign({ domain: ".facebook.com", path: "/" }, c));
        }
      }
    } else if (typeof appState === "object") {
      for (const k in appState) {
        if (typeof appState[k] === "string" && /(xs|c_user|fr|datr)/i.test(k)) {
          cookies.push({ name: k, value: appState[k], domain: ".facebook.com", path: "/" });
        }
      }
    }
  } catch (e) { /* ignore */ }
  const uniq = [];
  const seen = new Set();
  for (const c of cookies) {
    const key = `${c.name}@${c.domain}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(c); }
  }
  return uniq;
}

async function ensureBrowser() {
  const pupp = await loadPuppeteer();
  if (!pupp) return null;
  if (browserInstance) return { pupp, browser: browserInstance };
  try {
    // try launch; on Render you may need executablePath from env
    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (typeof pupp.launch === 'function') {
      browserInstance = await pupp.launch(launchOpts);
      return { pupp, browser: browserInstance };
    } else {
      console.warn("Puppeteer seems invalid.");
      return null;
    }
  } catch (e) {
    console.warn("Puppeteer launch failed:", e.message || e);
    return null;
  }
}

// Puppeteer fallback to change title
async function fallbackPuppetChangeTitle(threadID, newTitle) {
  try {
    const inst = await ensureBrowser();
    if (!inst) { console.warn("Puppeteer unavailable."); return false; }
    const { pupp, browser } = inst;
    const page = await browser.newPage();

    // set cookies
    const cookies = appstateToCookies(appState);
    if (cookies && cookies.length) {
      for (const c of cookies) {
        try {
          // set cookie by url
          const cookieCopy = Object.assign({}, c);
          cookieCopy.url = "https://www.messenger.com";
          await page.setCookie(cookieCopy);
        } catch (e) { /* ignore individual cookie errors */ }
      }
    }

    const url = `https://www.messenger.com/t/${threadID}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});

    // small waits & tries — FB UI changes often; try robust attempts
    await page.waitForTimeout(1500);

    // attempt: open conversation info then find editable input
    // try various selectors — best-effort
    const tryClickSelectors = [
      'a[aria-label*="Conversation information"]',
      'button[aria-label*="Conversation information"]',
      '[aria-label*="Conversation information"]',
      'header div[role="button"]'
    ];
    for (const sel of tryClickSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click().catch(()=>{}); await page.waitForTimeout(700); break; }
      } catch (e) {}
    }

    // try to find an input/textarea/contenteditable likely to be title
    let success = false;
    try {
      const inputs = await page.$$('input');
      for (const inp of inputs) {
        try {
          const aria = await (await inp.getProperty('ariaLabel')).jsonValue().catch(()=>null);
          if (aria && /(name|conversation|title)/i.test(aria)) {
            await inp.click({ clickCount: 3 }).catch(()=>{});
            await inp.type(newTitle, { delay: 40 }).catch(()=>{});
            await page.keyboard.press('Enter').catch(()=>{});
            success = true; break;
          }
        } catch (e){}
      }
      if (!success) {
        const edits = await page.$$('[contenteditable="true"]');
        for (const ed of edits) {
          try {
            const text = await (await ed.getProperty('innerText')).jsonValue().catch(()=>'');
            if (text && text.length < 200) {
              await ed.click({ clickCount: 3 }).catch(()=>{});
              await ed.type(newTitle, { delay: 40 }).catch(()=>{});
              await page.keyboard.press('Enter').catch(()=>{});
              success = true; break;
            }
          } catch (e){}
        }
      }
    } catch (e){}

    if (!success) {
      // fallback: click header then try first input
      try {
        await page.click('header').catch(()=>{});
        await page.waitForTimeout(1000);
        const maybeInput = await page.$('input');
        if (maybeInput) {
          await maybeInput.click({ clickCount: 3 }).catch(()=>{});
          await page.keyboard.type(newTitle).catch(()=>{});
          await page.keyboard.press('Enter').catch(()=>{});
          success = true;
        }
      } catch (e) {}
    }

    await page.waitForTimeout(1200);
    await page.close().catch(()=>{});
    if (success) console.log(`[${new Date().toLocaleTimeString()}] 🔁 Puppeteer changed title for ${threadID}`);
    else console.warn(`[${new Date().toLocaleTimeString()}] Puppeteer could not find title input for ${threadID}`);
    return success;
  } catch (e) {
    console.error("Puppeteer fallback error:", e?.message || e);
    return false;
  }
}

// --- Core: login & run ---
(async () => {
  let api;
  try {
    api = await new Promise((resolve, reject) => {
      try {
        login({ appState }, (err, api2) => (err ? reject(err) : resolve(api2)));
      } catch (e) { reject(e); }
    });
  } catch (e) {
    console.error("❌ Login via appstate failed:", e);
    process.exit(1);
  }

  api.setOptions({ listenEvents: true, selfListen: false });
  console.log(`[${new Date().toLocaleTimeString()}] ✅ Logged in. Starting services...`);

  // --- utility: backup appstate ---
  function backupAppState() {
    try {
      if (api && typeof api.getAppState === 'function') {
        const s = api.getAppState();
        fs.writeFileSync(APPSTATE_PATH, JSON.stringify(s, null, 2));
        console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
      }
    } catch (e) { console.warn("Appstate backup failed:", e.message || e); }
  }
  setInterval(backupAppState, 10 * 60 * 1000);

  // --- anti-sleep typing every 5m for locked groups only ---
  setInterval(() => {
    for (const threadID of Object.keys(groupData)) {
      try {
        if (groupData[threadID] && (groupData[threadID].groupNameLock || groupData[threadID].nicknameLock)) {
          api.sendTypingIndicator(threadID);
        }
      } catch (e) {}
    }
  }, 5 * 60 * 1000);

  // --- state for nickname processing ---
  const nickState = {}; // per-group count and lastReset timestamp
  const perUserCooldown = {}; // uid@thread -> timestamp until which we ignore requeues

  function makeUserKey(threadID, userID) { return `${threadID}:${userID}`; }

  function queueNickname(threadID, userID, nick) {
    // if group not enabled or no desired nick, skip
    if (!groupData[threadID] || !groupData[threadID].nicknameLock) return;
    const desired = groupData[threadID].nicknames?.[userID];
    if (!desired) return;
    // cooldown to avoid repeated queueing
    const key = makeUserKey(threadID, userID);
    const now = Date.now();
    if (perUserCooldown[key] && perUserCooldown[key] > now) {
      // still on cooldown
      return;
    }
    perUserCooldown[key] = now + (10 * 1000); // 10s short cooldown
    // push to queue (dedupe similar recent entry)
    nickQueue.push({ threadID, userID, nick: desired, retries: 0, queuedAt: now });
    saveNickQueue();
  }

  // --- initCheck: batch getThreadInfo for groups with nicknameLock ---
  async function initCheck() {
    const threads = Object.keys(groupData).filter(t => groupData[t].nicknameLock && groupData[t].nicknames);
    if (threads.length === 0) return;
    const limit = pLimit(6); // 6 concurrent
    await Promise.all(threads.map(t => limit(async () => {
      try {
        const info = await new Promise((res, rej) => api.getThreadInfo(t, (err, d) => err ? rej(err) : res(d)));
        const participants = info.participantIDs || info.userInfo?.map(u => u.id) || [];
        for (const uid of participants) {
          const desired = groupData[t].nicknames?.[uid];
          if (!desired) continue;
          const current = (info.nicknames && info.nicknames[uid]) || info.userInfo?.find(u => u.id === uid)?.nickname;
          if (current !== desired) queueNickname(t, uid, desired);
        }
      } catch (e) {
        // ignore single-group failures to avoid stopping init
      }
    })));
    console.log(`[${new Date().toLocaleTimeString()}] ✅ initCheck done. Queue length: ${nickQueue.length}`);
  }

  // --- nickname worker (single loop, persistent) ---
  (async function nicknameWorker() {
    while (true) {
      try {
        if (nickQueue.length === 0) { await sleep(1000); continue; }
        const job = nickQueue.shift();
        saveNickQueue();
        const { threadID, userID, nick } = job;
        if (!groupData[threadID] || !groupData[threadID].nicknameLock) continue;

        // ensure nickState init & cooldown reset logic (reset count every 10 minutes)
        nickState[threadID] = nickState[threadID] || { count: 0, lastReset: Date.now() };
        if (Date.now() - nickState[threadID].lastReset > (10 * 60 * 1000)) {
          nickState[threadID].count = 0;
          nickState[threadID].lastReset = Date.now();
        }

        if (nickState[threadID].count >= 60) {
          console.log(`[${new Date().toLocaleTimeString()}] ⏸️ ${threadID} reached 60 nick changes, pausing 3 min`);
          await sleep(3 * 60 * 1000);
          nickState[threadID].count = 0;
          nickState[threadID].lastReset = Date.now();
        }

        // attempt change
        try {
          await new Promise((res, rej) => {
            api.changeNickname(nick, threadID, userID, (err) => (err ? rej(err) : res()));
          });
          nickState[threadID].count++;
          console.log(`[${new Date().toLocaleTimeString()}] ✏️ Nick reverted for ${userID} in ${threadID}`);
          // random delay 1.8s - 3.2s
          await sleep(Math.floor(Math.random() * (3200 - 1800 + 1)) + 1800);
        } catch (e) {
          console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Nick revert failed for ${userID} in ${threadID}: ${e?.message || e}`);
          job.retries = (job.retries || 0) + 1;
          if (job.retries < 3) {
            // backoff then requeue
            await sleep(60 * 1000);
            nickQueue.push(job);
            saveNickQueue();
          } else {
            // give up after 3 tries
            console.warn(`[${new Date().toLocaleTimeString()}] ❌ Giving up nick revert for ${userID} in ${threadID}`);
          }
        }
      } catch (e) {
        console.warn("Nickname worker caught error:", e?.message || e);
        await sleep(2000);
      }
    }
  })();

  // --- changeGroupTitle via API (try) ---
  async function changeGroupTitleViaApi(threadID, newTitle) {
    try {
      if (typeof api.setTitle === "function") {
        await new Promise((res, rej) => api.setTitle(newTitle, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via API success for ${threadID}`);
        return true;
      } else {
        // fallback to sendMessage command if library maps it (may not exist)
        await new Promise((res, rej) => api.sendMessage(`/settitle ${newTitle}`, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via sendMessage success for ${threadID}`);
        return true;
      }
    } catch (e) {
      // API method not available or failed
      return false;
    }
  }

  // --- group name watcher (45s interval) ---
  (async function groupNameWatcher() {
    while (true) {
      try {
        for (const threadID of Object.keys(groupData)) {
          const g = groupData[threadID];
          if (!g || !g.groupNameLock || !g.groupName) continue;
          try {
            const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => err ? rej(err) : res(d)));
            const currentName = info.threadName || info.name || null;
            if (currentName === null) { console.warn(`[${new Date().toLocaleTimeString()}] Warning: ${threadID} returned null name`); continue; }
            if (currentName !== g.groupName) {
              console.log(`[${new Date().toLocaleTimeString()}] Detected name mismatch for ${threadID}: "${currentName}" -> "${g.groupName}"`);
              const okApi = await changeGroupTitleViaApi(threadID, g.groupName);
              if (!okApi) {
                await fallbackPuppetChangeTitle(threadID, g.groupName);
              }
            }
          } catch (e) {
            // ignore per-thread errors
          }
        }
      } catch (e) { console.warn("groupNameWatcher error:", e?.message || e); }
      await sleep(45 * 1000);
    }
  })();

  // --- single listener for messages and log events ---
  api.listenMqtt(async (err, event) => {
    if (err || !event) return;
    try {
      // MESSAGE events (admin commands)
      if (event.type === "message" && event.body) {
        const sender = event.senderID;
        const body = (event.body || "").trim();
        const threadID = event.threadID;
        if (sender === ADMIN_UID) {
          if (body.startsWith("/gclock ")) {
            const newName = body.slice(8).trim();
            if (!newName) return;
            groupData[threadID] = groupData[threadID] || {};
            groupData[threadID].groupName = newName;
            groupData[threadID].groupNameLock = true;
            saveGroupData();
            console.log(`[${new Date().toLocaleTimeString()}] Admin requested gclock -> ${newName} for ${threadID}`);
            const okApi = await changeGroupTitleViaApi(threadID, newName);
            if (!okApi) await fallbackPuppetChangeTitle(threadID, newName);
          } else if (body === "/unlockgname") {
            if (groupData[threadID]) { groupData[threadID].groupNameLock = false; saveGroupData(); console.log("Group unlocked:", threadID); }
          } else if (body.startsWith("/nicklock on")) {
            // optionally admin can enable nickname lock for current group with current mapping
            // (not implementing full UI here — user should edit groupData.json)
            console.log("Command /nicklock on received (no-op) — edit groupData.json to set nicknames.");
          } else if (body === "/initcheck") {
            // admin can trigger initCheck
            console.log("Admin triggered initCheck");
            await initCheck();
          }
        }
      }

      // LOG events (nickname changes)
      if (event.logMessageType === "log:user-nickname") {
        const threadID = event.threadID;
        const uid = event.logMessageData?.participant_id;
        if (!uid || !threadID) return;
        if (!groupData[threadID] || !groupData[threadID].nicknameLock) return;
        const desired = groupData[threadID].nicknames?.[uid];
        const current = event.logMessageData?.nickname;
        if (desired && current !== desired) {
          queueNickname(threadID, uid, desired);
          console.log(`[${new Date().toLocaleTimeString()}] Queued nick revert for ${uid} in ${threadID}`);
        }
      }
    } catch (e) {
      console.warn("Command/event handler error:", e?.message || e);
    }
  });

  // start initial check and then we're running
  await initCheck();

  console.log(`[${new Date().toLocaleTimeString()}] Bot ready. Nick queue length: ${nickQueue.length}`);
})(); // end main
