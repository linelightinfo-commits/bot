/**
 * Fixed and optimized ws3-fca Facebook bot
 * Features:
 * - Nicklock: bot first, then all members
 * - GCLOCK: group name revert after 47s
 * - Concurrency & cooldown
 * - Safe null checks
 * - Anti-sleep typing indicator
 * - Silent operation
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m" };
function log(...a){ console.log(C.cyan+"[BOT]"+C.reset,...a); }
function info(...a){ console.log(C.green+"[INFO]"+C.reset,...a); }
function warn(...a){ console.log(C.yellow+"[WARN]"+C.reset,...a); }
function error(...a){ console.log(C.red+"[ERR]"+C.reset,...a); }

// Express keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT||10000;
app.get("/",(req,res)=>res.send("✅ Bot Online"));
app.listen(PORT,()=>log(`Server running on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR,"appstate.json");
const dataFile = path.join(DATA_DIR,"groupData.json");

// Timing & limits
const GROUP_NAME_CHECK_INTERVAL = 15*1000;
const GROUP_NAME_REVERT_DELAY = 47*1000;
const NICKNAME_DELAY_MIN = 6000;
const NICKNAME_DELAY_MAX = 7000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 3*60*1000;
const TYPING_INTERVAL = 5*60*1000;
const APPSTATE_BACKUP_INTERVAL = 10*60*1000;

let api = null;
let groupLocks = {};
let groupQueues = {};
let groupNameChangeDetected = {};
let groupNameRevertInProgress = {};
let shuttingDown = false;

// Concurrency limiter
const GLOBAL_MAX_CONCURRENT = 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot(){ if(globalActiveCount<GLOBAL_MAX_CONCURRENT){globalActiveCount++; return;} await new Promise(r=>globalPending.push(r)); globalActiveCount++; }
function releaseGlobalSlot(){ globalActiveCount=Math.max(0,globalActiveCount-1); if(globalPending.length){const r=globalPending.shift(); r();} }

const sleep = ms=>new Promise(r=>setTimeout(r,ms));
function randomDelay(){ return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp(){ return new Date().toTimeString().split(" ")[0]; }

function ensureQueue(threadID){ if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID,fn){ const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID); }
async function runQueue(threadID){ const q=ensureQueue(threadID); if(q.running) return; q.running=true; while(q.tasks.length){ const fn=q.tasks.shift(); try{ await acquireGlobalSlot(); try{ await fn(); }finally{ releaseGlobalSlot(); } }catch(e){ warn(`[${timestamp()}] Queue error for ${threadID}:`, e.message||e); } await sleep(250); } q.running=false; }

// File ops
async function ensureDataFile(){ try{ await fsp.access(dataFile); }catch(e){ await fsp.writeFile(dataFile,JSON.stringify({},null,2)); } }
async function loadLocks(){ try{ await ensureDataFile(); const txt=await fsp.readFile(dataFile,"utf8"); groupLocks=JSON.parse(txt||"{}"); info("Loaded group locks."); }catch(e){ warn("Load locks failed:",e.message||e); groupLocks={}; } }
async function saveLocks(){ try{ const tmp=`${dataFile}.tmp`; await fsp.writeFile(tmp,JSON.stringify(groupLocks,null,2)); await fsp.rename(tmp,dataFile); info("Group locks saved."); }catch(e){ warn("Save locks failed:",e.message||e); } }

// Appstate loader
async function loadAppState(){ try{ const txt=await fsp.readFile(appStatePath,"utf8"); return JSON.parse(txt); }catch(e){ throw new Error("Cannot load appstate.json"); } }

// Change thread title
async function changeThreadTitle(apiObj,threadID,title){ if(!apiObj) throw new Error("No api"); return new Promise((res,rej)=>{ apiObj.setTitle ? apiObj.setTitle(title,threadID,(err)=>err?rej(err):res()) : rej(new Error("No method to change thread title")); }); }

// Init check: reapply nicknames
async function initCheckLoop(apiObj){ try{ const threadIDs=Object.keys(groupLocks); for(let t of threadIDs){ const group=groupLocks[t]; if(!group||!group.enabled) continue; try{ const infoObj=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r))); const participants=infoObj?.participantIDs||[]; for(const uid of participants){ const desired=group.original?.[uid]||group.nick; if(!desired) continue; const current=(infoObj.nicknames&&infoObj.nicknames[uid])||null; if(current!==desired){ queueTask(t,async()=>{ try{ await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res())); info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`); await sleep(randomDelay()); }catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid}:`,e.message||e); } }); } } }catch(e){}} }catch(e){ warn("initCheckLoop error:",e.message||e); } }

// Main login
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login #${++loginAttempts}`);
      api=await new Promise((res,rej)=>{ loginLib({appState},(err,a)=>err?rej(err):res(a)); });
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"unknown"}`);
      await loadLocks();

      // GCLOCK poller
      setInterval(async()=>{
        const threadIDs=Object.keys(groupLocks);
        for(let threadID of threadIDs){
          const group=groupLocks[threadID]; if(!group||!group.gclock) continue;
          if(groupNameRevertInProgress[threadID]) continue;
          try{
            const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(!infoObj) continue;
            if(infoObj.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]){ groupNameChangeDetected[threadID]=Date.now(); info(`[${timestamp()}] [GCLOCK] Detected name change -> revert after ${GROUP_NAME_REVERT_DELAY/1000}s`); }
              else{ const elapsed=Date.now()-groupNameChangeDetected[threadID]; if(elapsed>=GROUP_NAME_REVERT_DELAY){ groupNameRevertInProgress[threadID]=true; try{ await changeThreadTitle(api,threadID,group.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`); }catch(e){ warn(`[${timestamp()}] GCLOCK revert failed:`,e.message||e); } finally{ groupNameChangeDetected[threadID]=null; groupNameRevertInProgress[threadID]=false; } } }
            }else groupNameChangeDetected[threadID]=null;
          }catch(e){ warn(`[${timestamp()}] GCLOCK check error:`,e.message||e); }
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep typing
      setInterval(async()=>{ for(const id of Object.keys(groupLocks)){ const g=groupLocks[id]; if(!g||(!g.gclock&&!g.enabled)) continue; try{ await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res())); await sleep(1200);}catch(e){warn(`[${timestamp()}] Typing failed ${id}:`,e.message||e);} } },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{ try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up`);}catch(e){warn("Appstate backup failed:",e.message||e);} },APPSTATE_BACKUP_INTERVAL);

      // Init check
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){ warn("listenMqtt error:",err.message||err); return; }
        try{
          const threadID=event.threadID,senderID=event.senderID,body=(event.body||"").toString().trim();
          // Boss commands
          if(event.type==="message"&&senderID===BOSS_UID){
            const lc=body.toLowerCase();
            if(lc==="/nicklock on"){
              try{
                const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
                const lockedNick="😈Allah madarchod😈";
                groupLocks[threadID]=groupLocks[threadID]||{};
                groupLocks[threadID].enabled=true;
                groupLocks[threadID].nick=lockedNick;
                groupLocks[threadID].original=groupLocks[threadID].original||{};
                groupLocks[threadID].count=0; groupLocks[threadID].cooldown=false;
                // Bot sets own nick first
                const meID=api.getCurrentUserID();
                if(meID){ queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,meID,(err)=>err?rej(err):res())); info(`[${timestamp()}] Bot nick set`); await sleep(randomDelay()); }catch(e){ warn("Bot nick failed:",e.message||e); } }); }
                // Then all others
                for(const user of(infoThread.userInfo||[])){
                  groupLocks[threadID].original[user.id]=lockedNick;
                  if(user.id!==meID){
                    queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,user.id,(err)=>err?rej(err):res())); info(`[${timestamp()}] Changed nick for ${user.id}`); await sleep(randomDelay()); }catch(e){ warn("Nick change failed:",e.message||e); } });
                  }
                }
                await saveLocks();
                info(`[${timestamp()}] Nicklock activated`);
              }catch(e){ warn("Nicklock activation failed:",e.message||e); }
            }
            if(lc==="/nicklock off"){ if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] Nicklock deactivated`); } }
            if(lc==="/gclock"){ try{ const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=infoThread.threadName; groupLocks[threadID].gclock=true; await saveLocks(); info(`[${timestamp()}] GCLOCK locked: "${infoThread.threadName}"`); }catch(e){ warn("GCLOCK failed:",e.message||e); } }
            if(lc.startsWith("/gclock ")){ const customName=body.slice(8).trim(); if(customName){ groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=customName; groupLocks[threadID].gclock=true; try{ await changeThreadTitle(api,threadID,customName); await saveLocks(); info(`[${timestamp()}] GCLOCK locked: "${customName}"`); }catch(e){ warn("GCLOCK set failed:",e.message||e); } } }
            if(lc==="/unlockgname"){ if(groupLocks[threadID]){ delete groupLocks[threadID].gclock; await saveLocks(); info(`[${timestamp()}] GCLOCK unlocked`); } }
          }

          // Quick name-change detection
          if(event.type==="event"&&event.logMessageType==="log:thread-name"){
            const lockedName=groupLocks[event.threadID]?.groupName;
            if(lockedName&&event.logMessageData?.name!==lockedName){
              if(!groupNameChangeDetected[event.threadID]){
                groupNameChangeDetected[event.threadID]=Date.now();
                info(`[${timestamp()}] Quick name change detected -> will revert`);
              }
            }
          }

          // Nickname revert
          if(event.logMessageType==="log:user-nickname"){
            const group=groupLocks[threadID];
            if(!group||!group.enabled||group.cooldown) return;
            const uid=event.logMessageData?.participant_id;
            const currentNick=event.logMessageData?.nickname;
            const lockedNick=(group.original&&group.original[uid])||group.nick;
            if(lockedNick&&currentNick!==lockedNick){
              queueTask(threadID,async()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,(err)=>err?rej(err):res()));
                  group.count=(group.count||0)+1;
                  info(`🎭 [${timestamp()}] Reverted ${uid} in ${threadID}`);
                  if(group.count>=NICKNAME_CHANGE_LIMIT){ group.cooldown=true; warn(`⏸️ Cooling down ${NICKNAME_COOLDOWN/1000}s`); setTimeout(()=>{ group.cooldown=false; group.count=0; info(`▶️ Cooldown lifted for ${threadID}`); },NICKNAME_COOLDOWN); } else await sleep(randomDelay());
                  await saveLocks();
                }catch(e){ warn(`Nick revert failed ${uid}:`,e.message||e); }
              });
            }
          }

        }catch(e){ if((e.message==="FORCE_RECONNECT")) throw e; warn("Event error:",e.message||e); }
      });

      loginAttempts=0; break; // stay logged in
    }catch(e){ error("Login error:",e.message||e); await sleep(Math.min(60,(loginAttempts+1)*5)*1000); }
  }
}

loginAndRun().catch(e=>{ error("Fatal start:",e.message||e); process.exit(1); });

// Global handlers
process.on("uncaughtException",err=>{ error("uncaughtException:",err.stack||err); setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000); });
process.on("unhandledRejection",reason=>{ warn("unhandledRejection:",reason); setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000); });

// Graceful shutdown
async function gracefulExit(){ shuttingDown=true; info("Saving state..."); try{ if(api&&api.getAppState) await fsp.writeFile(appStatePath,JSON.stringify(api.getAppState(),null,2)); }catch(e){} try{ await saveLocks(); }catch(e){} process.exit(0); }
process.on("SIGINT",gracefulExit);
process.on("SIGTERM",gracefulExit);
