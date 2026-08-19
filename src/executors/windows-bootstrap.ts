export const WINDOWS_EXECUTOR_BOOTSTRAP_JS = String.raw`"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const HUB = String(process.env.JK_HUB_URL || "").replace(/\/mcp\/?$/i, "").replace(/\/$/, "");
const EXECUTOR_ID = String(process.env.JK_EXECUTOR_ID || "windows-main");
const WORKSPACE = path.resolve(String(process.env.JK_EXECUTOR_WORKSPACE || process.cwd()));
const TOKEN_FILE = String(process.env.JK_EXECUTOR_TOKEN_FILE || "");
if (!HUB || !TOKEN_FILE) throw new Error("JK worker configuration missing");
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (!TOKEN) throw new Error("JK executor token is empty");

const LOCK_FILE = path.join(path.dirname(TOKEN_FILE), "executor-worker.lock");
function processAlive(pid){ try{ return cp.execFileSync("tasklist",["/FI","PID eq "+pid,"/FO","CSV","/NH"],{encoding:"utf8",windowsHide:true}).includes(String(pid)); }catch{ return false; } }
function claimSingleton(){
  for(let attempt=0;attempt<2;attempt++){
    try{ const fd=fs.openSync(LOCK_FILE,"wx"); fs.writeFileSync(fd,String(process.pid),"utf8"); fs.closeSync(fd); return; }
    catch(error){
      if(!error || error.code!=="EEXIST") throw error;
      let prior=0; try{prior=Number(fs.readFileSync(LOCK_FILE,"utf8").trim())||0}catch{}
      if(prior>0 && prior!==process.pid && processAlive(prior)){ console.log("[JK worker] another instance is already running",prior); process.exit(0); }
      try{fs.unlinkSync(LOCK_FILE)}catch{}
    }
  }
  throw new Error("JK executor singleton lock unavailable");
}
claimSingleton();
process.on("exit",()=>{ try{ if(Number(fs.readFileSync(LOCK_FILE,"utf8").trim())===process.pid) fs.unlinkSync(LOCK_FILE); }catch{} });

const CAPABILITIES = ["project_status","project_rules","repo_status","repo_diff_summary","code_search","file_read_slice","local_shell_run","executor_restart"];
const SKIP_DIRS = new Set([".git","node_modules",".gradle",".idea","build","dist","out","coverage","venv",".venv","__pycache__"]);
const MARKERS = ["package.json","settings.gradle","settings.gradle.kts","build.gradle","build.gradle.kts","gradlew","pubspec.yaml","pom.xml","pyproject.toml"];
const TEXT_EXTS = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".java",".kt",".kts",".xml",".json",".html",".css",".scss",".md",".txt",".yml",".yaml",".toml",".properties",".gradle",".py",".sh",".ps1",".bat",".cmd"]);

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function sha256(value){ return crypto.createHash("sha256").update(value).digest("hex"); }
function inside(root,target){ const rel=path.relative(root,target); return rel==="" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function safePath(root, rel){ const abs=path.resolve(root, String(rel||".")); if(!inside(root,abs)) throw new Error("Path escapes project root"); return abs; }
function git(root,args){ try { return cp.execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"],windowsHide:true,maxBuffer:4*1024*1024}).trim(); } catch { return ""; } }
function packageHints(dir){ const out=[]; if(fs.existsSync(path.join(dir,"package.json"))) out.push("node"); if(fs.existsSync(path.join(dir,"settings.gradle"))||fs.existsSync(path.join(dir,"settings.gradle.kts"))||fs.existsSync(path.join(dir,"build.gradle"))||fs.existsSync(path.join(dir,"build.gradle.kts"))) out.push("gradle"); if(fs.existsSync(path.join(dir,"pubspec.yaml"))) out.push("flutter"); if(fs.existsSync(path.join(dir,"pom.xml"))) out.push("maven"); if(fs.existsSync(path.join(dir,"pyproject.toml"))) out.push("python"); return out; }
function packageProjectName(dir){ try{ const parsed=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8")); return typeof parsed.name==="string"?parsed.name.trim():""; }catch{return "";} }
function projectSlug(name){ return String(name||"").toLowerCase().replace(/[^a-z0-9_.-]+/g,"-").replace(/^-+|-+$/g,""); }
function gitStatus(root){
  const branch = git(root,["rev-parse","--abbrev-ref","HEAD"]);
  const raw = git(root,["status","--porcelain=v1"]);
  const dirtyFiles=[]; const staged=[];
  for(const line of raw.split(/\r?\n/)){ if(!line) continue; const x=line[0], y=line[1], file=line.slice(3).replace(/^.* -> /,""); if(x && x!==" " && x!=="?") staged.push(file); if(y && y!==" " || x==="?") dirtyFiles.push(file); }
  return {branch:branch==="HEAD"?"":branch,dirtyFiles:[...new Set(dirtyFiles)],staged:[...new Set(staged)]};
}
function projectSnapshot(dir,id){ const st=gitStatus(dir); const name=path.basename(dir); const packageName=packageProjectName(dir); const aliases=[id,name]; if(packageName) aliases.push(packageName,projectSlug(packageName)); return {projectId:id,name,root:dir,aliases:[...new Set(aliases)],branch:st.branch||undefined,dirty:st.dirtyFiles.length>0||st.staged.length>0,hasAgentsMd:fs.existsSync(path.join(dir,"AGENTS.md")),hasCodeBrain:false,packageHints:packageHints(dir),lastSeenAt:new Date().toISOString()}; }
async function scanWorkspace(){
  const found=[]; const ids=new Map(); const queue=[{dir:WORKSPACE,depth:0}];
  while(queue.length){ const {dir,depth}=queue.shift(); let names=[]; try{ names=await fsp.readdir(dir,{withFileTypes:true}); }catch{ continue; }
    const marker = names.some(e=>e.name===".git") || MARKERS.some(m=>names.some(e=>e.name===m));
    if(marker){ let base=projectSlug(path.basename(dir))||"project"; const n=(ids.get(base)||0)+1; ids.set(base,n); const id=n===1?base:base+"-"+n; found.push(projectSnapshot(dir,id)); if(depth>0) continue; }
    if(depth>=6) continue;
    for(const ent of names){ if(!ent.isDirectory()||SKIP_DIRS.has(ent.name)) continue; if(ent.name.startsWith(".")&&ent.name!==".config") continue; queue.push({dir:path.join(dir,ent.name),depth:depth+1}); }
  }
  return found;
}
async function requestJson(url, body, timeoutMs=25000){ const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),Math.max(1000,Number(timeoutMs)||25000)); try{ const r=await fetch(url,{method:"POST",headers:{authorization:"Bearer "+TOKEN,"content-type":"application/json"},body:JSON.stringify(body),signal:controller.signal}); const text=await r.text(); let data=null; try{data=text?JSON.parse(text):null}catch{data=text} if(!r.ok) throw new Error("JK hub "+r.status+": "+(data&&data.error||text)); return data; } finally { clearTimeout(timer); } }
async function heartbeat(registry){ return requestJson(HUB+"/api/executors/heartbeat",{executorId:EXECUTOR_ID,label:"Windows PC",platform:process.platform+"/"+process.arch+" · "+os.hostname(),workspaceRoot:WORKSPACE,projects:registry,capabilities:CAPABILITIES},5000); }
function resolveProject(registry,payload){ const id=String(payload.sourceProjectId||payload.projectId||""); const p=registry.find(x=>x.projectId===id||x.aliases.includes(id)); if(!p) throw new Error("Worker project not found: "+id); return p; }
function ruleResult(root, rel){ const target=safePath(root,rel||"."); const stat=fs.existsSync(target)?fs.statSync(target):null; let dir=stat&&stat.isDirectory()?target:path.dirname(target); const dirs=[]; while(inside(root,dir)){ dirs.unshift(dir); if(path.resolve(dir)===path.resolve(root)) break; const parent=path.dirname(dir); if(parent===dir) break; dir=parent; } const rules=[]; for(const d of dirs){ for(const name of (d===root?[".codex/config.toml","AGENTS.md","CLAUDE.md"]:["AGENTS.md","CLAUDE.md"])){ const f=path.join(d,name); if(!fs.existsSync(f)) continue; let raw=""; try{raw=fs.readFileSync(f,"utf8")}catch{} rules.push({file:path.relative(root,f).replace(/\\/g,"/")||name,summary:raw.split(/\r?\n/).slice(0,20).join("\n").slice(0,2000)}); } } return {scopePath:path.relative(root,target).replace(/\\/g,"/")||".",hierarchical:Boolean(rel),rules}; }
function repoStatus(root){ const st=gitStatus(root); const remoteRaw=git(root,["remote","-v"]); const remotes=[...new Set(remoteRaw.split(/\r?\n/).filter(Boolean).map(l=>l.split(/\s+/)[0]))]; const upstream=git(root,["rev-parse","--abbrev-ref","--symbolic-full-name","@{u}"]); let ahead=0,behind=0; if(upstream){ const c=git(root,["rev-list","--left-right","--count","HEAD...@{u}"]).split(/\s+/).map(Number); ahead=c[0]||0; behind=c[1]||0; } const syncState=!upstream?"no-upstream":ahead&&behind?"diverged":ahead?"ahead":behind?"behind":"synced"; return {...st,remotes,upstream:upstream||null,ahead,behind,syncState}; }
function repoDiff(root){ const raw=git(root,["diff","--numstat"]); const files=[]; let add=0,del=0; for(const line of raw.split(/\r?\n/)){ if(!line) continue; const [a,d,...rest]=line.split("\t"); const p=rest.join("\t"); const av=Number(a)||0,dv=Number(d)||0; add+=av; del+=dv; files.push({path:p,"+":av,"-":dv}); } return {files,summary:files.length+" file(s) changed, +"+add+"/-"+del}; }
function nestedRoots(registry,parent){ return registry.map(x=>path.resolve(x.root)).filter(candidate=>{ const rel=path.relative(parent.root,candidate); return rel&&rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel); }).sort((a,b)=>a.length-b.length).filter((candidate,index,all)=>!all.slice(0,index).some(existing=>inside(existing,candidate))); }
async function walkFiles(root, max=5000, excluded=[]){ const out=[]; const q=[root]; while(q.length&&out.length<max){ const d=q.shift(); let es=[]; try{es=await fsp.readdir(d,{withFileTypes:true})}catch{continue} for(const e of es){ if(e.isDirectory()){ const next=path.join(d,e.name); if(!SKIP_DIRS.has(e.name)&&!excluded.some(x=>path.resolve(x)===path.resolve(next))) q.push(next); } else { const ext=path.extname(e.name).toLowerCase(); if(TEXT_EXTS.has(ext)||!ext) out.push(path.join(d,e.name)); } } } return out; }
async function codeSearch(root, query, maxResults, excluded=[]){ const limit=Math.max(1,Math.min(Number(maxResults)||50,200)); const matches=[]; const excludeGlobs=excluded.map(x=>path.relative(root,x).replace(/\\/g,"/")).filter(Boolean).flatMap(rel=>["--glob","!**/"+rel+"/**"]); try{ const out=cp.execFileSync("rg",["-n","--no-heading","--color","never","--fixed-strings","--glob","!node_modules/**","--glob","!.git/**","--glob","!build/**","--glob","!dist/**",...excludeGlobs,String(query),root],{encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024}); for(const line of out.split(/\r?\n/)){ if(!line) continue; const m=/^(.*?):(\d+):(.*)$/.exec(line); if(!m) continue; matches.push({path:path.relative(root,m[1]).replace(/\\/g,"/"),line:Number(m[2]),snippet:m[3].slice(0,1000)}); if(matches.length>=limit) break; } return {matches,backend:"ripgrep"}; }catch{}
  const files=await walkFiles(root,5000,excluded); const needle=String(query).toLowerCase(); for(const f of files){ let text=""; try{text=await fsp.readFile(f,"utf8")}catch{continue} const lines=text.split(/\r?\n/); for(let i=0;i<lines.length;i++){ if(lines[i].toLowerCase().includes(needle)){ matches.push({path:path.relative(root,f).replace(/\\/g,"/"),line:i+1,snippet:lines[i].slice(0,1000)}); if(matches.length>=limit) return {matches,backend:"node-fallback"}; } } } return {matches,backend:"node-fallback"}; }
function readSlice(root, rel, start, end){ const abs=safePath(root,rel); const buf=fs.readFileSync(abs); const text=buf.toString("utf8"); const eol=text.includes("\r\n")?"crlf":"lf"; const lines=text.split(/\r?\n/); const s=Math.max(1,Number(start)||1); const e=Math.min(lines.length,Number(end)||Math.min(lines.length,s+199)); const chosen=lines.slice(s-1,e); const wholeHash=sha256(buf); return {path:String(rel).replace(/\\/g,"/"),start:s,end:e,content:chosen.join(eol==="crlf"?"\r\n":"\n"),lineHashes:chosen.map(x=>sha256(x)),fileHash:wholeHash,workContextFileHash:wholeHash,eol}; }
async function shellRun(root,payload){ const cwd=safePath(root,payload.cwd||"."); const timeout=Math.max(1000,Math.min((Number(payload.timeoutSec)||120)*1000,900000)); return await new Promise(resolve=>{ cp.exec(String(payload.command||""),{cwd,windowsHide:true,timeout,maxBuffer:8*1024*1024,shell:true},(error,stdout,stderr)=>resolve({cwd:path.relative(root,cwd).replace(/\\/g,"/")||".",exitCode:error&&typeof error.code==="number"?error.code:(error?1:0),stdoutSummary:String(stdout||"").slice(-200000),stderrSummary:String(stderr||"").slice(-200000),durationMs:0,outputTruncated:String(stdout||"").length>200000||String(stderr||"").length>200000})); }); }
function requestRestart(payload){ const requestFile=path.join(path.dirname(TOKEN_FILE),"executor-restart.request"); const now=Date.now(); fs.writeFileSync(requestFile,JSON.stringify({requestedAt:now,notBefore:now+3000,reason:String(payload&&payload.reason||"JK requested worker restart").slice(0,240)})+"\n","utf8"); return {scheduled:true,notBefore:now+3000,requestFile:path.basename(requestFile)}; }
async function execute(registry,job){ const payload=job.payload||{}; if(job.tool==="executor_restart") return requestRestart(payload); const p=resolveProject(registry,payload); switch(job.tool){ case "project_status":{ const st=gitStatus(p.root); return {...st,packageHints:p.packageHints||[],ruleFiles:["AGENTS.md","CLAUDE.md",".codex/config.toml"].filter(f=>fs.existsSync(path.join(p.root,f))),knownCommands:[],hasCodeBrain:false}; } case "project_rules": return ruleResult(p.root,payload.path); case "repo_status": return repoStatus(p.root); case "repo_diff_summary": return repoDiff(p.root); case "code_search": return codeSearch(p.root,payload.query,payload.maxResults,nestedRoots(registry,p)); case "file_read_slice": return readSlice(p.root,payload.path,payload.start??(Number(payload.offset)>=0?Number(payload.offset)+1:undefined),payload.end); case "local_shell_run": return shellRun(p.root,payload); default: throw new Error("Unsupported bootstrap worker tool: "+job.tool); } }
async function complete(job,result,error){ return requestJson(HUB+"/api/executors/"+encodeURIComponent(EXECUTOR_ID)+"/jobs/"+encodeURIComponent(job.jobId)+"/result",error?{error:String(error&&error.message||error)}:{result}); }
async function main(){ let registry=[]; let lastScan=0,lastBeat=0; let beatBusy=false; console.log("[JK worker] starting",EXECUTOR_ID,WORKSPACE,HUB); const beatTimer=setInterval(async()=>{ if(beatBusy||registry.length===0) return; beatBusy=true; try{await heartbeat(registry);lastBeat=Date.now();}catch(e){console.error("[JK worker heartbeat]",e&&e.message||e);}finally{beatBusy=false;} },8000); beatTimer.unref(); for(;;){ const now=Date.now(); try{ if(now-lastScan>15000||registry.length===0){registry=await scanWorkspace();lastScan=now;} if(now-lastBeat>10000&&!beatBusy){beatBusy=true;try{await heartbeat(registry);lastBeat=Date.now();}finally{beatBusy=false;}} const polled=await requestJson(HUB+"/api/executors/"+encodeURIComponent(EXECUTOR_ID)+"/poll",{waitMs:20000}); if(polled&&polled.job){ try{ const result=await execute(registry,polled.job); await complete(polled.job,result,null); }catch(e){ await complete(polled.job,null,e); } } }catch(e){ console.error("[JK worker]",e&&e.message||e); await sleep(3000); } } }
main().catch(e=>{console.error(e);process.exitCode=1;});
`;
