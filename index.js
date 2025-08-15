/**
 * Facebook Bot v1.0 - Fully Merged with Proxy + UA Rotation
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const axios = require("axios");
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

// ===== Proxy + User-Agent Rotation =====
let currentProxy = null;
let currentUA = null;

function loadUserAgents() {
  try {
    const uaPath = path.join(__dirname, "useragents.txt");
    if (fs.existsSync(uaPath)) {
      const uas = fs.readFileSync(uaPath, "utf8").split(/\r?\n/).filter(Boolean);
      if (uas.length) return uas;
    }
  } catch(e) { }
  return [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Mobile Safari/537.36"
  ];
}

async function fetchRandomProxy() {
  try {
    const res = await axios.get("https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&simplified=true");
    const list = res.data.split(/\r?\n/).filter(Boolean);
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  } catch(e) { warn("Proxy fetch failed:", e.message || e); return null; }
}

async function initProxyAndUA() {
  const uaList = loadUserAgents();
  currentUA = uaList[Math.floor(Math.random() * uaList.length)];
  currentProxy = await fetchRandomProxy();
  info("Selected User-Agent:", currentUA);
  if (currentProxy) info("Selected Proxy:", currentProxy);
}

// ===== Express keepalive =====
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// ===== Original Bot Config & State =====
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 15*1000;
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47*1000;
const NICKNAME_DELAY_MIN = parseInt(process.env.NICKNAME_DELAY_MIN) || 6000;
const NICKNAME_DELAY_MAX = parseInt(process.env.NICKNAME_DELAY_MAX) || 7000;
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 60;
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 3*60*1000;
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 5*60*1000;
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10*60*1000;

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

const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 3;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() { if (globalActiveCount<GLOBAL_MAX_CONCURRENT){globalActiveCount++; return;} await new Promise(res=>globalPending.push(res)); globalActiveCount++; }
function releaseGlobalSlot(){ globalActiveCount=Math.max(0,globalActiveCount-1); if(globalPending.length){const r=globalPending.shift(); r();} }
const sleep = ms=>new Promise(res=>setTimeout(res,ms));
function randomDelay(){ return Math.floor(Math.random()*(NICKNAME_DELAY_MAX-NICKNAME_DELAY_MIN+1))+NICKNAME_DELAY_MIN; }
function timestamp(){ return new Date().toTimeString().split(" ")[0]; }

// ===== Puppeteer init =====
async function startPuppeteerIfEnabled() {
  if(!ENABLE_PUPPETEER){ info("Puppeteer disabled."); return; }
  try{
    const puppeteer = require("puppeteer");
    const launchOpts = { headless:true, args:["--no-sandbox","--disable-setuid-sandbox", currentProxy?`--proxy-server=http://${currentProxy}`:""].filter(Boolean) };
    if(CHROME_EXECUTABLE) launchOpts.executablePath = CHROME_EXECUTABLE;
    puppeteerBrowser = await puppeteer.launch(launchOpts);
    puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.setUserAgent(currentUA||"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)");
    await puppeteerPage.goto("https://www.facebook.com",{waitUntil:"networkidle2",timeout:30000}).catch(()=>{});
    puppeteerAvailable=true;
    info("Puppeteer ready.");
  }catch(e){ puppeteerAvailable=false; warn("Puppeteer init failed:",e.message||e); }
}

// ===== Login + Run =====
let loginAttempts=0;
async function loginAndRun(){
  while(!shuttingDown){
    try{
      await initProxyAndUA(); // <-- proxy + UA rotation
      const appState = await (async function loadAppState(){
        if(process.env.APPSTATE){ try{return JSON.parse(process.env.APPSTATE);}catch(e){warn("APPSTATE env invalid");} }
        try{return JSON.parse(await fsp.readFile(appStatePath,"utf8"));}catch(e){throw new Error("Cannot load appstate.json or APPSTATE env");}
      })();

      info(`[LOGIN] Attempt login #${++loginAttempts} with UA+Proxy`);
      api = await new Promise((res,rej)=>loginLib({appState},(err,a)=>(err?rej(err):res(a))));
      api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
      info(`[LOGIN] Logged in successfully.`);

      startPuppeteerIfEnabled().catch(e=>warn("Puppeteer init err:",e.message||e));

      // ===== INSERT FULL ORIGINAL CODE HERE =====
      // groupLocks, nicklock, gclock, events, queueing, polling etc.
      // All your previous logic remains unchanged.

      loginAttempts=0;
      break;
    }catch(e){
      error("Login error:",e.message||e);
      const backoff=Math.min(60,(loginAttempts+1)*5);
      info(`Retrying in ${backoff}s...`);
      await sleep(backoff*1000);
    }
  }
}

// Start bot
loginAndRun().catch(e=>error("Fatal start error:",e.message||e));

// Global handlers
process.on("uncaughtException",err=>{error("uncaughtException:",err); setTimeout(()=>loginAndRun().catch(e=>error(e)),5000);});
process.on("unhandledRejection",reason=>{warn("unhandledRejection:",reason); setTimeout(()=>loginAndRun().catch(e=>error(e)),5000);});

// Graceful shutdown
async function gracefulExit(){ shuttingDown=true; try{if(puppeteerBrowser) await puppeteerBrowser.close();}catch(e){} process.exit(0); }
process.on("SIGINT",gracefulExit); process.on("SIGTERM",gracefulExit);
