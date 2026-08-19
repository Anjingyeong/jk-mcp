export const WINDOWS_EXECUTOR_SUPERVISOR_JS = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const TOKEN_FILE = String(process.env.JK_EXECUTOR_TOKEN_FILE || "");
if (!TOKEN_FILE) throw new Error("JK supervisor configuration missing");
const BASE_DIR = path.dirname(TOKEN_FILE);
const WORKER_FILE = String(process.env.JK_EXECUTOR_WORKER_FILE || path.join(BASE_DIR, "executor-worker.js"));
const WORKER_LOCK = path.join(BASE_DIR, "executor-worker.lock");
const SUPERVISOR_LOCK = path.join(BASE_DIR, "executor-supervisor.lock");
const RESTART_REQUEST = path.join(BASE_DIR, "executor-restart.request");

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function processAlive(pid){
  if(!Number.isFinite(pid)||pid<=0) return false;
  try{
    return cp.execFileSync("tasklist",["/FI","PID eq "+pid,"/FO","CSV","/NH"],{encoding:"utf8",windowsHide:true}).includes(String(pid));
  }catch{return false;}
}
function discoverWorkerPids(){
  try{
    const script = '$target=[IO.Path]::GetFullPath($env:JK_EXECUTOR_WORKER_FILE); Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($target) } | Sort-Object CreationDate -Descending | ForEach-Object { $_.ProcessId }';
    const out=cp.execFileSync("powershell.exe",["-NoProfile","-Command",script],{encoding:"utf8",windowsHide:true,env:{...process.env,JK_EXECUTOR_WORKER_FILE:WORKER_FILE}});
    return [...new Set(out.split(/\r?\n/).map(value=>Number(value.trim())).filter(pid=>Number.isFinite(pid)&&pid>0&&processAlive(pid)))];
  }catch{return [];}
}
function claimSingleton(){
  for(let attempt=0;attempt<2;attempt++){
    try{
      const fd=fs.openSync(SUPERVISOR_LOCK,"wx");
      fs.writeFileSync(fd,String(process.pid),"utf8");
      fs.closeSync(fd);
      return;
    }catch(error){
      if(!error||error.code!=="EEXIST") throw error;
      let prior=0;
      try{ prior=Number(fs.readFileSync(SUPERVISOR_LOCK,"utf8").trim())||0; }catch{}
      if(prior!==process.pid&&processAlive(prior)){
        console.log("[JK supervisor] another instance is already running",prior);
        process.exit(0);
      }
      try{fs.unlinkSync(SUPERVISOR_LOCK);}catch{}
    }
  }
  throw new Error("JK supervisor singleton lock unavailable");
}
function lockedWorkerPid(){
  try{
    const pid=Number(fs.readFileSync(WORKER_LOCK,"utf8").trim())||0;
    return processAlive(pid)?pid:0;
  }catch{return 0;}
}
function adoptLegacyWorker(){
  if(lockedWorkerPid()) return {pid:lockedWorkerPid(),legacyCount:0};
  const pids=discoverWorkerPids();
  if(!pids.length) return {pid:0,legacyCount:0};
  const pid=pids[0];
  try{fs.writeFileSync(WORKER_LOCK,String(pid),"utf8");}catch{}
  console.log("[JK supervisor] temporarily adopted legacy worker",pid,"duplicates",Math.max(0,pids.length-1));
  return {pid,legacyCount:pids.length};
}
function startWorker(){
  if(!fs.existsSync(WORKER_FILE)) throw new Error("JK worker file missing: "+WORKER_FILE);
  const existing=lockedWorkerPid();
  if(existing){
    console.log("[JK supervisor] adopted existing worker",existing);
    return existing;
  }
  const child=cp.spawn(process.execPath,[WORKER_FILE],{env:process.env,stdio:"ignore",windowsHide:true,detached:false});
  child.unref();
  console.log("[JK supervisor] started worker",child.pid);
  return child.pid||0;
}
function terminateWorker(pid){
  if(!processAlive(pid)) return;
  try{cp.execFileSync("taskkill",["/PID",String(pid),"/T","/F"],{stdio:"ignore",windowsHide:true});}catch{}
}
function terminateAllWorkers(){
  for(const pid of discoverWorkerPids()) terminateWorker(pid);
  try{fs.unlinkSync(WORKER_LOCK);}catch{}
}
function readRestartRequest(){
  try{
    const parsed=JSON.parse(fs.readFileSync(RESTART_REQUEST,"utf8"));
    return parsed&&typeof parsed==="object"?parsed:null;
  }catch{return null;}
}
function consumeRestartRequest(){ try{fs.unlinkSync(RESTART_REQUEST);}catch{} }

claimSingleton();
process.on("exit",()=>{ try{ if(Number(fs.readFileSync(SUPERVISOR_LOCK,"utf8").trim())===process.pid) fs.unlinkSync(SUPERVISOR_LOCK); }catch{} });

const legacy=adoptLegacyWorker();
let managedPid=legacy.pid||startWorker();
let legacyMigrationAt=legacy.legacyCount>0?Date.now()+10000:0;
let restartBusy=false;
setInterval(async()=>{
  if(restartBusy) return;
  restartBusy=true;
  try{
    if(legacyMigrationAt&&Date.now()>=legacyMigrationAt){
      legacyMigrationAt=0;
      terminateAllWorkers();
      await sleep(1200);
      managedPid=startWorker();
      return;
    }
    const request=readRestartRequest();
    if(request){
      const notBefore=Number(request.notBefore)||0;
      if(notBefore>Date.now()) return;
      consumeRestartRequest();
      legacyMigrationAt=0;
      terminateAllWorkers();
      await sleep(1200);
      managedPid=startWorker();
      return;
    }
    const current=lockedWorkerPid();
    if(current){ managedPid=current; return; }
    if(managedPid&&processAlive(managedPid)) return;
    managedPid=startWorker();
  }catch(error){
    console.error("[JK supervisor]",error&&error.message||error);
  }finally{
    restartBusy=false;
  }
},1000);

console.log("[JK supervisor] active",process.pid,BASE_DIR);
`;
