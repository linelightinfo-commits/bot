// ========================= FB Messenger Advanced Bot =========================
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();
const express = require("express");
const app = express();

const PORT = process.env.PORT || 10000;
app.get("/", (req,res)=>res.send("✅ FB Bot is Online"));
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));

// -------------------- Config --------------------
const BOSS_UID = process.env.BOSS_UID || "61578631626802";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const APPSTATE = path.join(DATA_DIR,"appstate.json");
const DATA_FILE = path.join(DATA_DIR,"groupData.json");

// -------------------- Utils --------------------
const sleep = ms=>new Promise(res=>setTimeout(res,ms));
const randDelay = (min=1800,max=3200)=>Math.floor(Math.random()*(max-min+1))+min;
const timestamp = ()=>new Date().toTimeString().split(" ")[0];
function log(type,msg){ console.log(`[${type}] [${timestamp()}] ${msg}`); }

// -------------------- Global --------------------
let api=null, groupLocks={}, nicknameQueue={}, nickCount=0;

// -------------------- Load/Save Locks --------------------
async function ensureData(){ if(!fs.existsSync(DATA_FILE)) await fsp.writeFile(DATA_FILE,"{}"); }
async function loadLocks(){ await ensureData(); groupLocks=JSON.parse(await fsp.readFile(DATA_FILE,"utf8")||"{}"); log("INFO","Locks loaded"); }
async function saveLocks(){ await fsp.writeFile(DATA_FILE,JSON.stringify(groupLocks,null,2)); log("INFO","Locks saved"); }

// -------------------- Login --------------------
async function loadAppState(){ return JSON.parse(await fsp.readFile(APPSTATE,"utf8")); }

async function loginAndRun(){
    while(true){
        try{
            const appState = await loadAppState();
            api = await new Promise((res,rej)=>{
                loginLib({appState},(err,a)=>err?rej(err):res(a));
            });
            api.setOptions({listenEvents:true,selfListen:true,updatePresence:true});
            log("INFO",`Logged in as ${api.getCurrentUserID()}`);
            await loadLocks();

            // -------------------- GCLOCK --------------------
            setInterval(async()=>{
                for(const t of Object.keys(groupLocks)){
                    const g = groupLocks[t];
                    if(!g?.gclock) continue;
                    try{
                        const infoThread = await new Promise((res,rej)=>api.getThreadInfo(t,(err,r)=>err?rej(err):res(r)));
                        if(infoThread.threadName!==g.groupName){
                            await new Promise((res,rej)=>api.changeThreadTitle(g.groupName,t,(err)=>err?rej(err):res()));
                            log("GCLOCK",`Reverted ${t} -> ${g.groupName}`);
                        }
                    }catch(e){ log("WARN",`GCLOCK error ${t}: ${e.message||e}`); }
                }
            },45000);

            // -------------------- Anti-sleep --------------------
            setInterval(()=>{
                for(const t of Object.keys(groupLocks)){
                    if(groupLocks[t].enabled){
                        api.sendTyping(t,true);
                    }
                }
            },5*60*1000);

            // -------------------- Appstate backup --------------------
            setInterval(async()=>{
                await fsp.copyFile(APPSTATE,APPSTATE+".bak");
                log("INFO","Appstate backup done");
            },10*60*1000);

            // -------------------- Event listener --------------------
            api.listenMqtt(async(err,event)=>{
                if(err){ log("WARN","MQTT error:"+err.message); return; }
                try{
                    const threadID=event.threadID, senderID=event.senderID, body=(event.body||"").toString().trim();
                    if(event.type==="message" && senderID===BOSS_UID){
                        const lc=body.toLowerCase();
                        // ---------- Nicklock ON ----------
                        if(lc==="/nicklock on"){
                            const infoThread = await new Promise((res,rej)=>api.getThreadInfo(threadID,(err,r)=>err?rej(err):res(r)));
                            groupLocks[threadID]=groupLocks[threadID]||{enabled:true,nick:"😈Allah😈",original:{}};
                            groupLocks[threadID].enabled=true;
                            groupLocks[threadID].nick="😈Allah😈";

                            // Bot first
                            await new Promise((res,rej)=>api.changeNickname(groupLocks[threadID].nick,threadID,api.getCurrentUserID(),(err)=>err?rej(err):res()));
                            log("NICKLOCK","Bot nick changed first");

                            // All participants
                            for(const u of infoThread.participantIDs){
                                if(u===api.getCurrentUserID()) continue;
                                try{
                                    await new Promise((res,rej)=>api.changeNickname(groupLocks[threadID].nick,threadID,u,(err)=>err?rej(err):res()));
                                    log("NICKLOCK",`Nick applied ${u}`);
                                    nickCount++;
                                    if(nickCount>=60){ log("INFO","Cooldown 3 min"); await sleep(3*60*1000); nickCount=0; }
                                    await sleep(randDelay());
                                }catch(e){ log("WARN",`Nick fail ${u}: ${e.message||e}`); }
                            }
                            await saveLocks();
                        }
                        // ---------- Nicklock OFF ----------
                        else if(lc==="/nicklock off"){
                            if(groupLocks[threadID]){ groupLocks[threadID].enabled=false; await saveLocks(); log("NICKLOCK","Deactivated "+threadID); }
                        }
                        // ---------- Gclock ----------
                        else if(lc.startsWith("/gclock ")){
                            const title = body.substring(8).trim();
                            groupLocks[threadID]=groupLocks[threadID]||{};
                            groupLocks[threadID].gclock=true;
                            groupLocks[threadID].groupName=title;
                            log("GCLOCK",`Set ${threadID} -> ${title}`);
                            await saveLocks();
                        }
                        else if(lc==="/unlockgname"){
                            if(groupLocks[threadID]){ groupLocks[threadID].gclock=false; await saveLocks(); log("GCLOCK","Unlocked "+threadID); }
                        }
                    }
                }catch(e){ log("WARN","Event error:"+e.message); }
            });

            break; // Login success, exit while
        }catch(e){ log("WARN","Login failed: "+(e.message||e)); await sleep(5000); }
    }
}

// -------------------- Start --------------------
loginAndRun();
