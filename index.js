/**
 * Facebook Messenger Bot - Final Modified Version
 * - Nickname lock with bot-first change
 * - Group name lock
 * - Cooldown, random delay, anti-sleep, appstate backup
 * - Silent operation, global concurrency limiter
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
function log(...a){console.log(C.cyan+"[BOT]"+C.reset,...a);}
function info(...a){console.log(C.green+"[INFO]"+C.reset,...a);}
function warn(...a){console.log(C.yellow+"[WARN]"+C.reset,...a);}
function error(...a){console.log(C.red+"[ERR]"+C.reset,...a);}

// Express for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req,res)=>res.send("✅ Facebook Bot is online!"));
app.listen(PORT,()=>log(`Server started on port ${PORT}`));

// Config
const BOSS_UID = process.env.BOSS_UID||"61578631626802";
const DATA_DIR = process.env.DATA_DIR||__dirname;
const appStatePath = path.join(DATA_DIR,"appstate.json");
const dataFile = path.join(DATA_DIR,"groupData.json");

// Timing & rules
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL)||15000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY)||47000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN)||6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX)||7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT)||60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN)||3*60*1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL)||5*60*1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL)||10*60*1000;
const ENABLE_PUPPETEER = (process.env.ENABLE_PUPPETEER||"false").toLowerCase()==="true";
const CHROME_EXECUTABLE = process.env.CHROME_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||null;

// State
let api=null, groupLocks={}, groupQueues={}, groupNameChangeDetected={}, groupNameRevertInProgress={}, puppeteerBrowser=null, puppeteerPage=null, puppeteerAvailable=false, shuttingDown=false;
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT)||3;
let globalActiveCount=0, globalPending=[];

// Helpers
const sleep=ms=>new Promise(res=>setTimeout(res,ms));
function randomDelay(){return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN;}
function timestamp(){return new Date().toTimeString().split(" ")[0];}

async function ensureDataFile(){try{await fsp.access(dataFile);}catch(e){await fsp.writeFile(dataFile,JSON.stringify({},null,2));}}
async function loadLocks(){try{await ensureDataFile();groupLocks=JSON.parse(await fsp.readFile(dataFile,"utf8")||"{}");info("Loaded saved group locks.");}catch(e){warn("Failed to load groupData.json:",e.message||e);groupLocks={};}}
async function saveLocks(){try{const tmp=`${dataFile}.tmp`;await fsp.writeFile(tmp,JSON.stringify(groupLocks,null,2));await fsp.rename(tmp,dataFile);info("Group locks saved.");}catch(e){warn("Failed to save groupData.json:",e.message||e);}}

async function acquireGlobalSlot(){if(globalActiveCount<GLOBAL_MAX_CONCURRENT){globalActiveCount++;return;}await new Promise(res=>globalPending.push(res));globalActiveCount++;}
function releaseGlobalSlot(){globalActiveCount=Math.max(0,globalActiveCount-1);if(globalPending.length){const r=globalPending.shift();r();}}

function ensureQueue(threadID){if(!groupQueues[threadID])groupQueues[threadID]={running:false,tasks:[]};return groupQueues[threadID];}
function queueTask(threadID,fn){const q=ensureQueue(threadID);q.tasks.push(fn);if(!q.running)runQueue(threadID);}
async function runQueue(threadID){const q=ensureQueue(threadID);if(q.running)return;q.running=true;while(q.tasks.length){const fn=q.tasks.shift();try{await acquireGlobalSlot();try{await fn();}finally{releaseGlobalSlot();}}catch(e){warn(`[${timestamp()}] Queue task error for ${threadID}:`,e.message||e);}await sleep(250);}q.running=false;}

async function startPuppeteerIfEnabled(){if(!ENABLE_PUPPETEER){info("Puppeteer disabled.");return;}try{const puppeteer=require("puppeteer");const launchOpts={headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]};if(CHROME_EXECUTABLE)launchOpts.executablePath=CHROME_EXECUTABLE;puppeteerBrowser=await puppeteer.launch(launchOpts);puppeteerPage=await puppeteerBrowser.newPage();await puppeteerPage.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});puppeteerAvailable=true;info("Puppeteer ready.");}catch(e){puppeteerAvailable=false;warn("Puppeteer init failed:",e.message||e);}}

async function changeThreadTitle(apiObj,threadID,title){if(!apiObj)throw new Error("No api");if(typeof apiObj.setTitle==="function")return new Promise((r,rej)=>apiObj.setTitle(title,threadID,(err)=>err?rej(err):r()));if(typeof apiObj.changeThreadTitle==="function")return new Promise((r,rej)=>apiObj.changeThreadTitle(title,threadID,(err)=>err?rej(err):r()));if(ENABLE_PUPPETEER&&puppeteerAvailable){try{const url=`https://www.facebook.com/messages/t/${threadID}`;await puppeteerPage.goto(url,{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});await puppeteerPage.waitForTimeout(1200);info(`[${timestamp()}] [PUPP] Puppeteer fallback attempted for title change (best-effort).`);return;}catch(e){throw e;}}throw new Error("No method to change thread title");}

async function loadAppState(){if(process.env.APPSTATE){try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("APPSTATE env invalid JSON:",e.message||e);}}try{return JSON.parse(await fsp.readFile(appStatePath,"utf8"));}catch(e){throw new Error("Cannot load appstate.json or APPSTATE env");}}

async function initCheckLoop(apiObj){try{const threadIDs=Object.keys(groupLocks);for(let t of threadIDs){const group=groupLocks[t];if(!group||!group.enabled)continue;try{const info=await new Promise((res,rej)=>apiObj.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));const participants=info?.participantIDs||(info?.userInfo&&info.userInfo.map(u=>u.id))||[];for(const uid of participants){const desired=group.original?.[uid]||group.nick;if(!desired)continue;const current=(info.nicknames&&info.nicknames[uid])||(info.userInfo&&info.userInfo.find(u=>u.id===uid)?.nickname)||null;if(current!==desired){queueTask(t,async()=>{try{await new Promise((res,rej)=>apiObj.changeNickname(desired,t,uid,(err)=>err?rej(err):res()));info(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t}`);await sleep(randomDelay());}catch(e){warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`,e.message||e);}});}}}catch(e){}}}catch(e){warn("initCheckLoop error:",e.message||e);}} 

// Main login + run with reconnect logic
let loginAttempts=0;
async function loginAndRun(){while(!shuttingDown){try{const appState=await loadAppState();info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);api=await new Promise((res,rej)=>{try{loginLib({appState},(err,a)=>err?rej(err):res(a));}catch(e){rej(e);}});api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});const botID=api.getCurrentUserID?api.getCurrentUserID():null;info(`[${timestamp()}] Logged in as ${botID}`);
await loadLocks();
startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:",e.message||e));

// group-name watcher
setInterval(async()=>{const threadIDs=Object.keys(groupLocks);const MAX_PER_TICK=20;for(let i=0;i<Math.min(MAX_PER_TICK,threadIDs.length);i++){const threadID=threadIDs[i];const group=groupLocks[threadID];if(!group||!group.gclock)continue;if(groupNameRevertInProgress[threadID])continue;try{const infoObj=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));if(infoObj&&infoObj.threadName!==group.groupName){if(!groupNameChangeDetected[threadID]){groupNameChangeDetected[threadID]=Date.now();info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${infoObj.threadName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s if still changed.`);}else{const elapsed=Date.now()-groupNameChangeDetected[threadID];if(elapsed>=GROUP_NAME_REVERT_DELAY){groupNameRevertInProgress[threadID]=true;try{await changeThreadTitle(api,threadID,group.groupName);info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`);}catch(e){warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`,e.message||e);}finally{groupNameChangeDetected[threadID]=null;groupNameRevertInProgress[threadID]=false;}}}}else{groupNameChangeDetected[threadID]=null;}}catch(e){warn(`[${timestamp()}] [GCLOCK] Error checking ${threadID}:`,e.message||e);}}},GROUP_NAME_CHECK_INTERVAL);

// anti-sleep typing
setInterval(async()=>{for(const id of Object.keys(groupLocks)){try{const g=groupLocks[id];if(!g||(!g.gclock&&!g.enabled))continue;await new Promise((res,rej)=>api.sendTypingIndicator(id,(err)=>err?rej(err):res()));await sleep(1200);}catch(e){warn(`[${timestamp()}] Typing indicator failed for ${id}:`,e.message||e);if((e.message||"").toLowerCase().includes("client disconnecting")||(e.message||"").toLowerCase().includes("not logged in")){warn("Detected client disconnect - attempting reconnect...");try{api.removeAllListeners&&api.removeAllListeners();}catch(_){ } throw new Error("FORCE_RECONNECT");}}},TYPING_INTERVAL);

// appstate backup
setInterval(async()=>{try{const s=api.getAppState?api.getAppState():null;if(s)await fsp.writeFile(appStatePath,JSON.stringify(s,null,2));info(`[${timestamp()}] Appstate backed up.`);}catch(e){warn("Appstate backup error:",e.message||e);}},APPSTATE_BACKUP_INTERVAL);

// initial init check
await initCheckLoop(api);setInterval(()=>initCheckLoop(api).catch(e=>warn("initCheck error:",e.message||e)),5*60*1000);

// Event listener
api.listenMqtt(async(err,event)=>{if(err){warn("listenMqtt error:",err.message||err);return;}try{const threadID=event.threadID,senderID=event.senderID,body=(event.body||"").toString().trim();

// Boss commands
if(event.type==="message"&&senderID===BOSS_UID){const lc=(body||"").toLowerCase();
if(lc==="/nicklock on"){
try{
const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
const lockedNick="😈Allah madarchod😈";
groupLocks[threadID]=groupLocks[threadID]||{};
groupLocks[threadID].enabled=true;
groupLocks[threadID].nick=lockedNick;
groupLocks[threadID].original=groupLocks[threadID].original||{};
groupLocks[threadID].count=0;
groupLocks[threadID].cooldown=false;

// Bot nickname first
if(botID){queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,botID,(err)=>err?rej(err):res()));info(`[${timestamp()}] Changed bot nick in ${threadID}`);await sleep(randomDelay());}catch(e){warn(`[${timestamp()}] Failed bot nick change:`,e.message||e);}});}

// Then participants
for(const user of (infoThread.userInfo||[])){if(user.id===botID)continue;groupLocks[threadID].original[user.id]=lockedNick;queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(lockedNick,threadID,user.id,(err)=>err?rej(err):res()));info(`[${timestamp()}] Changed nick for ${user.id} in ${threadID}`);await sleep(randomDelay());}catch(e){warn(`[${timestamp()}] changeNickname failed for ${user.id}:`,e.message||e);}});}
await saveLocks();info(`[${timestamp()}] [NICKLOCK] Activated for ${threadID}`);
}catch(e){warn(`[${timestamp()}] Nicklock activation failed:`,e.message||e);}}

if(lc==="/nicklock off"){if(groupLocks[threadID]){groupLocks[threadID].enabled=false;await saveLocks();info(`[${timestamp()}] [NICKLOCK] Deactivated for ${threadID}`);}}

if(lc==="/nickall"){const data=groupLocks[threadID];if(!data?.enabled)return;try{const infoThread=await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));

// Bot first
if(botID){queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(data.nick,threadID,botID,(err)=>err?rej(err):res()));info(`[${timestamp()}] Reapplied bot nick for ${threadID}`);await sleep(randomDelay());}catch(e){warn(`Bot nick apply failed:`,e.message||e);}});}

// Participants
for(const user of (infoThread.userInfo||[])){if(user.id===botID)continue;data.original=data.original||{};data.original[user.id]=data.nick;queueTask(threadID,async()=>{try{await new Promise((res,rej)=>api.changeNickname(data.nick,threadID,user.id,(err)=>err?rej(err):res()));info(`[${timestamp()}] Reapplied nick for ${user.id}`);await sleep(randomDelay());}catch(e){warn(`[${timestamp()}] Nick apply failed:`,e.message||e);}});}
await saveLocks();info(`[${timestamp()}] [REAPPLY] Nicknames reapplied for ${threadID}`);}catch(e){warn(`[${timestamp()}] /nickall failed:`,e.message||e);}}

// gclock, unlock etc same as before (unchanged) ...

}catch(e){if((e&&e.message)==="FORCE_RECONNECT")throw e;warn("Event handler caught error:",e.message||e);}});

loginAttempts=0;break;}catch(e){error(`[${timestamp()}] Login/Run error:`,e.message||e);const backoff=Math.min(60,(loginAttempts+1)*5);info(`Retrying login in ${backoff}s...`);await sleep(backoff*1000);}}}

loginAndRun().catch(e=>{error("Fatal start error:",e.message||e);process.exit(1);});

process.on("uncaughtException",err=>{error("uncaughtException:",err&&err.stack?err.stack:err);try{if(api&&api.removeAllListeners)api.removeAllListeners();}catch(_){ } setTimeout(()=>loginAndRun().catch(e=>error("relogin after exception failed:",e.message||e)),5000);});
process.on("unhandledRejection",reason=>{warn("unhandledRejection:",reason);setTimeout(()=>loginAndRun().catch(e=>error("relogin after rejection failed:",e.message||e)),5000);});

async function gracefulExit(){shuttingDown=true;info("Graceful shutdown: saving state...");try{if(api&&api.getAppState)await fsp.writeFile(appStatePath,JSON
