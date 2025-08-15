/**
 * Render-ready Facebook Messenger Bot (ws3-fca)
 * Features:
 * - Bot nickname first, then participants
 * - Nickname lock + group name lock (GCLOCK)
 * - Silent operation, minimal console logs
 * - Queue + global concurrency limiter
 * - Cooldown + random delay
 * - Anti-sleep typing every 5 min
 * - Appstate backup every 10 min
 * - UID-restricted commands (BOSS_UID)
 * - Puppeteer fallback optional
 * - 365-day continuous run compatible
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
function log(...a) { console.log(C.cyan + "[BOT]" + C.reset, ...a); }
function info(...a) { console.log(C.green + "[INFO]" + C.reset, ...a); }
function warn(...a) { console.log(C.yellow + "[WARN]" + C.reset, ...a); }
function error(...a) { console.log(C.red + "[ERR]" + C.reset, ...a); }

const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// timing rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 3 * 60 * 1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5 * 60 * 1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000;

const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER || "false").toLowerCase() === "true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

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
  await new Promise(res => globalPending.push(res)); globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) globalPending.shift()();
}

// Helpers
const sleep = ms => new Promise(res => setTimeout(res, ms));
function randomDelay() { return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

async function ensureDataFile() { try { await fsp.access(dataFile); } catch { await fsp.writeFile(dataFile, "{}"); } }
async function loadLocks() { try { await ensureDataFile(); groupLocks = JSON.parse(await fsp.readFile(dataFile,"utf8")||"{}"); info("Loaded group locks."); } catch(e){ warn("Failed load groupData:",e.message||e); groupLocks={}; } }
async function saveLocks() { try { const tmp = `${dataFile}.tmp`; await fsp.writeFile(tmp, JSON.stringify(groupLocks,null,2)); await fsp.rename(tmp,dataFile); info("Group locks saved."); } catch(e){ warn("Save failed:",e.message||e); } }

// Queue helpers
function ensureQueue(threadID){ if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID,fn){ const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID); }
async function runQueue(threadID){ const q=ensureQueue(threadID); if(q.running)return; q.running=true; while(q.tasks.length){ const fn=q.tasks.shift(); try{ await acquireGlobalSlot(); try{ await fn(); } finally{ releaseGlobalSlot(); } }catch(e){ warn(`[${timestamp()}] Queue task ${threadID} err:`,e.message||e);} await sleep(250); } q.running=false; }

// Puppeteer optional
async function startPuppeteerIfEnabled(){ if(!ENABLE_PUPPETEER)return info("Puppeteer disabled"); try{ const puppeteer=require("puppeteer"); puppeteerBrowser=await puppeteer.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"],executablePath:CHROME_EXECUTABLE||undefined}); puppeteerPage=await puppeteerBrowser.newPage(); await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)"); await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{}); puppeteerAvailable=true; info("Puppeteer ready"); }catch(e){ puppeteerAvailable=false; warn("Puppeteer failed:",e.message||e);} }

// Change thread title
async function changeThreadTitle(apiObj,threadID,title){
  if(!apiObj) throw new Error("No api");
  if(typeof apiObj.setTitle==="function") return new Promise((r,rej)=>apiObj.setTitle(title,threadID,err=>(err?rej(err):r())));
  if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,err=>(err?rej(err):r())));
  if(ENABLE_PUPPETEER && puppeteerAvailable){
    try{ await puppeteerPage.goto(`https://www.facebook.com/messages/t/${threadID}`,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{}); await puppeteerPage.waitForTimeout(1200); info(`[${timestamp()}] [PUPP] Puppeteer attempted title change`); return; }catch(e){ throw e; }
  }
  throw new Error("No method to change thread title");
}

// Load appState
async function loadAppState(){ if(process.env.APPSTATE) try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("Invalid APPSTATE env:",e.message||e);} try{return JSON.parse(await fsp.readFile(appStatePath,"utf8"));}catch(e){throw new Error("Cannot load appstate");}}

// Init check
async function initCheckLoop(apiObj){ try{ const threads=Object.keys(groupLocks); for(let t of threads){ const g=groupLocks[t]; if(!g||!g.enabled)continue; try{ const infoThread=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r))); const participants=infoThread?.participantIDs||[]; for(const uid of participants){ const desired=g.original?.[uid]||g.nick; if(!desired)continue; const current=(infoThread.nicknames&&infoThread.nicknames[uid])||null; if(current!==desired){ queueTask(t,async()=>{ try{ await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,err=>err?rej(err):res())); info(`🎭 [${timestamp()}] [INIT] Reapplied nick ${uid} in ${t}`); await sleep(randomDelay()); }catch(e){ warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`,e.message||e); } }); } } }catch{} } }catch(e){warn("initCheckLoop error:",e.message||e);}

// Main login + run
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login ${++loginAttempts}`);
      api=await new Promise((res,rej)=>{ try{ loginLib({appState},(err,a)=>err?rej(err):res(a)); }catch(e){rej(e);} });
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"(unknown)"}`);

      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:",e.message||e));

      // GCLOCK poller
      setInterval(async()=>{
        const threads=Object.keys(groupLocks); const MAX=20;
        for(let i=0;i<Math.min(MAX,threads.length);i++){
          const tid=threads[i]; const g=groupLocks[tid];
          if(!g||!g.gclock||groupNameRevertInProgress[tid])continue;
          try{
            const infoThread=await new Promise((res,rej)=>api.getThreadInfo(tid,(err,r)=>err?rej(err):res(r)));
            if(infoThread?.threadName!==g.groupName){
              if(!groupNameChangeDetected[tid]){ groupNameChangeDetected[tid]=Date.now(); info(`[${timestamp()}] [GCLOCK] Detected change in ${tid} -> "${infoThread.threadName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s.`); }
              else if(Date.now()-groupNameChangeDetected[tid]>=GROUP_NAME_REVERT_DELAY){
                groupNameRevertInProgress[tid]=true;
                try{ await changeThreadTitle(api,tid,g.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${tid} -> "${g.groupName}"`); }catch(e){warn(`[${timestamp()}] GCLOCK revert failed ${tid}:`,e.message||e);} finally{ groupNameChangeDetected[tid]=null; groupNameRevertInProgress[tid]=false; }
              }
            }else groupNameChangeDetected[tid]=null;
          }catch(e){warn(`[${timestamp()}] GCLOCK check error ${tid}:`,e.message||e);}
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          const g=groupLocks[id]; if(!g||(!g.gclock&&!g.enabled))continue;
          try{ await new Promise((res,rej)=>api.sendTypingIndicator(id,err=>err?rej(err):res())); await sleep(1200); }catch(e){warn(`[${timestamp()}] Typing fail ${id}:`,e.message||e);}
        }
      },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{ try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`); }catch(e){warn("Appstate backup err:",e.message||e);} },APPSTATE_BACKUP_INTERVAL);

      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck err:",e.message||e)),5*60*1000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){ warn("listenMqtt err:",err.message||err); return; }
        try{
          const threadID=event.threadID, senderID=event.senderID, body=(event.body||"").trim();
          if(event.type==="message" && senderID===BOSS_UID){
            const lc=body.toLowerCase();
            if(lc==="/nicklock on"){
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              const lockedNick="😈Allah madarchod😈";
              groupLocks[threadID]=groupLocks[threadID]||{};
              groupLocks[threadID].enabled=true; groupLocks[threadID].nick=lockedNick;
              groupLocks[threadID].original=groupLocks[threadID].original||{}; groupLocks[threadID].count=0; groupLocks[threadID].cooldown=false;

              // Bot first
              const myID=api.getCurrentUserID?api.getCurrentUserID():null;
              if(myID){ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,myID,err=>err?rej(err):res())); info(`[${timestamp()}] Bot nick changed first`); await sleep(randomDelay()); }

              // All participants
              for(const u of infoThread.userInfo||[]){
                if(u.id===myID) continue;
                groupLocks[threadID].original[u.id]=lockedNick;
                queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,u.id,err=>err?rej(err):res())); info(`🎭 [${timestamp()}] [NICKLOCK] Applied nick for ${u.id}`); }catch(e){warn(`[${timestamp()}] changeNickname failed ${u.id}:`,e.message||e);} await sleep(randomDelay()); });
              }
              await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
            }

            if(lc==="/nicklock off" && groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); }

            if(lc.startsWith("/gclock ")){
              const customName=body.slice(8).trim(); if(!customName) return;
              groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=customName; groupLocks[threadID].gclock=true;
              try{ await changeThreadTitle(api,threadID,customName); await saveLocks(); info(`[${timestamp()}] [GCLOCK] Locked group name for ${threadID}`); }catch(e){warn("GCLOCK set failed:",e.message||e);}
            }

            if(lc==="/gclock"){
              const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
              groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].groupName=infoThread.threadName; groupLocks[threadID].gclock=true; await saveLocks();
              info(`[${timestamp()}] [GCLOCK] Locked current group name for ${threadID} -> "${infoThread.threadName}"`);
            }

            if(lc==="/unlockgname" && groupLocks[threadID]){ delete groupLocks[threadID].gclock; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Unlocked group name for ${threadID}`); }
          }

          // Nickname revert events
          if(event.logMessageType==="log:user-nickname"){
            const g=groupLocks[threadID]; if(!g||!g.enabled||g.cooldown) return;
            const uid=event.logMessageData?.participant_id; const currentNick=event.logMessageData?.nickname;
            const lockedNick=(g.original && g.original[uid])||g.nick;
            if(lockedNick && currentNick!==lockedNick){
              queueTask(threadID,async()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,err=>err?rej(err):res()));
                  g.count=(g.count||0)+1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID}`);
                  if(g.count>=NICKNAME_CHANGE_LIMIT){ g.cooldown=true; info(`[${timestamp()}] Nick limit reached, cooldown ${NICKNAME_COOLDOWN/1000}s`); setTimeout(()=>g.cooldown=false,g.NICKNAME_COOLDOWN||NICKNAME_COOLDOWN); g.count=0; }
                  await saveLocks();
                }catch(e){warn(`[${timestamp()}] NICK revert failed ${uid}:`,e.message||e);}
              });
            }
          }
        }catch(e){warn("eventHandler err:",e.message||e);}
      });

      break; // login success exit loop
    }catch(e){
      warn(`[${timestamp()}] Login attempt failed:`,e.message||e);
      await sleep(15000);
    }
  }
}

loginAndRun().catch(e=>error("Fatal error:",e.message||e));
