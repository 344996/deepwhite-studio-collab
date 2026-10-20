'use strict';
// Actual canvas engines in a disposable runtime. Media and task responses are
// synthetic; both browser and Python fixture reject external/paid requests.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-history-ui-'));
const evidence = path.join(root, 'test-output/history-refinement');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], external = [], paid = [], lazyRequests = [];
let server, browser, page, base, serverLog = '', records = [], mode = 'records';
fs.mkdirSync(evidence, {recursive:true});
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  assert(response.ok, await response.clone().text()); return response.json();
}
async function check(name, action) {await action(); checks.push(name); console.log('PASS ' + name);}
const moon = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#24393d"/><circle cx="690" cy="135" r="63" fill="#f2dfb5"/><path d="M0 520 270 170 620 600H0" fill="#9aab95"/><path d="m300 600 320-360 280 360" fill="#617f76"/><path d="m0 530 240-200 270 270H0" fill="#405c56"/><path d="m600 600 150-190 150 190" fill="#354d49"/></svg>';
const portrait = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="640"><rect width="400" height="640" fill="#dbcab3"/><path d="M60 640V260a140 140 0 0 1 280 0v380" fill="#8b7363"/><path d="M94 640V260a106 106 0 0 1 212 0v380" fill="#e8dcc9"/><circle cx="205" cy="308" r="58" fill="#b68562"/><path d="M94 640v-66a106 106 0 0 1 212 0v66" fill="#594f49"/><path d="M0 560h400v80H0" fill="#998472"/></svg>';
const svg = source => 'data:image/svg+xml,' + encodeURIComponent(source);
const longPrompt = '清晨的山谷与薄雾，柔和的自然光，保留前景树木的纹理。'.repeat(35) + '\n完整提示词结尾 <script>window.historyXss=1</script>';
function job(id, kind, status, fields = {}) {
  return {id, status, created_at:Date.now()/1000 - records.length * 60, resolved_model:kind === 'chat' ? '文本创作' : '全能图片 G2',
    request:{provider_id:'offline',node_id:'history-only',kind,model:'deepwhiteai-image-g2',prompt:'月光下的山谷，层叠的青绿色山峦与宁静的湖面',params:{ratio:'3:2'},references:[],count:1},
    task_ids:['task-' + id], outputs:[], children:[], text:'', ...fields};
}
async function openClassic() {
  await page.locator('.studio-history-button').click();
  await page.locator('.studio-history-view .studio-history-card,.studio-history-view .studio-history-empty').first().waitFor();
}
async function waitCards(count) {await page.waitForFunction(n => document.querySelectorAll('.studio-history-view .studio-history-card').length === n, count);}
async function closeHistory() {await page.getByRole('button', {name:'关闭生成记录', exact:true}).click();}
async function layout(panel, name) {
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({width, height:1000});
    const actual = await panel.evaluate(el => {
      const list = el.querySelector('.studio-history-body'), outer = el.getBoundingClientRect();
      const cards = [...list.querySelectorAll('.studio-history-card:not([hidden])')].map(item => item.getBoundingClientRect());
      return {outer:[outer.left,outer.right,outer.top,outer.bottom], width:innerWidth,
        overflow:list.scrollWidth-list.clientWidth, height:list.clientHeight,
        overlap:cards.some((a,i)=>cards.some((b,j)=>j<i&&a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)),
        font:parseFloat(getComputedStyle(el.querySelector('.studio-history-prompt')).fontSize)};
    });
    assert(actual.outer[0]>=-1&&actual.outer[1]<=width+1&&actual.outer[2]>=-1&&actual.outer[3]<=1001, name+' dialog inside viewport '+width);
    if(width===320)assert(actual.outer[1]-actual.outer[0]>=280,name+' mobile overlay does not squeeze the content with desktop padding');
    assert(actual.overflow<=1,name+' no horizontal list overflow '+width);
    assert(actual.height>=220,name+' remaining scroll area '+width);
    assert(!actual.overlap,name+' cards do not overlap '+width);
    assert(actual.font>=14,name+' readable prompt font');
    await panel.locator('.studio-history-card').last().locator('.studio-history-card-actions button').last().scrollIntoViewIfNeeded();
    const last=await panel.locator('.studio-history-card').last().locator('.studio-history-card-actions button').last().boundingBox();
    const foot=await panel.locator('.studio-history-foot').boundingBox();
    assert(last.y+last.height<=foot.y+1,name+' final actions reachable '+width);
    await panel.locator('.studio-history-body').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:path.join(evidence,`${name}-${width}.png`)});
  }
}
(async () => {
  const port = await new Promise(resolve => {const socket=net.createServer().listen(0,'127.0.0.1',()=>{const p=socket.address().port;socket.close(()=>resolve(p));});});
  base='http://127.0.0.1:'+port;
  server=spawn(process.env.PYTHON_EXECUTABLE||'python',['-B','tests/catalog-browser-server.py'],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,DEEPWHITE_STUDIO_PORT:String(port),PYTHONUTF8:'1'}});
  server.stdout.on('data',chunk=>serverLog+=chunk);server.stderr.on('data',chunk=>serverLog+=chunk);
  for(let n=0;n<140;n++){try{await api('/api/studio/health');break;}catch{await pause(150);}}
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  // 1-second, 480x320 VP8 geometric sample generated with FFmpeg, no API media.
  const video=fs.readFileSync(path.join(__dirname,'fixtures/history-preview.webm'));
  const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.protocol==='data:'||url.protocol==='blob:')return route.continue();
    if(url.origin!==base){external.push(url.origin);return route.abort();}
    if(url.pathname==='/api/media-preview'&&url.searchParams.get('url')?.startsWith('/output/history-lazy-')){
      lazyRequests.push(url.pathname+url.search);return route.fulfill({contentType:'image/svg+xml',body:moon});
    }
    if(url.pathname.startsWith('/output/history-lazy-')){
      lazyRequests.push(url.pathname);return route.fulfill({contentType:'image/svg+xml',body:moon});
    }
    const mediaPath=url.pathname==='/api/download-output'&&url.searchParams.get('url')?.startsWith(base+'/fixture/')?new URL(url.searchParams.get('url')).pathname:url.pathname;
    if(mediaPath==='/fixture/scene.webm')return route.fulfill({contentType:'video/webm',body:video});
    if(mediaPath==='/fixture/quiet.wav')return route.fulfill({contentType:'audio/wav',body:wav});
    if(mediaPath==='/fixture/missing.jpg')return route.fulfill({status:404,body:'synthetic missing media'});
    if(url.pathname==='/api/studio/generations'&&request.method()==='GET'){
      const localMode=mode,items=JSON.parse(JSON.stringify(records));
      if(localMode==='slow')await pause(700);
      if(localMode==='fail')return route.fulfill({status:503,json:{detail:'测试读取失败，请重试'}});
      return route.fulfill({json:{items}});
    }
    if(request.method()==='POST'&&/\/api\/(?:studio\/generations|generate|canvas-(?:image|comfy|video|llm)|studio\/mj\/submit)/.test(url.pathname)){
      paid.push(url.pathname);return route.fulfill({status:503,json:{detail:'Generation disabled in UI test'}});
    }
    return route.continue();
  });
  const classic=(await api('/api/canvases','POST',{kind:'classic',title:'生成记录界面 · 独立测试'})).canvas;
  await page.goto(base+'/static/canvas.html?id='+classic.id);
  await page.waitForFunction(()=>window.StudioNodeComposer?.ready&&canvas?.id);
  await check('empty history explains where records come from',async()=>{
    await openClassic();await page.getByText('第一份作品，从画布开始',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-history-count]').textContent(),'0 条记录');
    await page.screenshot({path:path.join(evidence,'empty.png')});await closeHistory();
  });
  records=[
    job('landscape','image','succeeded',{outputs:[{url:svg(moon),kind:'image',name:'test-landscape.svg'},{url:svg(portrait),kind:'image',name:'test-portrait.svg'}],children:[{usage:{amount:.142,currency:'CNY'}}]}),
    job('film','video','succeeded',{resolved_model:'视频创作',outputs:[{url:base+'/fixture/scene.webm',kind:'video',name:'test-scene.webm'}]}),
    job('writing','chat','succeeded',{text:'镜头一 · 远景\n山雾在清晨的光线中缓慢散开。\n\n镜头二 · 近景\n风吹过树叶，光影停留在湖面。'}),
    job('invalid-prompt','image','failed',{error:'API 返回 400: prompt length must be between 5 and 2000 characters'}),
    job('working','video','running',{resolved_model:'视频创作'}),
    job('sound','audio','succeeded',{resolved_model:'音频创作',outputs:[{url:base+'/fixture/quiet.wav',kind:'audio',name:'test-quiet.wav'}]}),
    job('long-prompt','image','succeeded',{created_at:Date.now()/1000-40*86400,outputs:[{url:svg(portrait),kind:'image'}]}),
    job('broken-preview','image','succeeded',{outputs:[{url:base+'/fixture/missing.jpg',kind:'image'}]}),
    job('safe-error','image','failed',{error:'平台错误 <img src=x onerror="window.historyXss=2">，保留这条消息便于核对。'}),
  ];
  records[2].request.prompt='为山谷场景编写两段镜头描述';
  records[3].request.prompt='123';
  records[4].request.prompt='云雾流过山脊，镜头缓慢向前移动';
  records[5].request.prompt='湖畔的风声与清晨的鸟鸣';
  records[6].request.prompt=longPrompt;
  const fixtureTime=Date.now()/1000;
  records.forEach((record,index)=>{if(record.id!=='long-prompt')record.created_at=fixtureTime-index*60;});
  await check('classic responsive layout at 320, 768, 1024 and 1440 px',async()=>{
    await openClassic();await waitCards(records.length);await layout(page.locator('.studio-history-v3'),'classic');
  });
  const panel=page.locator('.studio-history-v3');
  await check('type, status, task search, date and reset combine correctly',async()=>{
    await panel.getByRole('button',{name:'文本',exact:true}).click();
    assert.equal(await panel.locator('.studio-history-card:visible').count(),1);
    await panel.getByRole('button',{name:'重置',exact:true}).click();
    await panel.locator('[data-history-status]').selectOption('failed');assert.equal(await panel.locator('.studio-history-card:visible').count(),2);
    await panel.locator('[data-history-search]').fill('task-safe-error');assert.equal(await panel.locator('.studio-history-card:visible').count(),1);
    await panel.getByRole('button',{name:'重置',exact:true}).click();
    await panel.locator('[data-history-period]').selectOption('7');assert.equal(await panel.locator('.studio-history-card:visible').count(),8);
    await panel.getByRole('button',{name:'重置',exact:true}).click();
    await panel.locator('[data-history-search]').fill('没有这个词');await panel.getByText('没有找到匹配的记录',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await panel.locator('.studio-history-card:visible').count(),9);
  });
  await check('full prompt, additional output and raw parameters remain available',async()=>{
    const card=panel.locator('[data-job-id="long-prompt"]');await card.locator('summary').click();
    assert.equal(await card.locator('.studio-history-full-prompt p').textContent(),longPrompt);
    await card.locator('summary').click();
    const multi=panel.locator('[data-job-id="landscape"]');await multi.locator('summary').click();
    assert.equal(await multi.locator('a[download]').count(),2);
    assert.match(await multi.locator('details pre').textContent(),/task-landscape/);
    await multi.locator('summary').click();assert.equal(await page.evaluate(()=>window.historyXss),undefined);
  });
  await check('image enlargement and real video/audio controls use local media',async()=>{
    await panel.locator('[data-job-id="landscape"] .studio-history-preview-button').click();
    await page.locator('.studio-media-preview-dialog img').waitFor();await page.keyboard.press('Escape');
    const film=panel.locator('[data-job-id="film"] video');
    assert.equal(await film.evaluate(el=>el.error?.message||''),'','recorded WebM decodes');
    await film.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-job-id="film"] video').readyState>=2);
    assert(await film.evaluate(el=>el.controls));
    await panel.locator('[data-job-id="film"] .studio-history-preview-button').click();
    assert(await page.locator('.studio-media-preview-dialog video').evaluate(el=>el.controls));
    await page.getByRole('button',{name:'关闭预览',exact:true}).click();
    assert(await panel.locator('[data-job-id="sound"] audio').evaluate(el=>el.controls));
  });
  await check('missing preview has retry and keeps download and canvas actions',async()=>{
    const broken=panel.locator('[data-job-id="broken-preview"]');await broken.scrollIntoViewIfNeeded();
    await broken.getByText('预览暂不可用',{exact:true}).waitFor();
    assert(await broken.getByRole('button',{name:'重试预览',exact:true}).isVisible());
    assert(await broken.getByRole('button',{name:'放入画布',exact:true}).isVisible());
    assert.equal(await broken.locator('a[download]').getAttribute('href'),base+'/fixture/missing.jpg');
  });
  await check('paid amount, unknown fee, errors and reduced motion stay honest',async()=>{
    assert.match(await panel.locator('[data-job-id="landscape"] .studio-history-bill').textContent(),/0.142/);
    assert.match(await panel.locator('[data-job-id="invalid-prompt"] .studio-history-bill').textContent(),/未知/);
    assert.match(await panel.locator('[data-job-id="invalid-prompt"] .studio-history-error').textContent(),/5–2000/);
    assert.equal(await panel.locator('[data-job-id="safe-error"] .studio-history-error img').count(),0);
    assert.equal(await panel.locator('[data-job-id="working"] .studio-history-status').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
  });
  await check('closing history pauses media playback',async()=>{
    await panel.locator('[data-job-id="film"] video').evaluate(async el=>{el.muted=true;await el.play();});
    await closeHistory();
    await page.waitForFunction(()=>document.querySelector('[data-job-id="film"] video').paused);
    await openClassic();await waitCards(9);
  });
  await check('download and reuse settings retain native behavior without generation',async()=>{
    const image=panel.locator('[data-job-id="landscape"]');
    const [download]=await Promise.all([page.waitForEvent('download'),image.locator('.studio-history-card-actions a').click()]);
    assert.equal(download.suggestedFilename(),'test-landscape.svg');
    const count=await page.evaluate(()=>nodes.length);
    await image.getByRole('button',{name:'复用这次设置',exact:true}).click();
    assert.equal(await page.evaluate(()=>nodes.length),count+1);
    assert.equal(await page.evaluate(()=>nodes.at(-1).studioPrompt),records[0].request.prompt);
    assert.equal(await page.evaluate(()=>nodes.at(-1).studioParams.ratio),'3:2');
  });
  await check('place media, save and reload preserve the resulting node',async()=>{
    await openClassic();await waitCards(9);
    await panel.locator('[data-job-id="landscape"]').getByRole('button',{name:'放入画布',exact:true}).click();
    await page.evaluate(()=>saveCanvas());
    assert((await api('/api/canvases/'+classic.id)).canvas.nodes.some(node=>node.url===svg(moon)));
    await page.reload();await page.waitForFunction(()=>window.StudioNodeComposer?.ready&&canvas?.id);
    assert(await page.evaluate(url=>nodes.some(node=>node.url===url),svg(moon)));
  });
  await check('loading, load failure and explicit retry are recoverable',async()=>{
    mode='slow';await openClassic();await panel.getByText('正在读取生成记录',{exact:true}).waitFor();
    await panel.locator('[data-history-search]').fill('task-landscape');
    await panel.getByText('正在读取生成记录',{exact:true}).waitFor();await waitCards(9);
    assert.equal(await panel.locator('.studio-history-card:visible').count(),1);await closeHistory();
    mode='fail';await openClassic();await panel.getByText('暂时无法读取记录',{exact:true}).waitFor();
    await page.screenshot({path:path.join(evidence,'load-error.png')});mode='records';
    await panel.getByRole('button',{name:'重新加载',exact:true}).click();await waitCards(9);
    await panel.locator('[data-history-search]').fill('task-landscape');
    await panel.getByRole('button',{name:'刷新',exact:true}).click();await panel.getByRole('button',{name:'刷新',exact:true}).waitFor();
    assert.equal(await panel.locator('.studio-history-card:visible').count(),1);await closeHistory();
  });
  await check('closing during fetch and reopening cannot revive stale records',async()=>{
    mode='slow';await openClassic();await closeHistory();
    const previous=records;records=[];mode='records';await openClassic();
    await panel.getByText('第一份作品，从画布开始',{exact:true}).waitFor();await pause(800);
    assert.equal(await panel.locator('.studio-history-card').count(),0);
    await closeHistory();await pause(50);assert.equal(await panel.isVisible(),false);records=previous;
  });
  await check('classic light theme and keyboard close',async()=>{
    await openClassic();await waitCards(9);
    await page.evaluate(()=>{document.documentElement.classList.remove('studio-graphite','studio-theme-dark','theme-dark');document.documentElement.classList.add('studio-milk');});
    await panel.locator('.studio-history-body').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:path.join(evidence,'classic-light.png')});
    await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
  });
  const smart=(await api('/api/canvases','POST',{kind:'smart',title:'智能画布记录 · 独立测试'})).canvas;
  await page.goto(base+'/static/smart-canvas.html?id='+smart.id);
  await page.waitForFunction(()=>window.StudioNodeComposer?.ready&&canvas?.id);
  await page.evaluate(items=>{canvas.logs=items.map(job=>({id:job.id,status:job.status==='succeeded'?'success':job.status,createdAt:job.created_at*1000,model:job.resolved_model,prompt:job.request.prompt,outputs:job.outputs,request:job.request,error:job.error,text:job.text}));},records);
  const smartPanel=page.locator('.studio-smart-history');
  await check('smart history uses the same responsive surface and output types',async()=>{
    await page.locator('#smartLogToggle').click();await waitCards(9);await layout(smartPanel,'smart');
    await smartPanel.getByRole('button',{name:'音频',exact:true}).click();assert.equal(await smartPanel.locator('.studio-history-card:visible').count(),1);
    assert(await smartPanel.locator('.studio-history-card:visible audio').isVisible());
    await smartPanel.getByRole('button',{name:'重置',exact:true}).click();
    await smartPanel.getByRole('button',{name:'文本',exact:true}).click();assert.equal(await smartPanel.locator('.studio-history-card:visible').count(),1);
    assert.match(await smartPanel.locator('.studio-history-card:visible .studio-history-text-preview').textContent(),/镜头一/);
    await smartPanel.getByRole('button',{name:'重置',exact:true}).click();
  });
  await check('smart filter-empty state, keyboard focus cycle and Escape',async()=>{
    await smartPanel.locator('[data-history-search]').fill('不存在');
    await smartPanel.getByText('没有找到匹配的记录',{exact:true}).waitFor();
    await smartPanel.getByRole('button',{name:'清除筛选',exact:true}).click();
    await smartPanel.locator('[data-job-id="film"] video').evaluate(async el=>{el.muted=true;await el.play();});
    await smartPanel.getByRole('button',{name:'关闭生成记录',exact:true}).focus();
    await page.keyboard.press('Shift+Tab');assert(await page.evaluate(()=>document.querySelector('.studio-smart-history').contains(document.activeElement)));
    await page.keyboard.press('Tab');assert.equal(await smartPanel.getByRole('button',{name:'关闭生成记录',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await smartPanel.isVisible(),false);
    await page.waitForFunction(()=>document.querySelector('.studio-smart-history [data-job-id="film"] video').paused);
  });
  await check('smart prompt reuse preserves the complete original text',async()=>{
    await page.locator('#smartLogToggle').click();
    const count=await page.evaluate(()=>nodes.length);
    await smartPanel.locator('[data-job-id="long-prompt"]').getByRole('button',{name:'复用提示词',exact:true}).click();
    assert.equal(await page.evaluate(()=>nodes.length),count+1);assert.equal(await page.evaluate(()=>nodes.at(-1).text),longPrompt);
    await page.evaluate(()=>saveCanvas());assert((await api('/api/canvases/'+smart.id)).canvas.nodes.some(node=>node.text===longPrompt));
  });
  await check('closed multi-output details do not load original or additional media',async()=>{
    await page.evaluate(()=>{
      canvas.logs.push({id:'lazy-outputs',status:'success',createdAt:1,model:'本地多图测试',prompt:'验证详情按需读取',request:{kind:'image'},outputs:Array.from({length:12},(_,i)=>({url:'/output/history-lazy-'+i+'.png',kind:'image'}))});
    });
    await page.locator('#smartLogToggle').click();await waitCards(10);
    const card=smartPanel.locator('[data-job-id="lazy-outputs"]');
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-job-id="lazy-outputs"] .studio-history-preview img')?.naturalWidth>0);
    assert.equal(await card.locator('details').evaluate(el=>el.open),false);
    assert.equal(await card.locator('details img[src]').count(),0);
    assert.equal(lazyRequests.length,1);assert(lazyRequests[0].startsWith('/api/media-preview?'));
    assert(lazyRequests[0].includes('w=768'));
    await card.locator('summary').click();
    await card.locator('details img').first().scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-job-id="lazy-outputs"] details img')?.naturalWidth>0);
    assert.equal(await card.locator('details .studio-history-output').count(),11);
    assert(lazyRequests.length>=2);assert(lazyRequests.every(url=>url.startsWith('/api/media-preview?')));
    await card.locator('summary').click();
  });
  await check('explicit prompt/error copy preserves text and reports failure',async()=>{
    await page.evaluate(()=>{window.historyOriginalCopy=copyTextToClipboard;window.historyCopies=[];window.historyFailCopy=false;copyTextToClipboard=value=>{window.historyCopies.push(value);return !window.historyFailCopy;};});
    const card=smartPanel.locator('[data-job-id="long-prompt"]');await card.locator('summary').click();
    await card.getByRole('button',{name:'复制提示词',exact:true}).click();
    await card.getByRole('button',{name:'已复制',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.historyCopies.at(-1)),longPrompt);
    await card.locator('summary').click();
    const failed=smartPanel.locator('[data-job-id="safe-error"]');await failed.locator('summary').click();
    await failed.getByRole('button',{name:'复制原始错误',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.historyCopies.at(-1)),records[8].error);
    await page.evaluate(()=>window.historyFailCopy=true);
    await failed.getByRole('button',{name:'复制提示词',exact:true}).click();
    await failed.getByRole('button',{name:'复制失败，请重试',exact:true}).waitFor();
    await page.evaluate(()=>{copyTextToClipboard=window.historyOriginalCopy;delete window.historyOriginalCopy;});
    await closeHistory();
  });
  assert.deepEqual(errors,[]);assert.deepEqual(paid,[]);assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,errors,paid,external,synthetic:true},null,2));
  console.log(JSON.stringify({passed:checks.length,evidence}));
})().catch(async error=>{
  console.error(error.stack);console.error(serverLog.slice(-1000));process.exitCode=1;
  if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:false,checks,errors,paid,external,error:String(error)},null,2));
}).finally(async()=>{
  await browser?.close();if(server){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(4000)]);}
  assert(path.dirname(runtime)===os.tmpdir()&&path.basename(runtime).startsWith('dw-history-ui-'));fs.rmSync(runtime,{recursive:true,force:true});
});
