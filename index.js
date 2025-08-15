/**
 * Advanced ws3-fca bot with:
 * - Safe login with retry & appstate verification
 * - Puppeteer fallback optional
 * - Nick & group-name lock with cooldown
 * - Anti-sleep & appstate backup
 * - Null-safe event handling
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m"
};
const log = (...a)=>console.log(C.cyan+"[BOT]"+C.reset,...a);
const info = (...a)=>console.log(C.green+"[INFO]"+C.reset,...a);
const warn = (...a)=>console.log(C.yellow+"[WARN]"+C.reset,...a);
const error = (...a)=>console.log(C.red+"[ERR]"+C.reset,...a);

// Express for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req,res)=>res.send("✅ Facebook Bot is online!"));
app.listen(PORT, ()=>log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR,"appstate.json");
const dataFile = path.join(DATA_DIR,"groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL)||15*1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY)||47*1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN)||6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX)||7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT)||60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN)||3*60*1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL)||5*60*1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL)||10*60*1000;

const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER||"false").toLowerCase()==="true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||null;

// State
let api=null;
let groupLocks={};
let groupQueues={};
let groupNameChangeDetected={};
let groupNameRevertInProgress={};
let puppeteerBrowser=null;
let puppeteerPage=null;
let puppeteerAvailable=false;
let shuttingDown=false;

// Global concurrency limiter
const GLOBAL_MAX_CONCURRENT=parseInt(process.env.GLOBAL_MAX_CONCURRENT)||3;
let globalActiveCount=0;
const globalPending=[];
async function acquireGlobalSlot(){
  if(globalActiveCount<GLOBAL_MAX_CONCURRENT){globalActiveCount++;return;}
  await new Promise(res=>globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot(){globalActiveCount=Math.max(0,globalActiveCount-1);if(globalPending.length){globalPending.shift()();}}

// Helpers
const sleep=ms=>new Promise(res=>setTimeout(res,ms));
function randomDelay(){return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN;}
function timestamp(){return new Date().toTimeString().split(" ")[0];}

async function ensureDataFile(){try{await fsp.access(dataFile);}catch(e){await fsp.writeFile(dataFile,JSON.stringify({},null,2));}}
async function loadLocks(){try{await ensureDataFile();groupLocks=JSON.parse(await fsp.readFile(dataFile,"utf8")||"{}");info("Loaded group locks.");}catch(e){warn("Failed to load groupData.json:",e.message||e);groupLocks={};}}
async function saveLocks(){try{await fsp.writeFile(`${dataFile}.tmp`,JSON.stringify(groupLocks,null,2));await fsp.rename(`${dataFile}.tmp`,dataFile);info("Group locks saved.");}catch(e){warn("Failed to save groupData.json:",e.message||e);}}

// Queue helpers
function ensureQueue(tid){if(!groupQueues[tid])groupQueues[tid]={running:false,tasks:[]};return groupQueues[tid];}
function queueTask(tid,fn){const q=ensureQueue(tid);q.tasks.push(fn);if(!q.running)runQueue(tid);}
async function runQueue(tid){const q=ensureQueue(tid);if(q.running)return;q.running=true;while(q.tasks.length){const fn=q.tasks.shift();try{await acquireGlobalSlot();try{await fn();}finally{releaseGlobalSlot();}}catch(e){warn(`[${timestamp()}] Queue task error for ${tid}:`,e.message||e);}await sleep(250);}q.running=false;}

// Puppeteer fallback
async function startPuppeteerIfEnabled(){if(!ENABLE_PUPPETEER){info("Puppeteer disabled.");return;}try{const puppeteer=require("puppeteer");const launchOpts={headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]};if(CHROME_EXECUTABLE)launchOpts.executablePath=CHROME_EXECUTABLE;puppeteerBrowser=await puppeteer.launch(launchOpts);puppeteerPage=await puppeteerBrowser.newPage();await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});puppeteerAvailable=true;info("Puppeteer ready.");}catch(e){puppeteerAvailable=false;warn("Puppeteer init failed:",e.message||e);}}

// Change thread title
async function changeThreadTitle(apiObj,tid,title){
  if(!apiObj)throw new Error("No api");
  if(typeof apiObj.setTitle==="function")return new Promise((res,rej)=>apiObj.setTitle(title,tid,err=>err?rej(err):res()));
  if(typeof apiObj.changeThreadTitle==="function")return new Promise((res,rej)=>apiObj.changeThreadTitle(title,tid,err=>err?rej(err):res()));
  if(ENABLE_PUPPETEER && puppeteerAvailable){try{await puppeteerPage.goto(`https://www.facebook.com/messages/t/${tid}`,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});await puppeteerPage.waitForTimeout(1200);info(`[${timestamp()}] [PUPP] Puppeteer fallback attempted for title change.`);}catch(e){throw e;}}
  else throw new Error("No method to change thread title");
}

// Load appstate
async function loadAppState(){
  if(process.env.APPSTATE){try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("APPSTATE env invalid JSON:",e.message||e);}}
  try{return JSON.parse(await fsp.readFile(appStatePath,"utf8"));}
  catch(e){throw new Error("Cannot load appstate.json or APPSTATE env");}
}

// Init check
async function initCheckLoop(apiObj){
  try{
    const threadIDs=Object.keys(groupLocks);
    for(let t of threadIDs){
      const group=groupLocks[t];if(!group||!group.enabled)continue;
      try{
        const infoObj=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));
        const participants=infoObj?.participantIDs||(infoObj?.userInfo?.map(u=>u.id))||[];
        for(const uid of participants){
          const desired=group.original?.[uid]||group.nick;
          if(!desired)continue;
          const current=(infoObj.nicknames?.[uid])||(infoObj.userInfo?.find(u=>u.id===uid)?.nickname)||null;
          if(current!==desired){
            queueTask(t,async()=>{try{await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,err=>err?rej(err):res()));info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);await sleep(randomDelay());}catch(e){warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`,e.message||e);}});
          }
        }
      }catch(e){}
    }
  }catch(e){warn("initCheckLoop error:",e.message||e);}
}

// Login & run
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState=await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api=await new Promise((res,rej)=>{try{loginLib({appState},(err,a)=>err?rej(err):res(a));}catch(e){rej(e);}});
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"(unknown)"}`);
      await loadLocks();
      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:",e.message||e));

      // GCLOCK watcher
      setInterval(async()=>{
        const threadIDs=Object.keys(groupLocks);
        for(const threadID of threadIDs){
          const group=groupLocks[threadID];if(!group||!group.gclock||groupNameRevertInProgress[threadID])continue;
          try{
            const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(infoObj && infoObj.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]){groupNameChangeDetected[threadID]=Date.now();info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);}
              else if(Date.now()-groupNameChangeDetected[threadID]>=GROUP_NAME_REVERT_DELAY){
                groupNameRevertInProgress[threadID]=true;
                try{await changeThreadTitle(api,threadID,group.groupName);info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`);}catch(e){warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`,e.message||e);}finally{groupNameChangeDetected[threadID]=null;groupNameRevertInProgress[threadID]=false;}
              }
            } else groupNameChangeDetected[threadID]=null;
          }catch(e){warn(`[${timestamp()}] [GCLOCK] Error checking ${threadID}:`,e.message||e);}
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // Anti-sleep
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          try{
            const g=groupLocks[id];if(!g||(!g.gclock&&!g.enabled))continue;
            await new Promise((res,rej)=>api.sendTypingIndicator(id,err=>err?rej(err):res()));await sleep(1200);
          }catch(e){warn(`[${timestamp()}] Typing indicator failed for ${id}:`,e.message||e);}
        }
      },TYPING_INTERVAL);

      // Appstate backup
      setInterval(async()=>{try{const s=api.getAppState?api.getAppState():null;if(s)await fsp.writeFile(appStatePath,JSON.stringify(s,null,2));info(`[${timestamp()}] Appstate backed up.`);}catch(e){warn("Appstate backup error:",e.message||e);}},APPSTATE_BACKUP_INTERVAL);

      // Init check loop
      await initCheckLoop(api);
      setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

      // Event listener
      api.listenMqtt(async(err,event)=>{
        if(err){warn("listenMqtt error:",err.message||err);return;}
        try{
          const threadID=event.threadID;
          const senderID=event.senderID;
          const body=(event.body||"").toString().trim();

          // Boss commands
          if(event.type==="message"&&senderID===BOSS_UID){
            const lc=body.toLowerCase();
            if(lc==="/nicklock on"){
              const infoThread=event.threadInfo||{};
              const lockedNick="😈Allah madarchod😈";
              groupLocks[threadID]=groupLocks[threadID]||{};
              groupLocks[threadID].enabled=true;
              groupLocks[threadID].nick=lockedNick;
              groupLocks[threadID].original=groupLocks[threadID].original||{};
              groupLocks[threadID].count=0;groupLocks[threadID].cooldown=false;
              // Bot changes own nick first
              const meID=api.getCurrentUserID?api.getCurrentUserID():null;
              if(meID){queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,meID,err=>err?rej(err):res()));info(`[${timestamp()}] Bot nick changed first`);}catch(e){warn("Bot nick change failed:",e.message||e);}});}
              // then other members
              for(const user of (infoThread.userInfo||[])){
                if(user.id===meID)continue;
                groupLocks[threadID].original[user.id]=lockedNick;
                queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,user.id,err=>err?rej(err):res()));info(`[${timestamp()}] Changed nick for ${user.id}`);}catch(e){warn("changeNickname failed:",e.message||e);}await sleep(randomDelay());});
              }
              await saveLocks();info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
            }
            if(lc==="/nicklock off"){if(groupLocks[threadID]){groupLocks[threadID].enabled=false;await saveLocks();info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);}}
          }

          // GCLOCK quick detect
          if(event.type==="event"&&event.logMessageType==="log:thread-name"){
            const lockedName=groupLocks[event.threadID]?.groupName;
            if(lockedName&&event.logMessageData?.name!==lockedName){
              if(!groupNameChangeDetected[event.threadID]){groupNameChangeDetected[event.threadID]=Date.now();info(`[${timestamp()}] [GCLOCK] Detected quick name change -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);}
            }
          }

          // Nick revert
          if(event.logMessageType==="log:user-nickname"){
            const group=groupLocks[threadID];if(!group||!group.enabled||group.cooldown) return;
            const uid=event.logMessageData?.participant_id;
            const currentNick=event.logMessageData?.nickname;
            const lockedNick=(group.original&&group.original[uid])||group.nick;
            if(lockedNick&&currentNick!==lockedNick){
              queueTask(threadID,async()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,err=>err?rej(err):res()));
                  group.count=(group.count||0)+1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid}`);
                  if(group.count>=NICKNAME_CHANGE_LIMIT){group.cooldown=true;warn(`⏸️ [COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);setTimeout(()=>{group.cooldown=false;group.count=0;info(`▶️ [COOLDOWN] Lifted for ${threadID}`);},NICKNAME_COOLDOWN);}
                  else await sleep(randomDelay());
                  await saveLocks();
                }catch(e){warn(`[${timestamp()}] Nick revert failed for ${uid}:`,e.message||e);}
              });
            }
          }

        }catch(e){if((e&&e.message)==="FORCE_RECONNECT")throw e;warn("Event handler error:",e.message||e);}
      });

      loginAttempts=0;break;
    }catch(e){
      error(`[${timestamp()}] Login/Run error:`,e.message||e);
      const backoff=Math.min(60,(loginAttempts+1)*5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff*1000);
    }
  }
}

// Start bot
loginAndRun().catch(e=>{error("Fatal start error:",e.message||e);process.exit(1);});

// Global handlers
process.on("uncaughtException",err=>{error("uncaughtException:",err&&err.stack?err.stack:err);setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000);});
process.on("unhandledRejection",err=>{warn("unhandledRejection:",err.message||err);setTimeout(()=>loginAndRun().catch(e=>error("relogin failed:",e.message||e)),5000);});

// Graceful shutdown
async function gracefulExit(){shuttingDown=true;info("Saving state...");try{if(api&&api.getAppState)await fsp.writeFile(appStatePath,JSON.stringify(api.getAppState(),null,2));}catch(e){} try{await saveLocks();}catch(e){} try{if(puppeteerBrowser)await puppeteerBrowser.close();}catch(e){} process.exit(0);}
process.on("SIGINT",gracefulExit);process.on("SIGTERM",gracefulExit);
