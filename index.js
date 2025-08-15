/**
 * Full Facebook Messenger Bot
 * - ws3-fca loginLib
 * - Boss UID commands
 * - Nickname lock (bot first, then participants)
 * - Group name lock (GCLOCK) auto-revert 47s
 * - Anti-sleep, Appstate backup
 * - Global concurrency limiter
 * - Render-ready
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
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 180000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 300000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 600000;

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

const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) {
    globalActiveCount++;
    return;
  }
  await new Promise(res => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) globalPending.shift()();
}

// Helpers
async function ensureDataFile() {
  try { await fsp.access(dataFile); } catch(e){ await fsp.writeFile(dataFile, "{}"); }
}
async function loadLocks() {
  await ensureDataFile();
  try { groupLocks = JSON.parse(await fsp.readFile(dataFile, "utf8") || "{}"); info("Loaded group locks."); } 
  catch(e){ warn("Failed to load locks:", e.message||e); groupLocks={}; }
}
async function saveLocks() {
  try { await fsp.writeFile(dataFile, JSON.stringify(groupLocks,null,2)); info("Saved group locks."); } 
  catch(e){ warn("Failed to save locks:", e.message||e); }
}
const sleep = ms => new Promise(res=>setTimeout(res, ms));
const randomDelay = () => Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN;
const timestamp = () => new Date().toTimeString().split(" ")[0];

function ensureQueue(threadID) { if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID, fn) { const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID);}
async function runQueue(threadID){
  const q=ensureQueue(threadID); if(q.running) return; q.running=true;
  while(q.tasks.length){
    const fn=q.tasks.shift();
    try{ await acquireGlobalSlot(); try{ await fn(); }finally{ releaseGlobalSlot(); } } 
    catch(e){ warn(`[${timestamp()}] Queue error for ${threadID}:`,e.message||e); }
    await sleep(250);
  }
  q.running=false;
}

// Puppeteer fallback
async function startPuppeteerIfEnabled() {
  if(!ENABLE_PUPPETEER){ info("Puppeteer disabled."); return; }
  try {
    const puppeteer=require("puppeteer");
    puppeteerBrowser=await puppeteer.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"], executablePath:CHROME_EXECUTABLE||undefined});
    puppeteerPage=await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
    puppeteerAvailable=true; info("Puppeteer ready.");
  }catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:",e.message||e);}
}

async function changeThreadTitle(apiObj,threadID,title){
  if(!apiObj) throw new Error("No api");
  if(typeof apiObj.setTitle==="function") return new Promise((r,rej)=>apiObj.setTitle(title,threadID,err=>err?rej(err):r()));
  if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,err=>err?rej(err):r()));
  if(ENABLE_PUPPETEER && puppeteerAvailable){
    try{ const url=`https://www.facebook.com/messages/t/${threadID}`; await puppeteerPage.goto(url,{waitUntil:"networkidle2",timeout:30000}); await puppeteerPage.waitForTimeout(1200); info(`[${timestamp()}] [PUPP] Puppeteer fallback attempted`); return; }catch(e){ throw e; }
  }
  throw new Error("No method to change thread title");
}

async function loadAppState(){
  if(process.env.APPSTATE) try{ return JSON.parse(process.env.APPSTATE); } catch(e){ warn("APPSTATE env invalid JSON:",e.message||e);}
  try{ return JSON.parse(await fsp.readFile(appStatePath,"utf8")); } catch(e){ throw new Error("Cannot load appstate"); }
}

// initCheckLoop: apply nicknames for all participants
async function initCheckLoop(apiObj){
  try{
    const threadIDs=Object.keys(groupLocks);
    for(let t of threadIDs){
      const group=groupLocks[t];
      if(!group||!group.enabled) continue;
      try{
        const info=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));
        const participants=info?.participantIDs||(info?.userInfo?.map(u=>u.id))||[];
        for(const uid of participants){
          const desired=group.original?.[uid]||group.nick;
          if(!desired) continue;
          const current=(info.nicknames?.[uid])||(info.userInfo?.find(u=>u.id===uid)?.nickname)||null;
          if(current!==desired){
            queueTask(t,async()=>{
              try{ await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,err=>err?rej(err):res())); info(`🎭 [${timestamp()}] [INIT] Nick applied for ${uid}`); await sleep(randomDelay()); } 
              catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid}:`,e.message||e); }
            });
          }
        }
      }catch(e){}
    }
  }catch(e){ warn("initCheckLoop err:",e.message||e);}
}

// main login
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api=await new Promise((res,rej)=>{ loginLib({appState},(err,a)=>err?rej(err):res(a)); });
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"unknown"}`);
      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:",e.message||e));

      // Group name watcher
      setInterval(async()=>{
        const threadIDs=Object.keys(groupLocks);
        for(const threadID of threadIDs){
          const group=groupLocks[threadID];
          if(!group||!group.gclock) continue;
          if(groupNameRevertInProgress[threadID]) continue;
          try{
            const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(infoObj?.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]) groupNameChangeDetected[threadID]=Date.now();
              else if(Date.now()-groupNameChangeDetected[threadID]>=GROUP_NAME_REVERT_DELAY){
                groupNameRevertInProgress[threadID]=true;
                try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID}`); } 
                catch(e){ warn(`[${timestamp()}] [GCLOCK] Revert failed ${threadID}:`,e.message||e); } 
                finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false; }
              }
            }else groupNameChangeDetected[threadID]=null;
          }catch(e){ warn(`[${timestamp()}] GCLOCK error ${threadID}:`,e.message||e);}
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep typing
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          try{
            const g=groupLocks[id];
            if(!g||(!g.gclock&&!g.enabled)) continue;
            await new Promise((res,rej)=>api.sendTypingIndicator(id,err=>err?rej(err):res()));
            await sleep(1200);
          }catch(e){ warn(`[${timestamp()}] Typing failed ${id}:`,e.message||e);}
        }
      },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{
        try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`); }
        catch(e){ warn("Appstate backup failed:",e.message||e);}
      },APPSTATE_BACKUP_INTERVAL);

      // Initial nick apply
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck err:",e.message||e)),300000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){ warn("listenMqtt error:",err.message||err); return; }
        try{
          const threadID=event.threadID;
          const senderID=event.senderID;
          const body=(event.body||"").trim();

          // Boss commands
          if(event.type==="message"&&senderID===BOSS_UID){
            const lc=body.toLowerCase();
            if(lc==="/nicklock on"){
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              if(!groupLocks[threadID]) groupLocks[threadID]={enabled:true,nick:null,original:{}};
              groupLocks[threadID].enabled=true;
              if(!groupLocks[threadID].original) groupLocks[threadID].original={};
              for(const u of infoThread.participantIDs) groupLocks[threadID].original[u]=infoThread.nicknames?.[u]||null;
              info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
              saveLocks();
              await initCheckLoop(api);
            }else if(lc==="/nicklock off"){ if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); } }
            else if(lc.startsWith("/gclock ")){ const title=body.substring(8).trim(); if(!groupLocks[threadID]) groupLocks[threadID]={}; groupLocks[threadID].gclock=true; groupLocks[threadID].groupName=title; info(`[${timestamp()}] [GCLOCK] Set for ${threadID} -> ${title}`); saveLocks(); }
            else if(lc==="/unlockgname"){ if(groupLocks[threadID]){ groupLocks[threadID].gclock=false; info(`[${timestamp()}] [GCLOCK] Disabled for ${threadID}`); saveLocks(); } }
          }

        }catch(e){ warn("Event listener failed:",e.message||e);}
      });

      break; // success login exit while

    }catch(e){
      warn(`[${timestamp()}] Login failed:`, e.message||e);
      await sleep(5000);
    }
  }
}

// Graceful shutdown
process.on("SIGINT", async()=>{ info("SIGINT received."); shuttingDown=true; await saveLocks(); process.exit(0); });
process.on("SIGTERM", async()=>{ info("SIGTERM received."); shuttingDown=true; await saveLocks(); process.exit(0); });

// Start
loginAndRun().catch(e=>error("Fatal error:",e.message||e));
