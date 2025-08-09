
const fs = require("fs");
const path = require("path");
const http = require("http");
const { promisify } = require("util");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const LOGIN_RETRY_DELAY = 60 * 1000; // 1 minute retry spacing for some ops
const ADMIN_UID = process.env.ADMIN_UID || "61578631626802";
const PORT = process.env.PORT || 10000;
const USE_PUPPETEER = true; // fallback enabled

// try require ws3-fca
let login;
try {
  const ws3 = require("ws3-fca");
  login = typeof ws3 === "function" ? ws3 : (ws3.login || ws3.default || ws3);
} catch (e) {
  console.error("❌ ws3-fca not installed or failed to load. Install it first.");
  process.exit(1);
}

// attempt to load appstate either from file or env
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

// load groupData (if missing create empty)
const groupDataPath = path.join(__dirname, "groupData.json");
let groupData = {};
if (fs.existsSync(groupDataPath)) {
  try { groupData = JSON.parse(fs.readFileSync(groupDataPath, "utf8")); } catch(e){ console.warn("⚠ Failed to parse groupData.json. Starting empty."); groupData = {}; }
} else {
  fs.writeFileSync(groupDataPath, JSON.stringify({}, null, 2));
}

// HTTP health server (Render needs)
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running.\n");
}).listen(PORT, () => console.log(`[${new Date().toLocaleTimeString()}] 🌐 HTTP server listening on port ${PORT}`));

/* ---------------------- Helpers ---------------------- */
function saveGroupData() {
  try { fs.writeFileSync(groupDataPath, JSON.stringify(groupData, null, 2)); } catch(e) { console.error("Failed save groupData:", e.message); }
}
function backupAppState(api) {
  try {
    if (api && api.getAppState) {
      const s = api.getAppState();
      fs.writeFileSync(appStatePath, JSON.stringify(s, null, 2));
      console.log(`[${new Date().toLocaleTimeString()}] 💾 Appstate backed up`);
    }
  } catch (e) { console.warn("Appstate backup failed:", e.message); }
}

/* ---------------------- Puppeteer fallback ----------------------
  We'll attempt to convert ws3-fca appstate -> browser cookies,
  then set those cookies in Puppeteer and load Messenger thread URL and set title via DOM.
  This is best-effort: appstate structure varies. If conversion fails,
  Puppeteer might still require manual cookies.
-----------------------------------------------------------------*/
let puppeteer;
async function loadPuppeteer() {
  if (!USE_PUPPETEER) return null;
  if (!puppeteer) {
    try {
      puppeteer = require("puppeteer-core");
    } catch(e) {
      try { puppeteer = require("puppeteer"); } catch(e2) { console.warn("Puppeteer not installed. Install 'puppeteer' or 'puppeteer-core' to enable fallback."); return null; }
    }
  }
  return puppeteer;
}

