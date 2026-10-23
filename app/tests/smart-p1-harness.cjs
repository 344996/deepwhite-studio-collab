/* Shared offline harness for the 2026-10-22 P1 regressions: real temporary storage, no upstream traffic. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path'));}
const root=path.resolve(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function python(){
 if(process.env.PYTHON_EXECUTABLE)return process.env.PYTHON_EXECUTABLE;
 for(const candidate of [path.join(root,'python/python.exe'),path.join(root,'../.venv/Scripts/python.exe'),path.join(root,'../.venv/bin/python')])if(fs.existsSync(candidate))return candidate;
 return 'python';
}
async function start(name,{server='tests/catalog-browser-server.py'}={}){
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-'+name+'-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;let log='',child;
 const api=async(url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,url+' '+r.status+' '+await r.clone().text());return r.json();};
 const launch=async()=>{
  child=spawn(python(),['-B',path.join(root,server)],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});
  child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await delay(200);}}assert(ready,log);
 };
 const kill=async()=>{const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;};
 // A real process restart on the same data directory and port.
 const restart=async()=>{await kill();await launch();};
 await launch();
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[],external=[];
 const openSmart=async(page,id)=>{
  await page.goto(base+'/static/smart-canvas.html?id='+encodeURIComponent(id));
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&window.StudioSave);await delay(400);
 };
 const newPage=async()=>{
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base){external.push(url.origin);return route.abort();}return route.fallback();});
  return page;
 };
 // Smart canvases are created through the same API the home page uses, then filled by a normal save.
 const smartCanvas=async(title,nodes,connections=[])=>{
  const created=(await api('/api/canvases','POST',{title,kind:'smart'})).canvas;
  return (await api('/api/canvases/'+created.id,'PUT',{title,icon:'sparkles',nodes,connections,viewport:{x:0,y:0,scale:1},logs:[],settings:{},base_updated_at:created.updated_at||0,client_id:'fixture'})).canvas;
 };
 const stop=async()=>{try{await browser.close();}catch{}await kill().catch(()=>{});fs.rmSync(runtime,{recursive:true,force:true});};
 return {base,api,browser,newPage,openSmart,smartCanvas,errors,external,stop,restart,runtime,log:()=>log};
}
module.exports={start,delay,assert};
