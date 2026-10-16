'use strict';
// Real classic UI and temporary persistence; provider requests are intercepted.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'dw-prompt-composer-'));
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dw-prompt-evidence-')),delay=ms=>new Promise(r=>setTimeout(r,ms));
const groups=[],errors=[],blocked=[],posts=[];let server,browser,page,base,log='';
const pass=name=>{groups.push(name);console.log('PASS '+name)};
async function api(url,method='GET',body){if(method==='PUT'){const old=await api(url);body={...body,base_updated_at:old.canvas.updated_at}}const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json()}
async function main(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;
 try{
  server=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  let ready=false;for(let i=0;i<100;i++){try{await api('/api/studio/health');ready=true;break}catch{await delay(200)}}assert(ready,log);
  for(const [id,url]of [['offline','https://api.deepwhiteai.com/v1'],['native','https://composer.invalid/v1']])await api('/api/studio/settings/sync-models','POST',{id,name:'隔离 '+id,base_url:url,api_key:'offline-fixture',enabled:true,primary:id==='offline'});
  const project=(await api('/api/projects','POST',{name:'提示词层级隔离验收'})).project,c=(await api('/api/canvases','POST',{title:'生成节点 · 提示词与引用',kind:'classic',project:project.id})).canvas;
  const first='黎明的车站，暖色侧光。\n<b>保留为文字，不执行 HTML</b>',second='人物从画面左侧走入，镜头缓慢推进。';
  const fixture=[{id:'p1',type:'prompt',x:30,y:80,w:280,text:first,studioTitle:'场景描述'},{id:'p2',type:'prompt',x:30,y:480,w:280,text:second},
   {id:'ref',type:'image',x:30,y:880,w:280,h:220,name:'构图参考',url:'/fixture/reference.svg'},
   {id:'image',type:'generator',x:450,y:120,w:460,apiProvider:'offline',model:'deepwhiteai-image-g2',studioPrompt:'米白风衣，低饱和画面。'},
   {id:'video',type:'video',x:1000,y:120,w:500,apiProvider:'native',model:'seedance',duration:5,aspectRatio:'16:9',studioPrompt:'保持镜头平稳。'},
   {id:'own-image',type:'generator',x:1580,y:120,w:460,apiProvider:'native',model:'deepwhiteai-image-g2',studioPrompt:'自有渠道的独立手写内容。'}];
  for(const n of fixture.filter(n=>['generator','video'].includes(n.type)))n.inputs=['p2','p1','ref'];
  await api('/api/canvases/'+c.id,'PUT',{nodes:fixture,connections:['image','video','own-image'].flatMap(to=>['p1','p2','ref'].map(from=>({from,to}))),viewport:{x:0,y:0,scale:1}});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'data/local-path'});const context=await browser.newContext({viewport:{width:1500,height:900}});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==base){blocked.push(req.url());return route.abort()}
   if(u.pathname==='/fixture/reference.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#53635b"/><circle cx="140" cy="70" r="40" fill="#c8ab75"/></svg>'});
   if(req.method()==='POST'&&u.pathname==='/api/studio/generations'){posts.push(req.postDataJSON());return route.fulfill({status:422,json:{detail:'隔离测试已截获请求'}})}
   if(req.method()==='POST'&&/^\/api\/(?:canvas-|online-image|studio\/(?:mj|runninghub)|runninghub|midjourney)/.test(u.pathname)){blocked.push(u.pathname);return route.fulfill({status:503,json:{detail:'Unexpected generation blocked'}})}return route.continue()});
  await page.goto(base+'/static/canvas.html?id='+c.id);await page.waitForFunction(()=>window.StudioCanvasV2?.ready&&nodes.some(n=>n.id==='own-image'));await delay(200);
  const card=id=>page.locator(`.node[data-id="${id}"]`),prompts=id=>card(id).locator('.studio-upstream-item p').allTextContents();
  const show=async id=>{await page.evaluate(id=>{const n=nodes.find(n=>n.id===id);viewport={x:240-n.x,y:130-n.y,scale:1};selected.clear();selected.add(id);applyViewport();refreshSelectionVisuals()},id);await delay(120)};
  for(const id of ['image','video','own-image']){
   assert.equal(await card(id).locator('.studio-prompt-input').count(),1);assert.equal(await card(id).locator('.studio-final-prompt').count(),0);
   assert.equal(await card(id).locator('.prompt-list').count(),0,'no duplicate native prompt cards in '+id);assert.equal(await card(id).locator('.studio-upstream-preview').count(),1);
   assert.deepEqual(await prompts(id),[second,first]);assert.equal(await card(id).locator('.studio-upstream-preview b').count(),0);
   assert.equal(await card(id).locator('.studio-upstream-media').count(),0);assert.equal(await card(id).locator('.studio-reference-strip .studio-reference-thumb').count(),1);
   const labels=await card(id).locator('.studio-upstream-item strong').allTextContents();assert(labels.includes('场景描述'));assert(labels.every(s=>!first.includes(s)&&!second.includes(s)),'source labels must not repeat their body');
   pass(id+': single editor + raw references in input order; no legacy duplicate/final preview; media stays in thumbnail strip');
  }
  const generic=await page.evaluate(()=>{const el=document.createElement('div');renderPromptPreview(el,[{id:'other',label:'其他节点的引用',prompt:'有效引用',refs:[]}]);return el.textContent});assert(generic.includes('其他节点的引用'));pass('shared native preview remains available to other node types');
  await show('image');const input=card('image').locator('.studio-prompt-input');await input.fill('本节点独立改稿。');
  await input.evaluate(el=>{window.composerInput=el;el.setSelectionRange(3,3)});await page.keyboard.insertText('新');await page.evaluate(()=>refreshGeneratorInputViews());
  const focus=await input.evaluate(el=>({same:el===window.composerInput,focused:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd}));assert.deepEqual(focus,{same:true,focused:true,start:4,end:4});
  assert.equal(await card('video').locator('.studio-prompt-input').inputValue(),'保持镜头平稳。');assert.equal(await card('own-image').locator('.studio-prompt-input').inputValue(),'自有渠道的独立手写内容。');pass('typing and input refresh keep the native textarea, selection, focus and node isolation');
  const hand=await input.inputValue();await page.evaluate(()=>{nodes.find(n=>n.id==='p2').text='替换的上游文字';refreshGeneratorInputViews();refreshGeneratorInputViews()});assert.deepEqual(await prompts('image'),['替换的上游文字',first]);assert.equal(await input.inputValue(),hand);pass('upstream replacement and repeated refresh retain handwritten content');
  await page.evaluate(()=>{connections=connections.filter(link=>link.to!=='image');refreshGeneratorInputViews()});assert(!(await card('image').locator('.studio-upstream-preview').isVisible()));assert.equal(await input.inputValue(),hand);
  assert.equal(await page.evaluate(()=>generatorSources(nodes.find(n=>n.id==='image')).map(s=>s.prompt).filter(Boolean).join('\n\n')),hand);pass('disconnect hides references and preserves independent prompt');
  await input.fill('');await page.evaluate(()=>{connections.push({from:'p1',to:'image'},{from:'ref',to:'image'});refreshGeneratorInputViews()});assert.deepEqual(await prompts('image'),[first]);assert.equal(await input.inputValue(),'');
  assert.equal(await page.evaluate(()=>generatorSources(nodes.find(n=>n.id==='image')).map(s=>s.prompt).filter(Boolean).join('\n\n')),first);pass('upstream-only prompt remains usable without fabricated handwritten text');
  await page.evaluate(()=>{connections=connections.filter(c=>!(c.to==='image'&&c.from==='p1'));refreshGeneratorInputViews()});assert(!(await card('image').locator('.studio-upstream-preview').isVisible()));assert.equal(await card('image').locator('.studio-reference-strip .studio-reference-thumb').count(),1);pass('media-only references do not create an empty text section');
  await page.evaluate(()=>{connections.push({from:'p1',to:'image'},{from:'p2',to:'image'});const n=nodes.find(n=>n.id==='image');n.inputs=['p2','p1','ref'];n.studioPrompt='最终手写内容';n.studioCreative={style:{id:'fixture-style',name:'电影色彩',kind:'style',prefix:'STYLE PREFIX',prompt:'STYLE SUFFIX'}};render()});
  assert.deepEqual(await prompts('image'),['替换的上游文字',first]);const expected='STYLE PREFIX\n替换的上游文字\n\n'+first+'\n\n最终手写内容\nSTYLE SUFFIX';
  const repeat=await page.evaluate(()=>Array.from({length:3},()=>generatorSources(nodes.find(n=>n.id==='image')).map(s=>s.prompt).filter(Boolean).join('\n\n')));assert.deepEqual(repeat,[expected,expected,expected]);pass('style composition is applied once in requests and never misrepresented as raw upstream text');
  // Capture the actual generation button payload while edits arrive during the save barrier.
  await show('image');await page.evaluate(()=>{window.savedEnsure=StudioSave.ensureCurrent;StudioSave.ensureCurrent=async opts=>{await new Promise(r=>setTimeout(r,300));return savedEnsure(opts)}});
  await card('image').locator('.gen-btn').click();await card('image').locator('.studio-prompt-input').fill('提交之后继续编辑');await page.waitForFunction(()=>nodes.find(n=>n.id==='image').studioJobState==='failed');assert.equal(posts.length,1);assert.equal(posts[0].prompt,expected);assert.equal(posts[0].node_id,'image');assert.equal(posts[0].references.length,1);assert.equal(await input.inputValue(),'提交之后继续编辑');await page.evaluate(()=>StudioSave.ensureCurrent=savedEnsure);pass('real generation click freezes combined text and media before asynchronous save; later typing stays intact');
  await page.evaluate(async()=>await saveCanvas());await page.reload();await page.waitForFunction(()=>window.StudioCanvasV2?.ready&&nodes.some(n=>n.id==='image'));assert.equal(await input.inputValue(),'提交之后继续编辑');assert.deepEqual(await prompts('image'),['替换的上游文字',first]);assert.equal(await card('image').locator('.studio-creative-card').count(),1);assert.equal(await card('video').locator('.studio-prompt-input').inputValue(),'保持镜头平稳。');assert.equal(posts.length,1);pass('real save and reload preserve inputs, reference order, style module and node isolation without resubmission');
  // Long multi-source references use one native scroll area, never canvas zoom.
  await page.evaluate(()=>{nodes.find(n=>n.id==='p1').text=Array.from({length:20},(_,i)=>`场景细节 ${i+1}：保留全文，可滚动阅读。`).join('\n');refreshGeneratorInputViews()});
  for(const id of ['image','video']){
   await show(id);const list=card(id).locator('.studio-upstream-list');assert(await list.evaluate(el=>el.scrollHeight>el.clientHeight));const before=await page.evaluate(()=>({...viewport}));await list.hover();await page.mouse.wheel(0,180);await delay(140);assert(await list.evaluate(el=>el.scrollTop>0));assert.deepEqual(await page.evaluate(()=>({...viewport})),before);pass(id+': real mouse wheel scrolls long references without moving or zooming canvas');
   const pos=await list.evaluate(el=>{window.upstreamParagraph=el.querySelector('p');return el.scrollTop});await page.evaluate(()=>refreshGeneratorInputViews());assert.equal(await list.evaluate(el=>el.scrollTop),pos);assert(await list.evaluate(el=>el.querySelector('p')===window.upstreamParagraph));
   await list.evaluate(el=>el.scrollTop=0);await list.focus();await page.keyboard.press('PageDown');await delay(200);assert(await list.evaluate(el=>el.scrollTop>0));assert.deepEqual(await page.evaluate(()=>({...viewport})),before);
   await list.evaluate(el=>el.scrollTop=0);await list.locator('p').first().dblclick();assert(await page.evaluate(()=>String(getSelection()).length>0));assert(!(await card(id).locator('.studio-prompt-input').evaluate(el=>el===document.activeElement)));assert.deepEqual(await page.evaluate(()=>({...viewport})),before);pass(id+': keyboard scroll and actual text selection work; unchanged refresh preserves paragraph and scroll');
  }
  await page.evaluate(()=>{const select=document.getElementById('studioCanvasTheme');select.value='graphite';select.onchange()});
  for(const [width,height]of [[1280,800],[1500,900]]){
   await page.setViewportSize({width,height});await show('image');await page.getByRole('button',{name:'定位选中节点',exact:true}).click();await delay(280);
   const button=card('image').locator('.gen-btn'),b=await button.boundingBox();assert(b&&b.x>=0&&b.y>=0&&b.x+b.width<=width&&b.y+b.height<=height);
   assert(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}));
   await card('image').locator('.studio-upstream-list').evaluate(el=>el.scrollTop=0);await page.screenshot({path:path.join(artifacts,`graphite-fit-image-${width}.png`)});pass(`${width}x${height}: real focus-selected fits the expanded image editor and exposes unobstructed generation control`);
  }
  for(const [width,height]of [[1280,800],[1500,900]]){
   await page.setViewportSize({width,height});
   for(const theme of ['dark','light','milk','graphite']){
    await page.evaluate(theme=>{const select=document.getElementById('studioCanvasTheme');select.value=theme;select.onchange()},theme);
    for(const id of ['image','video']){
     await show(id);const metrics=await card(id).evaluate(root=>{const area=root.querySelector('.studio-upstream-preview'),list=area.querySelector('.studio-upstream-list'),input=root.querySelector('.studio-prompt-input'),r=root.getBoundingClientRect();
      const rgba=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map(v=>v/255)};
      const blend=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3]));
      const lum=rgb=>rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const contrast=el=>{const chain=[];for(let n=el;n;n=n.parentElement)chain.unshift(n);let bg=[1,1,1];for(const n of chain)bg=blend(rgba(getComputedStyle(n).backgroundColor),bg);const fg=blend(rgba(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      return {overflow:document.documentElement.scrollWidth>innerWidth,inside:[area,input].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+1}),scroll:list.clientHeight,contrast:[input,area.querySelector('p'),area.querySelector('strong'),area.querySelector('.studio-upstream-heading')].map(contrast),editable:area.querySelectorAll('input,textarea,[contenteditable="true"]').length}});
     assert.equal(metrics.overflow,false);assert(metrics.inside);assert(metrics.scroll>0&&metrics.scroll<=150);assert.equal(metrics.editable,0);assert(metrics.contrast.every(n=>n>=4.5),theme+' '+id+' contrast '+metrics.contrast.join(','));
     await page.screenshot({path:path.join(artifacts,`${theme}-${id}-${width}.png`)});
    }
    pass(`${theme} ${width}x${height}: image/video readonly hierarchy, bounded scroll, no overflow and text contrast >=4.5`);
   }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({passed:true,groups,posts,errors,blocked},null,2));console.log(groups.length+' prompt composer groups passed; '+artifacts);
 }catch(e){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'server.log'),log);console.error('Evidence: '+artifacts);throw e}
 finally{if(browser)await browser.close();if(server?.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('isolated server did not exit')),8000);server.once('close',()=>{clearTimeout(timer);resolve()});server.kill()});const target=path.resolve(runtime);assert.equal(path.dirname(target).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert(path.basename(target).startsWith('dw-prompt-composer-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