// try to extract cookies from appState (best-effort)
function appstateToCookies(appState) {
  // ws3-fca/appstate may contain tokens or cookies objects; look for common cookie names
  // returns array of { name, value, domain, path, expires, httpOnly, secure }
  const cookies = [];
  try {
    // appState might be an array of objects with keys like 'name','value','domain'
    if (Array.isArray(appState)) {
      for (const kv of appState) {
        if (kv && typeof kv === 'object') {
          // many appstate formats use { key, value } or { name, value }
          if (kv.name && kv.value) {
            // domain unknown — use .facebook.com
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
    } else if (typeof appState === 'object') {
      for (const k in appState) {
        const v = appState[k];
        if (typeof v === 'string' && (k === 'xs' || k === 'c_user' || k === 'fr' || k === 'datr')) {
          cookies.push({ name: k, value: v, domain: ".facebook.com", path: "/", httpOnly: false, secure: true });
        }
      }
    }
  } catch (e) {
    console.warn("appstate->cookies parsing error:", e.message);
  }
  // filter unique
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
  // login via appstate
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
  console.log(`[${new Date().toLocaleTimeString()}] ✅ Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : '(unknown)'}`);
  console.log(`[${new Date().toLocaleTimeString()}] ✅ Bot is running silently...`);

  // in-memory nickname queue
  const nicknameQueue = [];
  const nickState = {}; // track per-group counts
  // helper add job
  function queueNickname(threadID, userID, nick) {
    nicknameQueue.push({ threadID, userID, nick, retries: 0 });
  }

  // initialize: populate queue for currently mismatched nicks (safe)
  async function initCheck() {
    for (const threadID of Object.keys(groupData)) {
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
        } catch (e) { /* ignore per-group init failure */ }
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
        // ensure group exists in data
        if (!groupData[threadID] || !groupData[threadID].nicknameLock) continue;
        // throttling check
        nickState[threadID] = nickState[threadID] || { count: 0 };
        if (nickState[threadID].count >= 60) {
          console.log(`[${new Date().toLocaleTimeString()}] ⏸️ Cooldown for ${threadID} (3 min)`);
          await sleep(3 * 60 * 1000);
          nickState[threadID].count = 0;
        }
        // change
        await new Promise((res, rej) => {
          api.changeNickname(nick, threadID, userID, (err) => (err ? rej(err) : res()));
        });
        nickState[threadID].count++;
        console.log(`[${new Date().toLocaleTimeString()}] ✏️ Nick reverted for ${userID} in ${threadID}`);
        await sleep(Math.floor(Math.random() * (3200 - 1800 + 1)) + 1800);
      } catch (e) {
        console.warn(`[${new Date().toLocaleTimeString()}] ⚠ Nick revert failed for ${userID} in ${threadID}: ${e?.message || e}`);
        // retry with limit
        job.retries = (job.retries || 0) + 1;
        if (job.retries < 3) {
          await sleep(60000);
          nicknameQueue.push(job);
        } else {
          // give up
        }
      }
    }
  })();

  // group name checker: tries api.setTitle first, if fails uses fallbackPuppetChangeTitle
  async function changeGroupTitleViaApi(threadID, newTitle) {
    try {
      // some ws3-fca versions provide setTitle, or sendMessage with /settitle may work
      if (typeof api.setTitle === "function") {
        await new Promise((res, rej) => api.setTitle(newTitle, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via API success for ${threadID}`);
        return true;
      } else {
        // try sendMessage command (if ws3-fca maps it)
        await new Promise((res, rej) => api.sendMessage(`/settitle ${newTitle}`, threadID, (err) => (err ? rej(err) : res())));
        console.log(`[${new Date().toLocaleTimeString()}] 🔁 setTitle via sendMessage success for ${threadID}`);
        return true;
      }
    } catch (e) {
      console.warn(`[${new Date().toLocaleTimeString()}] ❌ API setTitle failed for ${threadID}: ${e?.message || e}`);
      return false;
    }
  }

  // Puppeteer fallback that tries to set cookies from appstate
  async function fallbackPuppetChangeTitle(threadID, newTitle) {
    const pupp = await loadPuppeteer();
    if (!pupp) { console.warn("Puppeteer not available"); return false; }
    let browser;
    try {
      // Launch Puppeteer. Using regular puppeteer (without chrome path) — on Render, you might need a proper chrome binary.
      browser = await pupp.launch({
        args: pupp.executablePath ? [] : ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
        defaultViewport: null
      });
      const page = await browser.newPage();

      // set cookies from appstate if possible
      const cookies = appstateToCookies(appState);
      if (cookies && cookies.length) {
        // set domain properly for messenger.com / facebook.com
        for (const c of cookies) {
          try {
            const cookieCopy = Object.assign({}, c);
            cookieCopy.url = 'https://www.messenger.com';
            // puppeteer's page.setCookie expects name/value/url or domain/path
            await page.setCookie(cookieCopy);
          } catch (e) { /* ignore */ }
        }
      }

      // Go to messenger thread page
      // threadID often used in facebook messages links: https://www.messenger.com/t/<threadID>
      const url = `https://www.messenger.com/t/${threadID}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Wait for title edit UI
      // DOM varies; try selectors used by Messenger web UI:
      // Click on group info button, open settings, find title input and change it.
      // These selectors may need adjustments if FB changes UI.
      // We'll try a robust approach with several attempts.

      // open conversation settings: look for "i" icon or header button
      await page.waitForTimeout(2000);

      // Try open conversation details
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
        } catch (e) {}
      }
      // if not opened, try pressing the "i" via keyboard (kinda fragile)
      if (!opened) {
        try {
          await page.keyboard.press('Control'); // no-op helps
        } catch(e){}
      }

      await page.waitForTimeout(1500);

      // now try to find title input
      const titleSelectors = [
        'input[placeholder="Search in conversation"]', // not title; but try
        'input[aria-label*="Name"]',
        'input[aria-label*="conversation name"]',
        'div[role="dialog"] input'
      ];

      let success = false;
      // Try a generic approach: find editable element with contenteditable or input in details pane
      try {
        // open right pane: messenger may show details with XPath
        // query for any input elements in page
        const inputs = await page.$$('input');
        for (const inp of inputs) {
          try {
            const aria = await (await inp.getProperty('ariaLabel')).jsonValue().catch(()=>null);
            // If aria suggests name or title, set value
            if (aria && /(name|conversation|title)/i.test(aria)) {
              await inp.click({ clickCount: 3 });
              await inp.type(newTitle, { delay: 50 });
              await page.keyboard.press('Enter');
              success = true;
              break;
            }
          } catch(e){}
        }
        if (!success) {
          // try contenteditable elements
          const edits = await page.$$('[contenteditable="true"]');
          for (const ed of edits) {
            try {
              const text = await (await ed.getProperty('innerText')).jsonValue().catch(()=>'');
              if (text && text.length < 200) { // candidate for title
                await ed.click({ clickCount: 3 });
                await ed.type(newTitle, { delay: 50 });
                await page.keyboard.press('Enter');
                success = true;
                break;
              }
            } catch(e){}
          }
        }
      } catch(e){}

      if (!success) {
        // As last resort, trigger the group settings modal via clicking on the header node
        // and attempt to find the title field there
        try {
          // click header to open details
          await page.click('header', { timeout: 2000 }).catch(()=>{});
          await page.waitForTimeout(1000);
          const maybeInput = await page.$('input');
          if (maybeInput) {
            await maybeInput.focus();
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.type(newTitle);
            await page.keyboard.press('Enter');
            success = true;
          }
        } catch(e){}
      }

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
      for (const threadID of Object.keys(groupData)) {
        const g = groupData[threadID];
        if (!g.groupNameLock || !g.groupName) continue;
        try {
          // get thread info
          const info = await new Promise((res, rej) => api.getThreadInfo(threadID, (err, d) => err ? rej(err) : res(d)));
          const currentName = info.threadName || info.name || null;
          if (currentName === null) {
            // thread might be inaccessible
            console.warn(`[${new Date().toLocaleTimeString()}] Warning: thread ${threadID} returned null name`);
            continue;
          }
          if (currentName !== g.groupName) {
            console.log(`[${new Date().toLocaleTimeString()}] Detected name mismatch for ${threadID}: "${currentName}" → "${g.groupName}"`);
            // try API
            const okApi = await changeGroupTitleViaApi(threadID, g.groupName);
            if (!okApi) {
              // fallback to puppeteer
              const okP = await fallbackPuppetChangeTitle(threadID, g.groupName);
              if (!okP) {
                console.warn(`[${new Date().toLocaleTimeString()}] Both API and Puppeteer failed to change title for ${threadID}`);
              }
            }
          }
        } catch (e) {
          console.warn(`[${new Date().toLocaleTimeString()}] groupNameWatcher error for ${threadID}:`, e?.message || e);
        }
      }
      await sleep(45 * 1000);
    }
  })();

  // anti-sleep typing
  setInterval(() => {
    for (const threadID of Object.keys(groupData)) {
      try { api.sendTypingIndicator(threadID); } catch(e){}
    }
    // console.log(`[${new Date().toLocaleTimeString()}] Anti-sleep ping sent`);
  }, 5 * 60 * 1000);

  // appstate backup
  setInterval(() => backupAppState(api), 10 * 60 * 1000);

  // Event listener for admin commands (admin can still use /gclock to force immediate change)
  api.listenMqtt(async (err, event) => {
    if (err || !event) return;
    try {
      if (event.type !== "message" || !event.body) return;
      const sender = event.senderID;
      const body = event.body.trim();
      const threadID = event.threadID;

      if (sender !== ADMIN_UID) return;

      // /gclock <name> => sets lock and immediately tries to change
      if (body.startsWith("/gclock ")) {
        const newName = body.slice(8).trim();
        if (!newName) return;
        groupData[threadID] = groupData[threadID] || {};
        groupData[threadID].groupName = newName;
        groupData[threadID].groupNameLock = true;
        saveGroupData();
        console.log(`[${new Date().toLocaleTimeString()}] Admin requested gclock -> ${newName}`);
        // try immediate change
        const okApi = await changeGroupTitleViaApi(threadID, newName);
        if (!okApi) {
          await fallbackPuppetChangeTitle(threadID, newName);
        }
      }

      // /unlockgname
      if (body === "/unlockgname") {
        if (groupData[threadID]) { groupData[threadID].groupNameLock = false; saveGroupData(); console.log("Group unlocked"); }
      }

      // (You can add more admin-only commands if needed)
    } catch (e) {
      console.warn("Command handler error:", e?.message || e);
    }
  });

  // initial mismatch scan for nicknames to queue
  await initCheck();

  // also monitor nickname changes from logs (if library emits log:user-nickname events)
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
          console.log(`[${new Date().toLocaleTimeString()}] Queued nick revert for ${uid} in ${threadID}`);
        }
      }
    } catch(e){}
  });

}); // end login
