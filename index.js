/**
 * Ultimate Facebook Messenger Bot - ws3-fca + Puppeteer fallback
 * Features: nicklock, /nickall, gclock, anti-sleep, Render friendly, stealth, robust
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

// ======= Console colors =======
const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
const log = (...a) => console.log(C.cyan + "[BOT]" + C.reset, ...a);
const info = (...a) => console.log(C.green + "[INFO]" + C.reset, ...a);
const warn = (...a) => console.log(C.yellow + "[WARN]" + C.reset, ...a);
const error = (...a) => console.log(C.red + "[ERR]" + C.reset, ...a);

// ======= Express for health check =======
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot Online!"));
app.listen(PORT, () => log(`Server live at port ${PORT}`));

// ======= Config =======
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// Timing rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 300000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 600000;
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 600000;

const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// ======= State =======
let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;
let shuttingDown = false;

// Global concurrency limiter
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() { if (globalActiveCount < GLOBAL_MAX_CONCURRENT) { globalActiveCount++; return; } await new Promise(res => globalPending.push(res)); globalActiveCount++; }
function releaseGlobalSlot() { globalActiveCount = Math.max(0, globalActiveCount - 1); if (globalPending.length) { const r = globalPending.shift(); r(); } }

// ======= Helpers =======
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = () => Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN;
const timestamp = () => new Date().toTimeString().split(" ")[0];

// Safe file ops
async function ensureDataFile() { try { await fsp.access(dataFile); } catch { await fsp.writeFile(dataFile, JSON.stringify({}, null, 2)); } }
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    try { groupLocks = JSON.parse(txt || "{}"); info("Loaded group locks."); } 
    catch { const backup = `${dataFile}.broken.${Date.now()}`; await fsp.copyFile(dataFile, backup).catch(()=>{}); groupLocks = {}; await fsp.writeFile(dataFile, JSON.stringify({}, null, 2)); warn("Corrupt groupData.json backed up."); }
  } catch (e) { warn("Failed to load locks:", e.message || e); groupLocks = {}; }
}
async function saveLocks() { try { const tmp = `${dataFile}.tmp`; await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2)); await fsp.rename(tmp, dataFile); info("Group locks saved."); } catch (e) { warn("Failed saving locks:", e.message || e); }

// Queue helpers
function ensureQueue(threadID) { if (!groupQueues[threadID]) groupQueues[threadID] = { running: false, tasks: [] }; return groupQueues[threadID]; }
function queueTask(threadID, fn) { const q = ensureQueue(threadID); q.tasks.push(fn); if (!q.running) runQueue(threadID); }
async function runQueue(threadID) { const q = ensureQueue(threadID); if (q.running) return; q.running = true; while (q.tasks.length) { const fn = q.tasks.shift(); try { await acquireGlobalSlot(); try { await fn(); } finally { releaseGlobalSlot(); } } catch (e) { warn(`[${timestamp()}] Queue error ${threadID}:`, e.message || e); } await sleep(250); } q.running = false; }

// ======= Puppeteer fallback =======
async function startPuppeteerIfEnabled() {
  if (!ENABLE_PUPPETEER) { info("Puppeteer disabled."); return; }
  try {
    const puppeteer = require("puppeteer");
    const launchOpts = { headless:true, args:["--no-sandbox","--disable-setuid-sandbox"] };
    if (CHROME_EXECUTABLE) launchOpts.executablePath = CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
    puppeteerAvailable = true; info("Puppeteer ready.");
  } catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:", e.message || e); }
}

// Change group title
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle==="function") return new Promise((res,rej)=>apiObj.setTitle(title,threadID,(err)=>err?rej(err):res()));
  if (typeof apiObj.changeThreadTitle==="function") return new Promise((res,rej)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?rej(err):res()));
  if (ENABLE_PUPPETEER && puppeteerAvailable) { try { await puppeteerPage.goto(`https://www.facebook.com/messages/t/${threadID}`,{waitUntil:"networkidle2",timeout:30000}); await puppeteerPage.waitForTimeout(1200); info(`[${timestamp()}] [PUPP] Title fallback attempted for ${threadID}`); return; } catch(e){throw e;} }
  throw new Error("No method to change thread title");
}

// Load appstate
async function loadAppState() {
  if (process.env.APPSTATE) try { return JSON.parse(process.env.APPSTATE); } catch(e){ warn("Invalid APPSTATE env"); }
  try { const txt = await fsp.readFile(appStatePath,"utf8"); return JSON.parse(txt); } catch(e){ throw new Error("Cannot load appstate"); }
}

// ======= Group name watcher (GCLOCK) =======
async function startGroupNameWatcher() {
  const threadIDs = Object.keys(groupLocks);
  for (const threadID of threadIDs) {
    const group = groupLocks[threadID];
    if (!group || !group.gclock) continue;
    if (groupNameRevertInProgress[threadID]) continue;

    try {
      let infoObj = null;
      for (let attempt=1; attempt<=3; attempt++){
        try { infoObj = await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); if(infoObj) break;} 
        catch(e){ if(attempt<3) await sleep(2000); }
      }

      if(!infoObj && ENABLE_PUPPETEER && puppeteerAvailable){
        try { await puppeteerPage.goto(`https://www.facebook.com/messages/t/${threadID}`,{waitUntil:"networkidle2",timeout:30000}); await puppeteerPage.waitForTimeout(1200); info(`[${timestamp()}] [GCLOCK][PUPP] Fallback used ${threadID}`); return; } 
        catch(e){ warn(`[${timestamp()}] [GCLOCK][PUPP] Failed ${threadID}: ${e.message || e}`); }
      }

      if(!infoObj){ warn(`[${timestamp()}] [GCLOCK] Cannot fetch thread info ${threadID}`); continue; }

      const currentName = infoObj.threadName;
      if(currentName!==group.groupName){
        if(!groupNameChangeDetected[threadID]){ groupNameChangeDetected[threadID]=Date.now(); info(`[${timestamp()}] [GCLOCK] Change detected ${threadID} -> "${currentName}". Revert in ${GROUP_NAME_REVERT_DELAY/1000}s`); }
        else if(Date.now() - groupNameChangeDetected[threadID] >= GROUP_NAME_REVERT_DELAY){
          groupNameRevertInProgress[threadID]=true;
          try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`); } 
          catch(e){ warn(`[${timestamp()}] [GCLOCK] Revert failed ${threadID}: ${e.message || e}`); } 
          finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false; }
        }
      } else groupNameChangeDetected[threadID]=null;

    } catch(e){ warn(`[${timestamp()}] [GCLOCK] Unexpected error ${threadID}: ${e.message || e}`); }
  }
}

// ======= Nickname changer =======
async function changeNicknames(threadID) {
  const group = groupLocks[threadID]; if(!group || !group.nicklock || !group.nicknames?.length) return;
  let count = 0;
  while(count < NICKNAME_CHANGE_LIMIT && !shuttingDown){
    for(const nick of group.nicknames){
      await queueTask(threadID, async ()=>{
        try{ await api.setNickname(nick,threadID); info(`[${timestamp()}] [NICK] ${threadID} -> ${nick}`);} 
        catch(e){ warn(`[${timestamp()}] [NICK] Failed ${threadID} -> ${nick}: ${e.message || e}`);}
        await sleep(randomDelay());
      });
      count++;
      if(count>=NICKNAME_CHANGE_LIMIT) break;
    }
    await sleep(NICKNAME_COOLDOWN);
  }
}

// ======= Anti-sleep =======
async function startAntiSleep() {
  const threads = Object.keys(groupLocks);
  for(const t of threads){ if(!groupLocks[t]) continue; api.sendTyping(t,()=>{}); }
}

// ======= Appstate backup =======
async function backupAppState() {
  try{
    const state = await api.getAppState?.() || await fsp.readFile(appStatePath,"utf8");
    await fsp.writeFile(`${appStatePath}.bak`, JSON.stringify(state,null,2));
    info("Appstate backed up.");
  } catch(e){ warn("Appstate backup failed:",e.message||e);}
}

// ======= Main =======
(async ()=>{
  info("Starting bot...");
  const appstate = await loadAppState();
  api = await loginLib({ appState: appstate });
  info(`Logged in as: ${api.getCurrentUserID?.()||"unknown"}`);
  await loadLocks();
  await startPuppeteerIfEnabled();

  // Start intervals
  setInterval(startGroupNameWatcher,GROUP_NAME_CHECK_INTERVAL);
  setInterval(startAntiSleep,TYPING_INTERVAL);
  setInterval(backupAppState,APPSTATE_BACKUP_INTERVAL);
})();
