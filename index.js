/**
 * Auto Multi-Group Facebook Messenger Bot
 * Features:
 * - Silent nickname & group name locking per group
 * - Fully automatic (no manual commands required)
 * - Anti-sleep & Appstate backup
 * - Multi-group support from groupData.json
 * - Optional Puppeteer fallback for title change
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

// Console colors
const C = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m" };
function log(...a){ console.log(C.cyan+"[BOT]"+C.reset,...a);}
function info(...a){ console.log(C.green+"[INFO]"+C.reset,...a);}
function warn(...a){ console.log(C.yellow+"[WARN]"+C.reset,...a);}
function error(...a){ console.log(C.red+"[ERR]"+C.reset,...a);}

// Express keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT||10000;
app.get("/", (req,res)=>res.send("✅ Facebook Bot is online!"));
app.listen(PORT, ()=>log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID||"61578631626802";
const DATA_DIR = process.env.DATA_DIR||__dirname;
const appStatePath = path.join(DATA_DIR,"appstate.json");
const dataFile = path.join(DATA_DIR,"groupData.json");

// Timings
const GROUP_NAME_CHECK_INTERVAL = 45*1000;
const NICKNAME_DELAY_MIN = 3000;
const NICKNAME_DELAY_MAX = 4000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 3*60*1000;
const TYPING_INTERVAL = 5*60*1000;
const APPSTATE_BACKUP_INTERVAL = 10*60*1000;

// Puppeteer
const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER||"false").toLowerCase()==="true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||null;

// State
let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let puppeteerBrowser=null;
let puppeteerPage=null;
let puppeteerAvailable=false;
let shuttingDown=false;

// Global concurrency limiter
let globalActiveCount=0;
const GLOBAL_MAX_CONCURRENT=3;
const globalPending=[];
async function acquireGlobalSlot(){ 
  if(globalActiveCount<GLOBAL_MAX_CONCURRENT){ globalActiveCount++; return; }
  await new Promise(res=>globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot(){ 
  globalActiveCount=Math.max(0,globalActiveCount-1);
  if(globalPending.length){ const r=globalPending.shift(); r(); }
}

// Helpers
const sleep = ms => new Promise(res=>setTimeout(res,ms));
function randomDelay(){ return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp(){ return new Date().toTimeString().split(" ")[0]; }
function ensureQueue(threadID){ if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID,fn){ const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID); }
async function runQueue(threadID){ const q=ensureQueue(threadID); if(q.running) return; q.running=true; while(q.tasks.length){ const fn=q.tasks.shift(); try{ await acquireGlobalSlot(); try{ await fn(); } finally{ releaseGlobalSlot(); } } catch(e){ warn(`[${timestamp()}] Queue error ${threadID}:`, e.message||e); } await sleep(250); } q.running=false; }

// Safe file ops
async function ensureDataFile(){ try{ await fsp.access(dataFile); }catch(e){ await fsp.writeFile(dataFile,JSON.stringify({},null,2)); } }
async function loadLocks(){
  try{
    await ensureDataFile();
    const txt=await fsp.readFile(dataFile,"utf8");
    try{ groupLocks=JSON.parse(txt||"{}"); info("Loaded saved group locks."); } 
    catch(e){ 
      const ts=new Date().toISOString().replace(/[:.]/g,"-"); 
      const backup=`${dataFile}.broken.${ts}`;
      await fsp.copyFile(dataFile,backup).catch(()=>{});
      warn(`groupData.json corrupted. Backup -> ${path.basename(backup)}. Creating fresh file.`);
      groupLocks={};
      await fsp.writeFile(dataFile,JSON.stringify({},null,2));
    }
  } catch(e){ warn("Failed to load groupData.json:", e.message||e); groupLocks={}; }
}
async function saveLocks(){ try{ const tmp=`${dataFile}.tmp`; await fsp.writeFile(tmp,JSON.stringify(groupLocks,null,2)); await fsp.rename(tmp,dataFile); info("Group locks saved."); } catch(e){ warn("Failed to save groupData.json:", e.message||e); } }

// Puppeteer fallback
async function startPuppeteerIfEnabled(){
  if(!ENABLE_PUPPETEER){ info("Puppeteer disabled."); return; }
  try{
    const puppeteer=require("puppeteer");
    const launchOpts={headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]};
    if(CHROME_EXECUTABLE) launchOpts.executablePath=CHROME_EXECUTABLE;
    puppeteerBrowser=await puppeteer.launch(launchOpts);
    puppeteerPage=await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
    puppeteerAvailable=true;
    info("Puppeteer ready.");
  }catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:", e.message||e); }
}
async function changeThreadTitle(apiObj,threadID,title){
  if(!apiObj) throw new Error("No api");
  if(typeof apiObj.setTitle==="function") return new Promise((r,re)=>apiObj.setTitle(title,threadID,(err)=>err?re(err):r()));
  if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,re)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?re(err):r()));
  if(ENABLE_PUPPETEER && puppeteerAvailable){
    try{ await puppeteerPage.goto(`https://www.facebook.com/messages/t/${threadID}`,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{}); info(`[${timestamp()}] Puppeteer fallback attempted for title change.`); return;} catch(e){ throw e; }
  }
  throw new Error("No method to change thread title");
}

// Appstate loader
async function loadAppState(){
  if(process.env.APPSTATE){ try{ return JSON.parse(process.env.APPSTATE); }catch(e){ warn("APPSTATE env invalid:",e.message||e); } }
  try{ const txt=await fsp.readFile(appStatePath,"utf8"); return JSON.parse(txt); } catch(e){ throw new Error("Cannot load appstate.json or APPSTATE env"); }
}

// Auto nick & group name revert on startup
async function initCheckLoop(apiObj){
  try{
    const threadIDs=Object.keys(groupLocks);
    for(let t of threadIDs){
      const group=groupLocks[t];
      if(!group||(!group.enabled&&!group.gclock)) continue;
      try{
        const info=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));
        const participants=info?.participantIDs||(info?.userInfo?.map(u=>u.id)||[]);
        for(const uid of participants){
          const desired=group.original?.[uid]||group.nick;
          if(!desired) continue;
          const current=(info.nicknames&&info.nicknames[uid])||(info.userInfo?.find(u=>u.id===uid)?.nickname)||null;
          if(current!==desired){
            queueTask(t,async ()=>{
              try{ await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res())); info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`); await sleep(randomDelay()); }catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message||e); }
            });
          }
        }
      }catch(e){}
      // group name revert
      if(group.gclock){
        try{ await changeThreadTitle(apiObj,t,group.groupName); info(`[${timestamp()}] [GCLOCK] Ensured group name for ${t}`); }catch(e){ warn(`[${timestamp()}] GCLOCK init failed for ${t}:`,e.message||e); }
      }
    }
  }catch(e){ warn("initCheckLoop error:", e.message||e); }
}

// Health check
async function startHealthWatcher(){
  setInterval(async ()=>{
    try{
      if(!api) throw new Error("no_api");
      if(typeof api.getCurrentUserID==="function"){ const id=api.getCurrentUserID(); if(!id) throw new Error("no_userid"); }
      const anyThread=Object.keys(groupLocks)[0]; if(anyThread){ await new Promise((res,rej)=>api.sendTypingIndicator(anyThread,(err)=>err?rej(err):res())); }
    }catch(e){ warn("Health check issue:", e.message||e); try{ api.removeAllListeners&&api.removeAllListeners(); }catch(_){} throw new Error("FORCE_RECONNECT"); }
  },10*60*1000);
}

// Main login & run
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api=await new Promise((res,rej)=>{ try{ loginLib({appState},(err,a)=>err?rej(err):res(a)); }catch(e){rej(e);} });

      try{ api.setOptions({listenEvents:true,selfListen:true,updatePresence:true}); }catch(_){}

      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"(unknown)"}`);

      // Load locks
      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:", e.message||e));
      startHealthWatcher().catch(e=>warn("HealthWatcher err:", e.message||e));

      // group-name watcher
      setInterval(async ()=>{
        const threadIDs=Object.keys(groupLocks); const MAX_PER_TICK=20;
        for(let i=0;i<Math.min(MAX_PER_TICK,threadIDs.length);i++){
          const threadID=threadIDs[i]; const group=groupLocks[threadID];
          if(!group||!group.gclock) continue;
          if(groupNameRevertInProgress[threadID]) continue;
          try{
            const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(infoObj && infoObj.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]){ groupNameChangeDetected[threadID]=Date.now(); info(`[${timestamp()}] [GCLOCK] Detected name change for ${threadID}, will revert.`); }
              else{ const elapsed=Date.now()-groupNameChangeDetected[threadID]; if(elapsed>=GROUP_NAME_CHECK_INTERVAL){ groupNameRevertInProgress[threadID]=true; try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID}`); }catch(e){ warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`,e.message||e); } finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false; } } }
            } else groupNameChangeDetected[threadID]=null;
          }catch(e){ warn(`[${timestamp()}] [GCLOCK] Error ${threadID}:`,e.message||e); }
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep typing
      setInterval(async ()=>{
        for(const id of Object.keys(groupLocks)){
          try{ const g=groupLocks[id]; if(!g||(!g.enabled&&!g.gclock)) continue; await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res())); await sleep(1200); }catch(e){ warn(`[${timestamp()}] Typing fail ${id}:`,e.message||e); if((e.message||"").toLowerCase().includes("disconnect")){ api.removeAllListeners&&api.removeAllListeners(); throw new Error("FORCE_RECONNECT"); } }
        }
      },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async ()=>{
        try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`); }catch(e){ warn("Appstate backup error:",e.message||e); }
      },APPSTATE_BACKUP_INTERVAL);

      // Initial check
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

      // Event listener for silent reverts
      api.listenMqtt(async (err,event)=>{
        if(err){ warn("listenMqtt error:", err.message||err); return; }
        try{
          const threadID=event.threadID;
          const uid=event.senderID;
          const group=groupLocks[threadID];
          if(!group) return;

          // Nickname revert
          if(event.logMessageType==="log:user-nickname"){
            const uid=event.logMessageData?.participant_id;
            const currentNick=event.logMessageData?.nickname;
            const lockedNick=(group.original&&group.original[uid])||group.nick;
            if(lockedNick && currentNick!==lockedNick && !group.cooldown){
              queueTask(threadID,async ()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,(err)=>err?rej(err):res()));
                  group.count=(group.count||0)+1;
                  info(`🎭 [${timestamp()}] Reverted nick ${uid} in ${threadID}`);
                  if(group.count>=NICKNAME_CHANGE_LIMIT){ group.cooldown=true; warn(`⏸️ [${timestamp()}] Cooldown ${NICKNAME_COOLDOWN/1000}s`); setTimeout(()=>{ group.cooldown=false; group.count=0; info(`▶️ [${timestamp()}] Cooldown lifted ${threadID}`); },NICKNAME_COOLDOWN); }else await sleep(randomDelay());
                  await saveLocks();
                }catch(e){ warn(`[${timestamp()}] Nick revert failed ${uid} in ${threadID}:`,e.message||e); }
              });
            }
          }

          // Membership sync
          if(event.logMessageType==="log:subscribe"||event.logMessageType==="log:thread-created"){
            if(group.enabled){
              try{
                const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
                group.original=group.original||{};
                for(const u of(infoThread.userInfo||[])) group.original[u.id]=group.nick;
                await saveLocks(); info(`[${timestamp()}] Membership sync ${threadID}`);
              }catch(e){ warn(`Membership sync failed ${threadID}:`,e.message||e); }
            }
          }

        }catch(e){ if((e&&e.message)==="FORCE_RECONNECT") throw e; warn("Event handler error:", e.message||e); }
      });

      loginAttempts=0;
      break;

    }catch(e){
      error(`[${timestamp()}] Login/Run error:`, e.message||e);
      const backoff=Math.min(60,(loginAttempts+1)*5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff*1000);
    }
  }
}

loginAndRun().catch(e=>{ error("Fatal start error:", e.message||e); process.exit(1); });

// Global handlers
process.on("uncaughtException",err=>{ error("uncaughtException:",err.stack||err); try{ api.removeAllListeners&&api.removeAllListeners(); }catch(_){ } setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000); });
process.on("unhandledRejection",reason=>{ warn("unhandledRejection:",reason.message||reason); setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000); });

// Graceful shutdown
async function gracefulExit(){ shuttingDown=true; info("Graceful shutdown: saving state..."); try{ if(api && api.getAppState) await fsp.writeFile(appStatePath,JSON.stringify(api.getAppState(),null,2)); }catch(e){} try{ await saveLocks(); }catch(e){} try{ if(puppeteerBrowser) await puppeteerBrowser.close(); }catch(e){} process.exit(0); }
process.on("SIGINT",gracefulExit);
process.on("SIGTERM",gracefulExit);
