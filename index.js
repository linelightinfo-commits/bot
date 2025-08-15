/**
 * Facebook Messenger Bot
 * - Nickname & group-name lock
 * - Bot changes its own nick first, then members
 * - Silent operation, retries, cooldowns, Puppeteer fallback
 * - Auto-lock from groupData.json
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

// Express keepalive
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

// Timings
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

// Global concurrency limiter
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) { globalActiveCount++; return; }
  await new Promise(res => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) globalPending.shift()();
}

// File helpers
async function ensureDataFile() {
  try { await fsp.access(dataFile); } catch(e) { await fsp.writeFile(dataFile, "{}"); }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt || "{}");
    info("Loaded groupData.json");
  } catch(e) { warn("Failed to load groupData.json:", e.message||e); groupLocks = {}; }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks,null,2));
    await fsp.rename(tmp, dataFile);
    info("Group locks saved");
  } catch(e){warn("Failed to save groupData.json:", e.message||e);}
}

// Utilities
const sleep = ms => new Promise(res=>setTimeout(res,ms));
function randomDelay() { return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

function ensureQueue(threadID){ if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID, fn){ const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID);}
async function runQueue(threadID){
  const q=ensureQueue(threadID); if(q.running) return; q.running=true;
  while(q.tasks.length){
    const fn=q.tasks.shift();
    try{
      await acquireGlobalSlot();
      try{ await fn(); } finally { releaseGlobalSlot(); }
    } catch(e){ warn(`[${timestamp()}] Queue task error ${threadID}:`, e.message||e); }
    await sleep(250);
  }
  q.running=false;
}

// Puppeteer fallback
async function startPuppeteerIfEnabled(){
  if(!ENABLE_PUPPETEER){ info("Puppeteer disabled"); return; }
  try{
    const puppeteer = require("puppeteer");
    const launchOpts={headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]};
    if(CHROME_EXECUTABLE) launchOpts.executablePath=CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
    puppeteerAvailable=true;
    info("Puppeteer ready");
  } catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:", e.message||e); }
}

// Change thread title
async function changeThreadTitle(apiObj, threadID, title){
  if(!apiObj) throw new Error("No api");
  if(typeof apiObj.setTitle==="function") return new Promise((r,rej)=>apiObj.setTitle(title,threadID,(err)=>err?rej(err):r()));
  if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?rej(err):r()));
  if(ENABLE_PUPPETEER && puppeteerAvailable){
    try{
      const url=`https://www.facebook.com/messages/t/${threadID}`;
      await puppeteerPage.goto(url,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
      await puppeteerPage.waitForTimeout(1200);
      info(`[${timestamp()}] Puppeteer fallback attempted for title change`);
      return;
    }catch(e){ throw e; }
  }
  throw new Error("No method to change thread title");
}

// Load appstate
async function loadAppState(){
  if(process.env.APPSTATE) try{ return JSON.parse(process.env.APPSTATE); }catch(e){ warn("APPSTATE invalid:",e.message||e);}
  try{ const txt=await fsp.readFile(appStatePath,"utf8"); return JSON.parse(txt); }catch(e){ throw new Error("Cannot load appstate.json or APPSTATE env"); }
}

// Init check: reapply nicknames
async function initCheckLoop(apiObj){
  try{
    const threadIDs=Object.keys(groupLocks);
    for(let t of threadIDs){
      const group=groupLocks[t]; if(!group||!group.enabled) continue;
      try{
        const info=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));
        const participants=info?.participantIDs||(info?.userInfo&&info.userInfo.map(u=>u.id))||[];
        for(const uid of participants){
          const desired=group.original?.[uid]||group.nick; if(!desired) continue;
          const current=(info.nicknames&&info.nicknames[uid])||(info.userInfo&&info.userInfo.find(u=>u.id===uid)?.nickname)||null;
          if(current!==desired){
            queueTask(t,async()=>{
              try{
                await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res()));
                info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);
                await sleep(randomDelay());
              }catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`,e.message||e); }
            });
          }
        }
      }catch(e){}
    }
  }catch(e){ warn("initCheckLoop error:", e.message||e); }
}

// Main login & run
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login (${++loginAttempts})`);
      api=await new Promise((res,rej)=>{ try{ loginLib({appState},(err,a)=>err?rej(err):res(a)); }catch(e){rej(e);} });
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"(unknown)"}`);
      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer err:",e.message||e));

      // Group-name watcher
      setInterval(async()=>{
        const threadIDs=Object.keys(groupLocks);
        for(const threadID of threadIDs){
          const group=groupLocks[threadID]; if(!group||!group.gclock) continue;
          if(groupNameRevertInProgress[threadID]) continue;
          try{
            const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(infoObj&&infoObj.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]) groupNameChangeDetected[threadID]=Date.now();
              else if(Date.now()-groupNameChangeDetected[threadID]>=GROUP_NAME_REVERT_DELAY){
                groupNameRevertInProgress[threadID]=true;
                try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID}`); }
                catch(e){ warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`, e.message||e);}
                finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false; }
              }
            }else groupNameChangeDetected[threadID]=null;
          }catch(e){ warn(`[${timestamp()}] [GCLOCK] Error ${threadID}:`, e.message||e); }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          const g=groupLocks[id]; if(!g||(!g.gclock&&!g.enabled)) continue;
          try{ await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res())); await sleep(1200); }
          catch(e){ warn(`[${timestamp()}] Typing failed for ${id}:`,e.message||e); }
        }
      }, TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{ try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`);}catch(e){warn("Appstate backup:",e.message||e);} }, APPSTATE_BACKUP_INTERVAL);

      // Init check
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){ warn("listenMqtt error:",err.message||err); return; }
        try{
          const threadID=event.threadID, senderID=event.senderID, body=(event.body||"").toString().trim();
          // Boss commands
          if(event.type==="message"&&senderID===BOSS_UID){
            const lc=body.toLowerCase();
            if(lc==="/nicklock on"){
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              const lockedNick="😈Allah madarchod😈";
              groupLocks[threadID]=groupLocks[threadID]||{};
              groupLocks[threadID].enabled=true; groupLocks[threadID].nick=lockedNick;
              groupLocks[threadID].original=groupLocks[threadID].original||{}; groupLocks[threadID].count=0; groupLocks[threadID].cooldown=false;
              for(const user of infoThread.userInfo||[]){ groupLocks[threadID].original[user.id]=lockedNick;
                queueTask(threadID,async()=>{
                  for(let i=0;i<3;i++){ // retry 3 times
                    try{ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,user.id,(err)=>err?rej(err):res())); break; }
                    catch(e){ await sleep(2000); }
                  }
                  info(`[${timestamp()}] Changed nick for ${user.id} in ${threadID}`); await sleep(randomDelay());
                });
              }
              await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
            }
            if(lc==="/nicklock off"){ if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); }}
            if(lc==="/nickall"){
              const data=groupLocks[threadID]; if(!data?.enabled) return;
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              for(const user of infoThread.userInfo||[]){ data.original=data.original||{}; data.original[user.id]=data.nick;
                queueTask(threadID,async()=>{ await new Promise((res,rej)=>api.changeNickname(data.nick,threadID,user.id,(err)=>err?rej(err):res())); info(`[${timestamp()}] Reapplied nick for ${user.id}`); await sleep(randomDelay()); });
              }
              await saveLocks(); info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);
            }
            if(lc.startsWith("/gclock ")){
              const customName=body.slice(8).trim(); if(!customName) return;
              groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=customName; groupLocks[threadID].gclock=true;
              try{ await changeThreadTitle(api,threadID,customName); await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`); } catch(e){warn("Could not set group name:",e.message||e);}
            }
            if(lc==="/gclock"){
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=infoThread.threadName; groupLocks[threadID].gclock=true;
              await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
            }
            if(lc==="/unlockgname"){ if(groupLocks[threadID]){ delete groupLocks[threadID].gclock; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`); } }
          }

          // Nickname revert
          if(event.logMessageType==="log:user-nickname"){
            const group=groupLocks[threadID]; if(!group||!group.enabled||group.cooldown) return;
            const uid=event.logMessageData?.participant_id, currentNick=event.logMessageData?.nickname;
            const lockedNick=(group.original&&group.original[uid])||group.nick;
            if(lockedNick&&currentNick!==lockedNick){
              queueTask(threadID,async()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,(err)=>err?rej(err):res()));
                  group.count=(group.count||0)+1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if(group.count>=NICKNAME_CHANGE_LIMIT){
                    group.cooldown=true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);
                    setTimeout(()=>{ group.cooldown=false; group.count=0; info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`); }, NICKNAME_COOLDOWN);
                  } else await sleep(randomDelay());
                  await saveLocks();
                }catch(e){ warn(`[${timestamp()}] Nick revert failed for ${uid} in ${threadID}:`, e.message||e); }
              });
            }
          }

        }catch(e){ if((e&&e.message)==="FORCE_RECONNECT") throw e; warn("Event listener error:", e.message||e); }
      });

      loginAttempts=0;
      break;
    }catch(e){ warn(`[LOGIN] Failed:`, e.message||e); await sleep(10000); }
  }
}

loginAndRun().catch(e=>error("Fatal error:", e.message||e));

process.on("uncaughtException",err=>{ error("UncaughtException:", err.message||err); });
process.on("unhandledRejection",err=>{ error("UnhandledRejection:", err.message||err); });
