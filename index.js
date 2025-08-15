/**
 * Stable GCLOCK + Nicklock Bot
 * Modified version of your original script
 * Handles null thread info, retries, Puppeteer fallback
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

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15 * 1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 3000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 4000;
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

// concurrency limiter
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

// safe file ops
async function ensureDataFile() {
  try { await fsp.access(dataFile); } catch { await fsp.writeFile(dataFile, "{}"); }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    try { groupLocks = JSON.parse(txt || "{}"); info("Loaded group locks."); }
    catch {
      groupLocks = {}; await fsp.writeFile(dataFile, "{}"); warn("Corrupt JSON, fresh groupData.json created.");
    }
  } catch (e) { warn("Failed to load groupData.json:", e.message || e); groupLocks = {}; }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
  } catch (e) { warn("Failed to save groupData.json:", e.message || e); }
}

// helpers
const sleep = ms => new Promise(res => setTimeout(res, ms));
function randomDelay() { return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1)) + NICKNAME_DELAY_MIN; }
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// queue
function ensureQueue(threadID) { if (!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID, fn) { const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID);}
async function runQueue(threadID) {
  const q=ensureQueue(threadID);
  if(q.running) return;
  q.running=true;
  while(q.tasks.length){
    const fn=q.tasks.shift();
    try { await acquireGlobalSlot(); try{await fn();} finally{releaseGlobalSlot();} } catch(e){warn(`[${timestamp()}] Queue error ${threadID}:`,e?.message||e);}
    await sleep(250);
  }
  q.running=false;
}

// Puppeteer fallback
async function startPuppeteerIfEnabled(){
  if(!ENABLE_PUPPETEER){ info("Puppeteer disabled."); return;}
  try{
    const puppeteer=require("puppeteer");
    puppeteerBrowser=await puppeteer.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"],executablePath:CHROME_EXECUTABLE||undefined});
    puppeteerPage=await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    puppeteerAvailable=true;
    info("Puppeteer ready.");
  } catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:",e.message||e); }
}

// change thread title (safe)
async function changeThreadTitle(apiObj, threadID, title){
  if(!apiObj) throw new Error("No api");
  if(typeof apiObj.setTitle==="function") return new Promise((r,rej)=>apiObj.setTitle(title,threadID,(err)=>err?rej(err):r()));
  if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?rej(err):r()));
  if(ENABLE_PUPPETEER && puppeteerAvailable){
    try{
      const url=`https://www.facebook.com/messages/t/${threadID}`;
      await puppeteerPage.goto(url,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
      await puppeteerPage.waitForTimeout(1200);
      info(`[${timestamp()}] [PUPP] Puppeteer fallback attempted for title change.`);
    } catch(e){ throw e; }
  }
  throw new Error("No method to change thread title");
}

// load appstate
async function loadAppState(){
  if(process.env.APPSTATE){ try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("APPSTATE invalid JSON:",e.message||e);} }
  const txt=await fsp.readFile(appStatePath,"utf8");
  return JSON.parse(txt);
}

// init check
async function initCheckLoop(apiObj){
  try{
    const threadIDs=Object.keys(groupLocks);
    for(let t of threadIDs){
      const group=groupLocks[t];
      if(!group?.enabled) continue;
      let infoObj=null;
      for(let i=0;i<3;i++){ // retry 3 times
        try{ infoObj=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r))); break;} catch{await sleep(1500);}
      }
      if(!infoObj) continue;
      const participants=infoObj?.participantIDs||infoObj?.userInfo?.map(u=>u.id)||[];
      for(const uid of participants){
        const desired=group.original?.[uid]||group.nick;
        if(!desired) continue;
        const current=(infoObj.nicknames && infoObj.nicknames[uid])||(infoObj.userInfo?.find(u=>u.id===uid)?.nickname)||null;
        if(current!==desired){
          queueTask(t,async()=>{
            try{
              await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res()));
              info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);
              await sleep(randomDelay());
            } catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message||e); }
          });
        }
      }
    }
  } catch(e){ warn("initCheckLoop error:", e.message||e);}
}

// Health watcher
async function startHealthWatcher(){
  setInterval(async()=>{
    try{
      if(!api) throw new Error("no_api");
      const anyThread=Object.keys(groupLocks)[0];
      if(anyThread) await new Promise((res,rej)=>api.sendTypingIndicator(anyThread,(err)=>err?rej(err):res()));
    } catch(e){ warn("Health watcher error:", e.message||e); }
  },HEALTH_CHECK_INTERVAL);
}

// Main login + run
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api=await new Promise((res,rej)=>loginLib({appState},(err,a)=>err?rej(err):res(a)));
      try{ api.setOptions({listenEvents:true,selfListen:true,updatePresence:true}); }catch(_){}
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"(unknown)"}`);
      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init error:",e.message||e));
      startHealthWatcher().catch(e=>warn("Health watcher error:",e));

      // GCLOCK poller
      setInterval(async()=>{
        const threadIDs=Object.keys(groupLocks);
        for(const threadID of threadIDs){
          const group=groupLocks[threadID];
          if(!group?.gclock || groupNameRevertInProgress[threadID]) continue;
          let infoObj=null;
          for(let i=0;i<3;i++){ // retry 3 times
            try{ infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); break; }catch{await sleep(1000);}
          }
          if(!infoObj) { warn(`[${timestamp()}] [GCLOCK] Cannot fetch thread info for ${threadID}`); continue; }
          if(infoObj.threadName!==group.groupName){
            if(!groupNameChangeDetected[threadID]) groupNameChangeDetected[threadID]=Date.now();
            else if(Date.now()-groupNameChangeDetected[threadID]>=GROUP_NAME_REVERT_DELAY){
              groupNameRevertInProgress[threadID]=true;
              try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`);}
              catch(e){ warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`,e.message||e);}
              finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false;}
            }
          } else groupNameChangeDetected[threadID]=null;
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep typing indicator
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          try{
            const g=groupLocks[id];
            if(!g?.gclock && !g?.enabled) continue;
            await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res()));
            await sleep(1200);
          }catch(e){ warn(`[${timestamp()}] Typing indicator failed for ${id}:`,e.message||e); }
        }
      },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{
        try{
          const s=api.getAppState?api.getAppState():null;
          if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2));
          info(`[${timestamp()}] Appstate backed up.`);
        }catch(e){ warn("Appstate backup error:",e.message||e);}
      },APPSTATE_BACKUP_INTERVAL);

      // Initial nick check
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){ warn("listenMqtt error:",err?.message||err); return; }
        try{
          const threadID=event.threadID;
          const senderID=event.senderID;
          const body=(event.body||"").toString().trim();
          // Boss-only commands
          if(event.type==="message" && senderID===BOSS_UID){
            const lc=(body||"").toLowerCase();
            if(lc==="/nicklock on"){ groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].enabled=true; groupLocks[threadID].nick=process.env.DEFAULT_LOCKED_NICK||"LockedName"; groupLocks[threadID].original=groupLocks[threadID].original||{}; groupLocks[threadID].count=0; groupLocks[threadID].cooldown=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);}
            if(lc==="/nicklock off"){ if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);}}
            if(lc.startsWith("/gclock")){ if(!groupLocks[threadID]) groupLocks[threadID]={}; groupLocks[threadID].gclock=true; if(lc.length>7){groupLocks[threadID].groupName=body.slice(8).trim(); await changeThreadTitle(api,threadID,groupLocks[threadID].groupName); await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`); } else{ const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); groupLocks[threadID].groupName=infoThread?.threadName||"Group"; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID}`); } } 
          }
        }catch(e){ if((e?.message)==="FORCE_RECONNECT") throw e; warn("Event handler error:",e?.message||e);}
      });

      loginAttempts=0;
      break;
    }catch(e){
      error(`[${timestamp()}] Login/Run error:`,e?.message||e);
      const backoff=Math.min(60,(loginAttempts+1)*5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff*1000);
    }
  }
}

// Start bot
loginAndRun().catch(e=>{ error("Fatal error:",e?.message||e); process.exit(1); });
