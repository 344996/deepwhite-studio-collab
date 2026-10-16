'use strict';
// Compare the pinned runtime compiler with the generated CSS on real canvas DOM.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {collect,verify,output}=require('../tools/build-canvas-utilities.cjs');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path'));}
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-utilities-')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const scriptPattern=/<script\b[^>]*src="[^"\n]*tailwindcss-cdn\.js[^"\n]*"[^>]*><\/script>/g;
const linkPattern=/<link\b[^>]*href="[^"\n]*canvas-utilities\.css[^"\n]*"[^>]*>/g;
function markup(html,mode){const stripped=html.replace(scriptPattern,'').replace(linkPattern,'');return mode==='runtime'?stripped.replace(/(<script\b[^>]*src="[^"\n]*vendor\/js\/lucide\.js)/,'<script src="/static/vendor/js/tailwindcss-cdn.js"></script>\n$1'):stripped.replace('</head>','<link rel="stylesheet" href="/static/canvas-utilities.css">\n</head>');}
async function main(){
 const data=await collect();verify(data);let browser,server,log='',groups=0;const errors=[],paid=[],external=[];
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const base='http://127.0.0.1:'+port;
 const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();};
 const pass=label=>{groups++;console.log('PASS: '+label);};
 try{
  server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:String(port),DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break;}catch{await sleep(200);}}assert(ready,log);
  await api('/api/studio/settings/sync-models','POST',{id:'deepwhite',name:'Offline CSS fixture',base_url:'https://api.deepwhiteai.com/v1',api_key:'mock-utilities-only',enabled:true,primary:true});
  const frozen=new Map();for(const directory of ['','js','css'])for(const name of fs.readdirSync(path.join(root,'static',directory)))if(/\.(?:js|css|html)$/.test(name))frozen.set('/static/'+(directory?directory+'/':'')+name,fs.readFileSync(path.join(root,'static',directory,name)));
  const html=frozen.get('/static/canvas.html').toString();assert(!html.includes('tailwindcss-cdn.js'),'Production must serve compiled CSS');assert(html.includes('canvas-utilities.css'));assert.equal((html.match(/lucide\.js/g)||[]).length,1);browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const theme of ['graphite','light'])for(const width of [1280,1500]){
   const values={};
   for(const mode of ['runtime','compiled']){
    const c=(await api('/api/canvases','POST',{title:'CSS equivalence',kind:'classic'})).canvas;
    const context=await browser.newContext({viewport:{width,height:width===1280?800:900},reducedMotion:'reduce'});await context.addInitScript(theme=>{localStorage.setItem('studio_theme',theme);localStorage.setItem('canvas_theme',theme);},theme);
    const requests=[];await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());requests.push(u.pathname);if(u.origin!==base){external.push(u.origin);return route.abort();}
     if(req.method()==='POST'&&/\/api\/(?:studio\/(?:generations|mj\/submit|runninghub\/tasks)|canvas-(?:image|comfy|video|llm)-tasks|online-image|runninghub\/create|jimeng\/generate)/.test(u.pathname)){paid.push(u.pathname);return route.fulfill({status:503,json:{detail:'generation blocked'}});}
     if(u.pathname==='/static/canvas.html')return route.fulfill({contentType:'text/html',body:markup(html,mode)});
     if(frozen.has(u.pathname))return route.fulfill({contentType:u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.html')?'text/html':'application/javascript',body:frozen.get(u.pathname)});
     return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/static/canvas.html?id='+c.id);await page.waitForFunction(()=>window.StudioCanvasV2?.ready&&canvas?.id&&StudioStageOne.getProviders().length&&Object.keys(StudioStageOne.getCapabilities()||{}).length);await sleep(300);
    await page.evaluate(()=>{
     nodes=[];connections=[];canvas.nodes=nodes;canvas.connections=connections;viewport={x:0,y:0,scale:1};selected.clear();
     const types=['image','prompt','generator','video','llm','output'];
     types.forEach((type,i)=>nodes.push({id:'css-'+type,type,x:100+(i%3)*500,y:100+Math.floor(i/3)*650,w:420,apiProvider:'deepwhite',llmProvider:'deepwhite',model:type==='llm'?'gpt-4.1-mini':'deepwhiteai-image-g-v2.5-lowprice',studioPrompt:'静态样式验证提示词',text:'可编辑文本与参数',images:[],url:type==='image'?'/static/studio-mark.svg':''}));
     connections=[{from:'css-prompt',to:'css-generator'}];canvas.connections=connections;render();stopCanvasRemotePolling?.();
    });await sleep(350);await page.waitForFunction(()=>[...document.images].filter(i=>i.src.includes('studio-mark.svg')).every(i=>i.complete));
    const sample=async()=>page.evaluate(()=>{
     const properties=['display','position','boxSizing','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','borderTopWidth','borderTopColor','borderRadius','paddingTop','paddingLeft','marginTop','opacity','objectFit','outlineStyle','minWidth','maxWidth','gap','visibility','width','height'];
     return [...document.querySelectorAll('#nodes .node,#nodes .node *,#studioV2Add,#studioV2Zoom,#createMenu,#createMenu *')].filter(e=>!e.closest('.studio-regular-price,.studio-job-state')&&!['PATH','path','use','circle','line','rect'].includes(e.tagName)).map(e=>{const s=getComputedStyle(e);return {tag:e.tagName,node:e.closest('.node[data-id]')?.dataset.id||'',classes:e.getAttribute('class'),styles:Object.fromEntries(properties.map(k=>[k,s[k]]))};});
    });
    await page.waitForFunction(()=>{const prices=[...document.querySelectorAll('#nodes .studio-price')];return prices.length>=3&&prices.every(e=>!e.textContent.includes('正在读取'));});await sleep(220);const first=await sample();await page.evaluate(()=>{selected.add('css-image');refreshSelectionVisuals();openCreateMenu(800,200);});await sleep(100);const selected=await sample();
    await page.evaluate(()=>{closeCreateMenu();openCanvasLog();});await sleep(100);const log=await page.locator('.log-panel').evaluate(e=>{const s=getComputedStyle(e);return {display:s.display,color:s.color,background:s.backgroundColor,font:s.fontFamily,padding:s.padding};});
    values[mode]={first,selected,log};assert.equal(await page.evaluate(()=>Boolean(window.tailwind)),mode==='runtime');assert.equal(requests.some(p=>p.includes('tailwindcss-cdn.js')),mode==='runtime');
    // Late utility controls and native input focus must work without a compiler.
    await page.evaluate(()=>{closeCanvasLog();const n=nodes.find(n=>n.id==='css-prompt');selected.clear();selected.add(n.id);render();});
    await page.locator('[data-id="css-prompt"] textarea').fill('静态样式下继续输入');assert.equal(await page.evaluate(()=>nodes.find(n=>n.id==='css-prompt').text),'静态样式下继续输入');
    assert((await page.evaluate(()=>saveCanvas())).ok);assert.equal((await api('/api/canvases/'+c.id)).canvas.nodes.find(n=>n.id==='css-prompt').text,'静态样式下继续输入');
    await context.close();
   }
   if(JSON.stringify(values.compiled)!==JSON.stringify(values.runtime)){const diffs=[];for(const phase of ['first','selected'])for(let i=0;i<values.compiled[phase].length;i++){const a=values.compiled[phase][i],b=values.runtime[phase][i];if(JSON.stringify(a)!==JSON.stringify(b))diffs.push({phase,index:i,node:a.node,classes:a.classes,changes:Object.keys(a.styles).filter(k=>a.styles[k]!==b?.styles[k]).map(k=>[k,b?.styles[k],a.styles[k]])});}console.log(JSON.stringify({styleDiffs:diffs.slice(0,12)}));}assert.deepEqual(values.compiled,values.runtime,'runtime/compiled styles differ: '+theme+'/'+width);pass(theme+'/'+width+': node, selected, menu, log, input and saved output preserve runtime styling');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(paid,[]);assert.deepEqual(external,[]);pass('compiled pages have no runtime compiler or external/generation requests');console.log(JSON.stringify({groups,inputs:data.source.inputs.length,cssBytes:fs.statSync(output).size}));
 }finally{if(browser)await browser.close();if(server){const ended=new Promise(r=>server.once('exit',r));server.kill();await Promise.race([ended,sleep(5000)]);}const target=path.resolve(runtime);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert(path.basename(target).startsWith('dw-utilities-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
