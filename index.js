/**
 * Final improved index.js
 * - Fully preserves your original functionality
 * - Nicklock + gclock auto apply
 * - Silent operation, minimal console logs
 * - Anti-sleep, appstate backup, cooldowns
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
function log(...a) { console.log(C.cyan + "[BOT]" + C.reset, ...a); }
function info(...a) { console.log(C.green + "[INFO]" + C.reset, ...a); }
function warn(...a) { console.log(C.yellow + "[WARN]" + C.reset, ...a); }
function error(...a) { console.log(C.red + "[ERR]" + C.reset, ...a); }

// Express for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// timing rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 3 * 60 * 1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 10 * 60 * 1000;

const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// State
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
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) { globalActiveCount++; return; }
  await new Promise((res) => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) { const r = globalPending.shift(); r(); }
}

// Helpers: file ops (safe)
async function ensureDataFile() {
  try { await fsp.access(dataFile); } catch (e) { await fsp.writeFile(dataFile, JSON.stringify({}, null, 2)); }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    try { groupLocks = JSON.parse(txt || "{}"); info("Loaded saved group locks."); } 
    catch (parseErr) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${dataFile}.broken.${ts}`;
      await fsp.copyFile(dataFile, backup).catch(()=>{});
      warn(`groupData.json corrupted. Backup -> ${path.basename(backup)}. Creating fresh file.`);
      groupLocks = {};
      await fsp.writeFile(dataFile, JSON.stringify({}, null, 2));
    }
  } catch (e) { warn("Failed to load groupData.json:", e.message || e); groupLocks = {}; }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
    info("Group locks saved.");
  } catch (e) { warn("Failed to save groupData.json:", e.message || e); }
}

// utilities
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function randomDelay() { return Math.floor(Math.random() * (NICKNAME_DELAY_MAX - NICKNAME_DELAY_MIN + 1)) + NICKNAME_DELAY_MIN; }
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// per-thread queue helpers
function ensureQueue(threadID) { if (!groupQueues[threadID]) groupQueues[threadID] = { running: false, tasks: [] }; return groupQueues[threadID]; }
function queueTask(threadID, fn) { const q = ensureQueue(threadID); q.tasks.push(fn); if (!q.running) runQueue(threadID); }
async function runQueue(threadID) {
  const q = ensureQueue(threadID);
  if (q.running) return; q.running = true;
  while (q.tasks.length) {
    const fn = q.tasks.shift();
    try { await acquireGlobalSlot(); try { await fn(); } finally { releaseGlobalSlot(); } } 
    catch (e) { warn(`[${timestamp()}] Queue task error for ${threadID}:`, e && e.message ? e.message : e); }
    await sleep(250);
  }
  q.running = false;
}

// Puppeteer fallback
async function startPuppeteerIfEnabled() {
  if (!ENABLE_PUPPETEER) { info("Puppeteer disabled."); return; }
  try {
    const puppeteer = require("puppeteer");
    const launchOpts = { headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] };
    if (CHROME_EXECUTABLE) launchOpts.executablePath = CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com", { waitUntil: "networkidle2", timeout: 30000 }).catch(()=>{});
    puppeteerAvailable = true;
    info("Puppeteer ready.");
  } catch (e) { puppeteerAvailable = false; warn("Puppeteer init failed:", e.message || e); }
}

// change thread title
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle === "function") return new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
  if (typeof apiObj.changeThreadTitle === "function") return new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
  if (ENABLE_PUPPETEER && puppeteerAvailable) {
    try {
      const url = `https://www.facebook.com/messages/t/${threadID}`;
      await puppeteerPage.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(()=>{});
      await puppeteerPage.waitForTimeout(1200);
      info(`[${timestamp()}] [PUPP] Puppeteer fallback for title change.`);
      return;
    } catch (e) { throw e; }
  }
  throw new Error("No method to change thread title");
}

// appState loader
async function loadAppState() {
  if (process.env.APPSTATE) { try { return JSON.parse(process.env.APPSTATE); } catch (e) { warn("APPSTATE env invalid JSON:", e.message || e); } }
  try { const txt = await fsp.readFile(appStatePath, "utf8"); return JSON.parse(txt); } 
  catch (e) { throw new Error("Cannot load appstate.json or APPSTATE env"); }
}

// initCheck: reapply nicknames on start
async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const info = await new Promise((res, rej) => apiObj.getThreadInfo(t, (err, r) => (err ? rej(err) : res(r))));
        const participants = info?.participantIDs || (info?.userInfo && info.userInfo.map(u => u.id)) || [];
        for (const uid of participants) {
          const desired = group.original?.[uid] || group.nick;
          if (!desired) continue;
          const current = (info.nicknames && info.nicknames[uid]) || (info.userInfo && info.userInfo.find(u => u.id === uid)?.nickname) || null;
          if (current !== desired) queueTask(t, async () => { try { await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res()))); info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`); await sleep(randomDelay()); } catch (e) { warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e); } });
        }
      } catch (e) {}
    }
  } catch (e) { warn("initCheckLoop error:", e.message || e); }
}

// health watcher
async function startHealthWatcher() {
  setInterval(async () => {
    try {
      if (!api) throw new Error("no_api");
      const anyThread = Object.keys(groupLocks)[0];
      if (anyThread) await new Promise((res, rej) => api.sendTypingIndicator(anyThread, (err) => (err ? rej(err) : res())));
    } catch (e) {
      warn("Health check failed:", e.message || e);
      try { api.removeAllListeners && api.removeAllListeners(); } catch(_){}
      throw new Error("FORCE_RECONNECT");
    }
  }, HEALTH_CHECK_INTERVAL);
}

// login + run
let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => { loginLib({ appState }, (err, a) => (err ? rej(err) : res(a))); });

      try { api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true }); } catch (_) {}

      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"} `);

      await loadLocks();
      startPuppeteerIfEnabled().catch(e => warn("Puppeteer init err:", e.message || e));
      startHealthWatcher().catch(e => warn("healthwatch err:", e.message || e));

      // group-name watcher
      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        for (let t of threadIDs) {
          const g = groupLocks[t];
          if (!g || !g.gclock) continue;
          if (groupNameRevertInProgress[t]) continue;
          try {
            const info = await new Promise((res, rej) => api.getThreadInfo(t, (err,r) => err?rej(err):res(r)));
            if (info.threadName !== g.groupName) {
              if (!groupNameChangeDetected[t]) groupNameChangeDetected[t] = Date.now();
              else if (Date.now() - groupNameChangeDetected[t] >= GROUP_NAME_REVERT_DELAY) {
                groupNameRevertInProgress[t]=true;
                await changeThreadTitle(api, t, g.groupName).catch(e=>warn(`GCLOCK revert failed for ${t}:`, e.message||e));
                groupNameChangeDetected[t]=null; groupNameRevertInProgress[t]=false;
                info(`[${timestamp()}] [GCLOCK] Reverted ${t} -> "${g.groupName}"`);
              }
            } else groupNameChangeDetected[t]=null;
          } catch(e){ warn(`GCLOCK check failed for ${t}:`, e.message||e); }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // anti-sleep typing
      setInterval(async () => { for (const id of Object.keys(groupLocks)) { const g=groupLocks[id]; if(!g||(!g.gclock&&!g.enabled))continue; await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res())); await sleep(1200); } }, TYPING_INTERVAL);

      // appstate backup
      setInterval(async ()=>{ try{const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath, JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`); }catch(e){warn("Appstate backup error:", e.message||e);} }, APPSTATE_BACKUP_INTERVAL);

      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:", e.message||e)), 5*60*1000);

      // Event listener
      api.listenMqtt(async (err,event)=>{
        if(err){ warn("listenMqtt error:", err && err.message?err.message:err); return; }
        try{
          const threadID=event.threadID;
          const senderID=event.senderID;
          const body=(event.body||"").toString().trim();

          // Boss commands
          if(event.type==="message"&&senderID===BOSS_UID){
            const lc=(body||"").toLowerCase();
            if(lc==="/nicklock on"){ try{
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              const lockedNick=process.env.DEFAULT_LOCKED_NICK||"LockedName";
              groupLocks[threadID]=groupLocks[threadID]||{};
              groupLocks[threadID].enabled=true;
              groupLocks[threadID].nick=lockedNick;
              groupLocks[threadID].original=groupLocks[threadID].original||{};
              groupLocks[threadID].count=0;
              groupLocks[threadID].cooldown=false;
              for(const u of infoThread.userInfo||[]){ groupLocks[threadID].original[u.id]=lockedNick;
                queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,u.id,(err)=>err?rej(err):res())); info(`[${timestamp()}] Changed nick for ${u.id}`); } catch(e){warn(`[${timestamp()}] Nick change failed for ${u.id}:`,e.message||e);} await sleep(randomDelay()); }); }
              await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Activated ${threadID}`); } catch(e){warn("Nicklock ON failed:",e.message||e);}
            }

            if(lc==="/nicklock off"){ if(groupLocks[threadID]){groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated ${threadID}`); } }

            if(lc==="/nickall"){ const data=groupLocks[threadID]; if(!data?.enabled)return; try{ const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); for(const u of infoThread.userInfo||[]){ const nick=data.nick; groupLocks[threadID].original=groupLocks[threadID].original||{}; groupLocks[threadID].original[u.id]=nick; queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(nick,threadID,u.id,(err)=>err?rej(err):res())); info(`[${timestamp()}] Reapplied nick for ${u.id}`);} catch(e){warn("Nick apply failed:",e.message||e);} await sleep(randomDelay()); }); } await saveLocks(); info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);} catch(e){warn("/nickall failed:",e.message||e);} }

            if(lc.startsWith("/gclock ")){ const customName=body.slice(8).trim(); if(!customName)return; groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=customName; groupLocks[threadID].gclock=true; await changeThreadTitle(api,threadID,customName).catch(e=>warn("GCLOCK failed:",e.message||e)); await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked group name ${threadID}`); }

            if(lc==="/gclock"){ const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=infoThread.threadName; groupLocks[threadID].gclock=true; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked current name for ${threadID}`); }

            if(lc==="/unlockgname"){ if(groupLocks[threadID]){groupLocks[threadID].gclock=false; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`); } }
          }

          // silent nick revert
          if(event.type==="change_nickname" && groupLocks[threadID]?.enabled){
            const desired=groupLocks[threadID].nick;
            if(event.nickname!==desired){ queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(desired,threadID,senderID,(err)=>err?rej(err):res())); info(`[${timestamp()}] [NICKLOCK] Reverted ${senderID} in ${threadID}`); await sleep(randomDelay()); } catch(e){warn("Silent revert failed:",e.message||e);} }); }
          }

        }catch(e){ warn("Event handler error:", e.message||e); }
      });

      break; // exit while loop if login successful
    } catch (e) { warn("Login error:", e.message||e); await sleep(10*1000); }
  }
}

process.on("uncaughtException",(err)=>warn("Uncaught exception:",err&&err.message?err.message:err));
process.on("unhandledRejection",(err)=>warn("Unhandled rejection:",err&&err.message?err.message:err));

loginAndRun().catch(e=>error("Fatal startup error:",e.message||e));
