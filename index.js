// index.js – final non-stop nickname/group-name lock bot
const ws3  = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs    = require("fs");
const path  = require("path");
const express = require("express");

// ===== basic tiny web-server (anti-sleep) =====
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("✅ Bot online"));
app.listen(PORT, () => console.log(`🌐 Bot server on ${PORT}`));

// ===== constants =====
const BOSS_UID = "61578631626802";                // सिर्फ यही UID “admin” है
const appState = JSON.parse(fs.readFileSync("appstate.json","utf8"));
const dataPath = path.join(__dirname,"groupData.json");
if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath,"{}");
const groupData = JSON.parse(fs.readFileSync(dataPath,"utf8"));
const save = () => fs.writeFileSync(dataPath, JSON.stringify(groupData,null,2));

// ===== helpers =====
const randDelay = () => Math.floor(1500 + Math.random()*1000);     // 1.5-2.5 s
const safeLog   = (...msg)=>console.log(new Date().toLocaleTimeString(),"|",...msg);

// ===== login =====
login({appState}, (err, api)=>{
  if (err) return console.error("❌ LOGIN:",err);

  api.setOptions({listenEvents:true, selfListen:true, updatePresence:true});
  safeLog("🤖 Bot logged-in OK!");

  // anti-sleep typing ping
  setInterval(()=> {
    Object.keys(groupData).forEach(tid => api.sendTypingIndicator(tid,true)
      .then(()=>setTimeout(()=>api.sendTypingIndicator(tid,false),1000))
      .catch(()=>{}));
  }, 5*60*1000);

  // ===== helper fns =====
  const setNick = (tid, uid, nick)=>
    new Promise(res=>{
      api.changeNickname(nick,tid,uid, e=>{
        if(e){ safeLog("⚠️ Nick-error",uid,e.error||e); return res(false);}
        safeLog("✅ nick set",uid);
        res(true);
      });
    });

  const lockAllNicks = async (tid, nick)=>{
    const info = await api.getThreadInfo(tid).catch(e=>{safeLog("threadInfo err",e); return null;});
    if(!info) return;
    for(const uid of info.participantIDs){
      await setNick(tid,uid,nick);
      await new Promise(r=>setTimeout(r,randDelay()));
    }
  };

  const revertChangedNick = async (tid, uid)=>{
    const lock = groupData[tid]?.nickLock;
    if(!lock) return;
    await new Promise(r=>setTimeout(r,randDelay()));
    setNick(tid,uid,lock);
  };

  const revertGroupName = (tid, current)=>{
    const lock = groupData[tid]?.gNameLock;
    if(!lock || current===lock) return;
    setTimeout(()=>{
      api.setTitle(lock,tid, e=>{
        if(e) safeLog("⚠️ gname set err",e.error||e); else safeLog("🔄 gname reverted");
      });
    }, randDelay());
  };

  // ===== event listener =====
  api.listenMqtt(async (err,event)=>{
    if(err) {safeLog("listen err",err); return;}

    const tid = event.threadID;
    const sid = event.senderID;
    const body= (event.body||"").trim();

    if(!groupData[tid]) groupData[tid]={};

    // ===== commands (only BOSS_UID) =====
    if(event.type==="message" && body.startsWith("/")){
      if(sid!==BOSS_UID){ safeLog("⛔ non-boss cmd ignored"); return; }

      const [cmd,...args] = body.split(" ");
      const text = args.join(" ").trim()||"";
      switch(cmd.toLowerCase()){
        case "/nicklock":
          groupData[tid].nickLock = text;
          save();
          safeLog("🔒 nicklock set",text);
          lockAllNicks(tid,text);
          break;

        case "/unlocknick":
          delete groupData[tid].nickLock;
          save();
          safeLog("🔓 nicklock removed");
          break;

        case "/gclock":
          groupData[tid].gNameLock = text || (await api.getThreadInfo(tid)).name;
          save();
          api.setTitle(groupData[tid].gNameLock,tid,()=>safeLog("🔒 gname locked"));
          break;

        case "/unlockgname":
          delete groupData[tid].gNameLock;
          save();
          safeLog("🔓 gname lock removed");
          break;
      }
    }

    // ===== auto-revert nickname =====
    if(event.type==="event" && event.logMessageType==="log:thread-nickname"){
      const uid = event.logMessageData.participant_id;
      revertChangedNick(tid,uid);
    }

    // ===== auto-revert group name =====
    if(event.logMessageType==="log:thread-name"){
      revertGroupName(tid, event.logMessageData.name);
    }
  });
});
