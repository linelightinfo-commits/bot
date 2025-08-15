/**
 * Facebook Messenger Bot
 * Fixed nickname & GCLOCK issues
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
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = 15000;
const GROUP_NAME_REVERT_DELAY = 47000;
const NICKNAME_DELAY_MIN = 6000;
const NICKNAME_DELAY_MAX = 7000;
const NICKNAME_CHANGE_LIMIT = 60;
const NICKNAME_COOLDOWN = 3*60*1000;
const TYPING_INTERVAL = 5*60*1000;
const APPSTATE_BACKUP_INTERVAL = 10*60*1000;

let api=null, groupLocks={}, groupQueues={}, groupNameChangeDetected={}, groupNameRevertInProgress={}, shuttingDown=false;
const GLOBAL_MAX_CONCURRENT = 3;
let globalActiveCount=0, globalPending=[];

async function acquireGlobalSlot(){ if(globalActiveCount<GLOBAL_MAX_CONCURRENT){ globalActiveCount++; return; } await new Promise(r=>globalPending.push(r)); globalActiveCount++; }
function releaseGlobalSlot(){ globalActiveCount=Math.max(0,globalActiveCount-1); if(globalPending.length){ const r=globalPending.shift(); r(); } }

const sleep = ms=>new Promise(res=>setTimeout(res,ms));
function randomDelay(){ return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp(){ return new Date().toTimeString().split(" ")[0]; }

function ensureQueue(threadID){ if(!groupQueues[threadID]) groupQueues[threadID]={running:false,tasks:[]}; return groupQueues[threadID]; }
function queueTask(threadID,fn){ const q=ensureQueue(threadID); q.tasks.push(fn); if(!q.running) runQueue(threadID); }
async function runQueue(threadID){ const q=ensureQueue(threadID); if(q.running) return; q.running=true; while(q.tasks.length){ const fn=q.tasks.shift(); try{ await acquireGlobalSlot(); try{ await fn(); } finally{ releaseGlobalSlot(); } }catch(e){ warn(`[${timestamp()}] Queue error ${threadID}:`,e.message||e); } await sleep(250); } q.running=false; }

async function ensureDataFile(){ try{ await fsp.access(dataFile); }catch(e){ await fsp.writeFile(dataFile,JSON.stringify({},null,2)); } }
async function loadLocks(){ await ensureDataFile(); try{ const txt=await fsp.readFile(dataFile,"utf8"); groupLocks=JSON.parse(txt||"{}"); info("Loaded group locks."); }catch(e){ warn("Failed to load group locks:",e.message||e); groupLocks={}; } }
async function saveLocks(){ try{ const tmp=`${dataFile}.tmp`; await fsp.writeFile(tmp,JSON.stringify(groupLocks,null,2)); await fsp.rename(tmp,dataFile); info("Group locks saved."); }catch(e){ warn("Failed to save locks:",e.message||e); } }

async function getThreadInfoRetry(threadID,retries=3){ for(let i=0;i<retries;i++){ try{ const info=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r))); if(info) return info; }catch(e){ await sleep(1000); } } throw new Error(`Cannot fetch thread info for ${threadID}`); }

async function initCheckLoop(apiObj){ try{ const threads=Object.keys(groupLocks); for(const t of threads){ const group=groupLocks[t]; if(!group||!group.enabled) continue; let infoThread; try{ infoThread=await getThreadInfoRetry(t); }catch(e){ warn("Init check failed for",t); continue; } const participants=infoThread.participantIDs||infoThread.userInfo?.map(u=>u.id)||[]; for(const uid of participants){ const desired=group.original?.[uid]||group.nick; if(!desired) continue; const current=(infoThread.nicknames?.[uid])||(infoThread.userInfo?.find(u=>u.id===uid)?.nickname)||null; if(current!==desired){ queueTask(t,async()=>{ try{ await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res())); info(`🎭 [${timestamp()}] [INIT] Nick applied ${uid} in ${t}`); await sleep(randomDelay()); }catch(e){ warn(`[${timestamp()}] INIT failed ${uid} in ${t}:`,e.message||e); } }); } } } }catch(e){ warn("initCheckLoop error:",e.message||e); } }

async function changeThreadTitle(apiObj,threadID,title){ if(!apiObj) throw new Error("No api"); if(typeof apiObj.setTitle==="function") return new Promise((r,rej)=>apiObj.setTitle(title,threadID,(err)=>err?rej(err):r())); if(typeof apiObj.changeThreadTitle==="function") return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?rej(err):r())); throw new Error("No method to change title"); }

async function loadAppState(){ if(process.env.APPSTATE){ try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("APPSTATE env invalid JSON");} } try{ const txt=await fsp.readFile(appStatePath,"utf8"); return JSON.parse(txt); }catch(e){ throw new Error("Cannot load appstate"); } }

async function loginAndRun(){ while(!shuttingDown){ try{ const appState=await loadAppState(); api=await new Promise((res,rej)=>{ try{ loginLib({appState},(err,a)=>err?rej(err):res(a)); }catch(e){rej(e);} }); api.setOptions({listenEvents:true,selfListen:true,updatePresence:true}); info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID?api.getCurrentUserID():"?"}`); await loadLocks(); await initCheckLoop(api);  

// GCLOCK watcher
setInterval(async()=>{ for(const t of Object.keys(groupLocks)){ const g=groupLocks[t]; if(!g?.gclock) continue; if(groupNameRevertInProgress[t]) continue; try{ const infoThread=await getThreadInfoRetry(t); if(infoThread.threadName!==g.groupName){ if(!groupNameChangeDetected[t]){ groupNameChangeDetected[t]=Date.now(); info(`[${timestamp()}] [GCLOCK] Detected change ${t} -> will revert in 47s`); } else if(Date.now()-groupNameChangeDetected[t]>=GROUP_NAME_REVERT_DELAY){ groupNameRevertInProgress[t]=true; try{ await changeThreadTitle(api,t,g.groupName); info(`[${timestamp()}] [GCLOCK] Reverted ${t} -> ${g.groupName}`); }catch(e){ warn(`[${timestamp()}] GCLOCK revert failed ${t}:`,e.message||e); } finally{ groupNameChangeDetected[t]=null; groupNameRevertInProgress[t]=false; } } }else groupNameChangeDetected[t]=null; }catch(e){ warn(`[${timestamp()}] GCLOCK check failed ${t}:`,e.message||e); } } },GROUP_NAME_CHECK_INTERVAL);

// Anti-sleep
setInterval(async()=>{ for(const id of Object.keys(groupLocks)){ const g=groupLocks[id]; if(!g||(!g.gclock&&!g.enabled)) continue; try{ await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res())); await sleep(1200); }catch(e){ warn(`[${timestamp()}] Typing failed for ${id}:`,e.message||e); } } },TYPING_INTERVAL);

// Appstate backup
setInterval(async()=>{ try{ const s=api.getAppState?api.getAppState():null; if(s) await fsp.writeFile(appStatePath,JSON.stringify(s,null,2)); info(`[${timestamp()}] Appstate backed up.`); }catch(e){ warn("Appstate backup failed:",e.message||e); } },APPSTATE_BACKUP_INTERVAL);

// Event listener
api.listenMqtt(async(err,event)=>{ if(err){ warn("listenMqtt error:",err.message||err); return; } try{ const threadID=event.threadID,senderID=event.senderID,body=(event.body||"").toString().trim(); if(event.type==="message" && senderID===BOSS_UID){ const lc=body.toLowerCase(); if(lc==="/nicklock on"){ const infoThread=await getThreadInfoRetry(threadID); groupLocks[threadID]=groupLocks[threadID]||{enabled:true,nick:"😈Allah😈",original:{},count:0,cooldown:false}; groupLocks[threadID].enabled=true; groupLocks[threadID].nick="😈Allah😈"; groupLocks[threadID].original=groupLocks[threadID].original||{}; groupLocks[threadID].count=0; groupLocks[threadID].cooldown=false; // first apply bot nick queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(groupLocks[threadID].nick,threadID,api.getCurrentUserID(),(err)=>err?rej(err):res())); info(`[${timestamp()}] Bot nick changed first`); await sleep(randomDelay()); }catch(e){ warn("Bot nick apply failed:",e.message||e); } }); // then apply all participants for(const u of infoThread.participantIDs){ groupLocks[threadID].original[u]=groupLocks[threadID].nick; queueTask(threadID,async()=>{ try{ await new Promise((res,rej)=>api.changeNickname(groupLocks[threadID].nick,threadID,u,(err)=>err?rej(err):res())); info(`🎭 [${timestamp()}] [NICKLOCK] Nick applied ${u}`); await sleep(randomDelay()); }catch(e){ warn(`Nick apply failed ${u}:`,e.message||e); } }); } await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`); }else if(lc==="/nicklock off"){ if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`); } } else if(lc.startsWith("/gclock ")){ const title=body.substring(8).trim(); groupLocks[threadID]=groupLocks[threadID]||{}; groupLocks[threadID].gclock=true; groupLocks[threadID].groupName=title; info(`[${timestamp()}] [GCLOCK] Set ${threadID} -> ${title}`); await saveLocks(); } else if(lc==="/unlockgname"){ if(groupLocks[threadID]){ groupLocks[threadID].gclock=false; await saveLocks(); info(`[${timestamp()}] [GCLOCK] Unlocked ${threadID}`); } } } }catch(e){ warn("Event listener main error:",e.message||e); } });

break; }catch(e){ warn("Login error:",e.message||e); await sleep(5000); } } }

loginAndRun();
