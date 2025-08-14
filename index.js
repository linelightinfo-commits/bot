/**
 * Facebook Messenger Bot - Auto Lock with external group UID file
 * Features:
 * - Auto nickname & group name lock for predefined UIDs
 * - Stop/start lock command
 * - Random nickname delay: 6-7s
 * - Group name revert: 47s
 * - Anti-sleep typing every 5 min
 * - Appstate backup every 10 min
 * - Silent operation
 * - Group UIDs in separate file: groups.json
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
require("dotenv").config();

const C = { reset:"\x1b[0m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m" };
function log(...a){console.log(C.cyan+"[BOT]"+C.reset,...a);}
function info(...a){console.log(C.green+"[INFO]"+C.reset,...a);}
function warn(...a){console.log(C.yellow+"[WARN]"+C.reset,...a);}
function error(...a){console.log(C.red+"[ERR]"+C.reset,...a);}

// Express server for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT||10000;
app.get("/",(req,res)=>res.send("✅ Facebook Bot online"));
app.listen(PORT,()=>log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR,"appstate.json");
const dataFile = path.join(DATA_DIR,"groupData.json");
const groupFile = path.join(DATA_DIR,"groups.json");

// Timing
const GROUP_NAME_CHECK_INTERVAL = 15000;
const GROUP_NAME_REVERT_DELAY = 47000;
const NICKNAME_DELAY_MIN = 6000;
const NICKNAME_DELAY_MAX = 7000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 180000;
const TYPING_INTERVAL = 300000;
const APPSTATE_BACKUP_INTERVAL = 600000;

// State
let api=null, groupLocks={}, groupQueues={}, groupNameChangeDetected={}, groupNameRevertInProgress={}, shuttingDown=false;
const GLOBAL_MAX_CONCURRENT = 3;
let globalActiveCount=0, globalPending=[];

// Helpers
const sleep = ms=>new Promise(res=>setTimeout(res,ms));
function randomDelay(){return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN;}
function timestamp(){return new Date().toTimeString().split(" ")[0];}
async function acquireGlobalSlot(){if(globalActiveCount<GLOBAL_MAX_CONCURRENT){globalActiveCount++;return;}await new Promise(res=>globalPending.push(res));globalActiveCount++;}
function releaseGlobalSlot(){globalActiveCount=Math.max(0,globalActiveCount-1);if(globalPending.length){const r=globalPending.shift();r();}}

async function ensureDataFile(){try{await fsp.access(dataFile);}catch(e){await fsp.writeFile(dataFile,JSON.stringify({},null,2));}}
async function loadLocks(){try{await ensureDataFile();const txt=await fsp.readFile(dataFile,"utf8");groupLocks=JSON.parse(txt||"{}");info("Loaded saved group locks.");}catch(e){warn("Failed to load groupData.json:",e.message||e);groupLocks={};}}
async function saveLocks(){try{const tmp=`${dataFile}.tmp`;await fsp.writeFile(tmp,JSON.stringify(groupLocks,null,2));await fsp.rename(tmp,dataFile);info("Group locks saved.");}catch(e){warn("Failed to save groupData.json:",e.message||e);}}

// Queue system
function ensureQueue(threadID){if(!groupQueues[threadID])groupQueues[threadID]={running:false,tasks:[]};return groupQueues[threadID];}
function queueTask(threadID,fn){const q=ensureQueue(threadID);q.tasks.push(fn);if(!q.running) runQueue(threadID);}
async function runQueue(threadID){const q=ensureQueue(threadID);if(q.running)return;q.running=true;while(q.tasks.length){const fn=q.tasks.shift();try{await acquireGlobalSlot();try{await fn();}finally{releaseGlobalSlot();}}catch(e){warn(`[${timestamp()}] Queue task error for ${threadID}:`,e.message||e);}await sleep(250);}q.running=false;}

// Load groups from file
async function loadGroupUIDs(){
    try{
        const txt = await fsp.readFile(groupFile,"utf8");
        const arr = JSON.parse(txt);
        if(!Array.isArray(arr))throw new Error("groups.json should be an array of UIDs");
        return arr;
    }catch(e){warn("Failed to load groups.json:",e.message||e);return [];}
}

// Load AppState
async function loadAppState(){try{const txt=await fsp.readFile(appStatePath,"utf8");return JSON.parse(txt);}catch(e){throw new Error("Cannot load appstate.json");}}

// ---------------------- Main login ----------------------
async function loginAndRun(){
  while(!shuttingDown){
    try{
      const appState = await loadAppState();
      info(`[${timestamp()}] Logging in...`);
      api = await new Promise((res,rej)=>ws3({appState},(err,a)=>err?rej(err):res(a)));
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[${timestamp()}] Logged in.`);

      await loadLocks();
      const groupUIDs = await loadGroupUIDs();
      const AUTO_NICK = "😈Allah madarchod😈";

      // ----------------- Auto lock all groups -----------------
      for(const threadID of groupUIDs){
        queueTask(threadID, async()=>{
          try{
            const infoThread = await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            const gname = infoThread.threadName||"Group";
            const selfID = api.getCurrentUserID?api.getCurrentUserID():"";

            groupLocks[threadID] = {enabled:true,nick:AUTO_NICK,original:{},count:0,cooldown:false,gclock:true,groupName:gname};

            if(selfID){
              groupLocks[threadID].original[selfID] = AUTO_NICK;
              await new Promise((res,rej)=>api.changeNickname(AUTO_NICK,threadID,selfID,err=>err?rej(err):res()));
            }

            for(const user of(infoThread.userInfo||[])){
              if(user.id===selfID)continue;
              groupLocks[threadID].original[user.id]=AUTO_NICK;
              await new Promise((res,rej)=>api.changeNickname(AUTO_NICK,threadID,user.id,err=>err?rej(err):res()));
              await sleep(randomDelay());
            }
            await saveLocks();
            info(`[${timestamp()}] Locked ${threadID}`);
          }catch(e){warn(`Auto-lock failed for ${threadID}:`,e.message||e);}
        });
      }

      // ----------------- Group-name watcher -----------------
      setInterval(async()=>{
        for(const threadID of Object.keys(groupLocks)){
          const group = groupLocks[threadID];
          if(!group||!group.gclock)continue;
          if(groupNameRevertInProgress[threadID])continue;
          try{
            const infoObj = await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
            if(infoObj.threadName!==group.groupName){
              if(!groupNameChangeDetected[threadID]){groupNameChangeDetected[threadID]=Date.now();}
              else{
                const elapsed = Date.now()-groupNameChangeDetected[threadID];
                if(elapsed>=GROUP_NAME_REVERT_DELAY){
                  groupNameRevertInProgress[threadID]=true;
                  try{await new Promise((res,rej)=>api.setTitle(group.groupName,threadID,err=>err?rej(err):res()));}
                  finally{groupNameChangeDetected[threadID]=null;groupNameRevertInProgress[threadID]=false;}
                }
              }
            } else groupNameChangeDetected[threadID]=null;
          }catch(e){warn(`GCLOCK error ${threadID}:`,e.message||e);}
        }
      },GROUP_NAME_CHECK_INTERVAL);

      // ----------------- Anti-sleep -----------------
      setInterval(async()=>{
        for(const id of Object.keys(groupLocks)){
          try{
            const g=groupLocks[id];
            if(!g||(!g.gclock&&!g.enabled))continue;
            await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res()));
            await sleep(1200);
          }catch(e){warn(`Typing error ${id}:`,e.message||e);}
        }
      },TYPING_INTERVAL);

      // ----------------- Appstate backup -----------------
      setInterval(async()=>{try{const s=api.getAppState?api.getAppState():null;if(s)await fsp.writeFile(appStatePath,JSON.stringify(s,null,2));}catch(e){warn("Appstate backup error:",e.message||e);}},APPSTATE_BACKUP_INTERVAL);

      // ----------------- Event listener -----------------
      api.listenMqtt(async(err,event)=>{
        if(err){warn("listenMqtt error:",err.message||err);return;}
        try{
          const threadID = event.threadID, senderID = event.senderID;
          if(event.logMessageType==="log:user-nickname"){
            const group = groupLocks[threadID];
            if(!group||!group.enabled||group.cooldown)return;
            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original&&group.original[uid])||group.nick;
            if(lockedNick && currentNick!==lockedNick){
              queueTask(threadID,async()=>{
                try{
                  await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,uid,(err)=>err?rej(err):res()));
                  group.count=(group.count||0)+1;
                  if(group.count>=NICKNAME_CHANGE_LIMIT){
                    group.cooldown=true;
                    setTimeout(()=>{group.cooldown=false;group.count=0;},NICKNAME_COOLDOWN);
                  }else await sleep(randomDelay());
                  await saveLocks();
                }catch(e){warn(`Nick revert failed for ${uid} in ${threadID}:`,e.message||e);}
              });
            }
          }
          // Boss commands
          if(event.type==="message" && senderID===BOSS_UID){
            const body=(event.body||"").trim().toLowerCase();
            if(body==="/stoplock" && groupLocks[threadID]){groupLocks[threadID].enabled=false;await saveLocks();}
            if(body==="/startlock" && groupLocks[threadID]){groupLocks[threadID].enabled=true;await saveLocks();}
          }
        }catch(e){warn("Event handler error:",e.message||e);}
      });

      break; // login success
    }catch(e){error("Login error:",e.message||e);await sleep(5000);}
  }
}

loginAndRun().catch(e=>{error("Fatal start error:",e.message||e);process.exit(1);});

// Graceful shutdown
async function gracefulExit(){shuttingDown=true;try{if(api&&api.getAppState)await fsp.writeFile(appStatePath,JSON.stringify(api.getAppState(),null,2));}catch(e){} try{await saveLocks();}catch(e){} process.exit(0);}
process.on("SIGINT",gracefulExit);
process.on("SIGTERM",gracefulExit);
