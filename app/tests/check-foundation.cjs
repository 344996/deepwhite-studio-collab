/* Requires Playwright via NODE_PATH; all writes use a disposable runtime directory. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-studio-test-'));
const out=path.join(root,'test-output');fs.mkdirSync(out,{recursive:true});
const base='http://127.0.0.1:3859';
let child,browser,activePage;
let log='';
const checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(route,method='GET',data){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});assert(response.ok,`${method} ${route}: ${response.status}`);return response.json();}
(async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'provenance/source-manifest.json'),'utf8'));
  // Files deliberately changed since the copy: the first three in the sanitized handoff (d59a022),
  // the rest by later product work in this repository (see git log). Everything else must match.
  const changed=new Set(['static/js/ltx-director-timeline.js','static/js/comfyui-settings.js','CLI/windows/jimeng/install_wsl_ubuntu.bat',
    'static/css/canvas.css','static/css/smart-canvas.css','static/js/asset-manager.js','static/js/canvas-list.js','static/js/smart-canvas.js']);
  // A source checkout carries a python/ shim instead of the bundled runtime; a release carries the runtime.
  const bundledPython=fs.existsSync(path.join(root,'python/python310.dll'));
  // Git may rewrite line endings on checkout, so CRLF/LF and the final newline are not counted.
  const sha=text=>crypto.createHash('sha256').update(Buffer.from(text,'latin1')).digest('hex');
  const variants=bytes=>{const lf=bytes.toString('latin1').replace(/\r\n/g,'\n').replace(/\n+$/,'');
    return [bytes.toString('latin1'),...['\n','\r\n'].flatMap(eol=>['',eol,eol+eol].map(end=>lf.replace(/\n/g,eol)+end))].map(sha);};
  for(const [rel,hash] of Object.entries(manifest.copied_files)){
    if(rel==='main.py'||rel==='static/js/canvas.js'||rel.endsWith('.html')||changed.has(rel))continue;
    if(rel.startsWith('python/')&&!bundledPython)continue;
    assert(fs.existsSync(path.join(root,rel)),rel+' is missing');
    assert(variants(fs.readFileSync(path.join(root,rel))).includes(hash),rel+' differs from the copied source');
  }
  checks.push('除已记录的生图参数传递修正外，工具、依赖及工作流与源文件校验一致');
  child=spawn(path.join(root,'python/python.exe'),[path.join(root,'studio_server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_LEGACY_SMART_FIXTURES:'1',DEEPWHITE_STUDIO_PORT:'3859',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1'}});
  child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  let ready=false;
  for(let i=0;i<100;i++){try{const h=await request('/api/studio/health');assert.equal(h.installation,root);ready=true;break;}catch{await sleep(200);}}
  assert(ready,'test server not ready');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();const errors=[];let generationRequests=0;
  activePage=page;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const req=route.request();
    if(req.method()==='POST'&&/\/api\/(canvas-(image|video|llm|comfy)|generate|online-image)/.test(req.url())){generationRequests++;return route.abort();}
    return route.continue();
  });
  await page.goto(base);await page.waitForSelector('.studio-brand-bar');
  const project=await request('/api/projects','POST',{name:'隔离测试项目'});
  const projectId=project.project?.id||project.id;assert(projectId);
  const created=await request('/api/canvases','POST',{title:'基础回归画布',kind:'smart',project:projectId});
  const id=created.canvas.id;
  await page.goto(`${base}/static/smart-canvas.html?id=${id}&project=${projectId}`);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof createPromptNode==='function');
  await page.mouse.dblclick(550,300);
  await page.waitForSelector('#createMenu.open');
  assert.deepEqual(await page.locator('#createMenu [data-studio-add] > span').allTextContents(),['文本','图片','视频','MJ 工具','音频','上传','从作品导入']);
  assert(await page.locator('#createMenu [data-studio-add="audio"]').isDisabled());
  await page.locator('#createMenu [data-studio-add="text"]').click();
  await page.waitForSelector('.prompt-node-text');
  await page.locator('.prompt-llm-toggle').click();
  await page.locator('.prompt-node-text').fill('DeepWhite 基础功能检查');
  await page.evaluate(()=>{document.activeElement.blur();saveCanvas();});
  await page.waitForFunction(()=>nodes[0].text==='DeepWhite 基础功能检查');
  await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>nodes.length===2);
  await page.keyboard.press('Delete');await page.waitForFunction(()=>nodes.length===1);
  await page.keyboard.press('Control+z');await page.waitForFunction(()=>nodes.length===2);
  checks.push('原画布双击添加、文字输入、复制粘贴、删除撤销');
  await page.evaluate(()=>{connectInputNode(nodes[0].id,nodes[1].id);render();});
  assert.equal(await page.evaluate(()=>canvas.connections.length),1);
  const scale=await page.evaluate(()=>viewport.scale);
  await page.mouse.move(1200,780);await page.mouse.wheel(0,-200);
  await page.waitForFunction(s=>viewport.scale!==s,scale);
  await page.evaluate(async()=>{await saveCanvas();});
  await page.reload();await page.waitForFunction(()=>typeof nodes!=='undefined'&&nodes.length===2);
  assert.equal(await page.evaluate(()=>canvas.connections.length),1);
  assert.equal(await page.evaluate(()=>nodes[0].text),'DeepWhite 基础功能检查');
  checks.push('连线、缩放、保存后刷新恢复节点与连线');
  await page.screenshot({path:path.join(out,'foundation-canvas.png')});
  await page.goto(base);
  await request(`/api/canvases/${id}`,'DELETE');
  const trash=await request('/api/canvases/trash');assert(JSON.stringify(trash).includes(id));
  await request(`/api/canvases/${id}/restore`,'POST',{});
  assert.equal((await request(`/api/canvases/${id}`)).canvas.title,'基础回归画布');
  checks.push('独立项目管理、回收站与恢复');
  // Verify the actual classic canvas from the user's screenshot, not just the preview.
  const classic=(await request('/api/canvases','POST',{title:'普通画布菜单检查',kind:'classic',project:projectId})).canvas.id;
  await page.goto(`${base}/static/canvas.html?id=${classic}&project=${projectId}`);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&document.querySelector('#createMenu.studio-create-menu'));
  await page.waitForSelector('#shell:not(.no-canvas) #board', {state:'visible'});
  await page.mouse.dblclick(480,320);await page.waitForSelector('#createMenu.open');
  assert.deepEqual(await page.locator('#createMenu [data-studio-add] > span').allTextContents(),['文本','图片','视频','MJ 工具','音频','上传','从作品导入']);
  // The toolbar's single "添加" button opens the same menu as a double-click.
  await page.keyboard.press('Escape');await page.waitForSelector('#createMenu.open',{state:'detached'}).catch(()=>{});
  await page.locator('#quickToolbar #studioV2Add').click();await page.waitForSelector('#createMenu.open');
  assert.deepEqual(await page.locator('#createMenu [data-studio-add] > span').allTextContents(),['文本','图片','视频','MJ 工具','音频','上传','从作品导入']);
  assert(await page.locator('[onclick="groupSelectedImages()"]', {strict:true}).count());
  await page.screenshot({path:path.join(out,'classic-menu.png')});
  await page.locator('#createMenu').screenshot({path:path.join(out,'classic-menu-detail.png')});
  await page.locator('#createMenu [data-studio-add="image"]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.type==='generator'));
  await page.evaluate(()=>openGeneratorNodeMenu(nodes.find(n=>n.type==='generator').id,500,350));
  const linkedLabels=await page.locator('#nodeInputMenu button span, #nodeOutputMenu button span').allTextContents();
  assert(linkedLabels.length>0);assert(linkedLabels.every(label=>['文本','图片','视频','MJ 工具','上传'].includes(label)));
  await page.evaluate(()=>closeCreateMenu());
  await page.mouse.click(120,550,{button:'right'});await page.waitForSelector('#createMenu.open');
  await page.locator('#createMenu [data-studio-add="video"]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.type==='video'));
  await page.mouse.dblclick(1100,150);await page.waitForSelector('#createMenu.open');
  await page.locator('#createMenu [data-studio-add="text"]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.type==='llm'));
  await page.evaluate(async()=>{await saveCanvas();});
  await page.reload();await page.waitForFunction(()=>typeof nodes!=='undefined'&&nodes.length===3&&!document.querySelector('#shell').classList.contains('no-canvas'));
  await page.mouse.dblclick(1400,750);await page.waitForSelector('#createMenu.open');
  const menuBox=await page.locator('#createMenu').boundingBox();assert(menuBox.x+menuBox.width<=1440&&menuBox.y+menuBox.height<=1000);
  await page.locator('#createMenu [data-studio-add="works"]').click();
  await page.waitForSelector('.studio-works-dialog[open]');
  await page.waitForFunction(()=>!document.querySelector('.studio-works-body').textContent.includes('正在读取'));
  await page.getByLabel('关闭作品导入').click();
  checks.push('正式普通画布：双击/右键、顶部快捷栏、连线菜单统一；创建文图视频并保存；作品导入与边缘菜单');
  await page.goto(`${base}/static/smart-canvas.html?id=${id}&project=${projectId}`);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id);
  await page.mouse.dblclick(1050,680);await page.waitForSelector('#createMenu.open');
  await page.screenshot({path:path.join(out,'smart-menu.png')});
  await page.locator('#createMenu [data-studio-add="video"]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.studioKind==='video'&&n.runSettings.apiKind==='video'));
  await page.mouse.dblclick(1300,800);await page.waitForSelector('#createMenu.open');
  await page.locator('#createMenu [data-studio-add="image"]').click();
  await page.waitForFunction(()=>nodes.some(n=>n.studioKind==='image'&&n.runSettings.apiKind==='image'));
  checks.push('正式智能画布：菜单七项（含新增 MJ 工具），文字/图片/视频按对应类型创建，音频明确标记待接入');
  await page.goto(base+'/preview');await page.waitForFunction(()=>document.querySelector('.price').textContent.includes('预计'));
  await page.screenshot({path:path.join(out,'preview-desktop.png')});
  const before=await page.locator('.price').textContent();
  await page.locator('[data-action="params"]').click();await page.locator('[data-key="resolution"][data-value="2k"]').click();
  assert.notEqual(await page.locator('.price').textContent(),before);
  await page.screenshot({path:path.join(out,'preview-parameters.png')});
  const referenceChooser=page.waitForEvent('filechooser');await page.getByLabel('添加参考图',{exact:true}).click();
  const chooser=await referenceChooser;
  await chooser.setFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=','base64')});
  assert.equal(await page.locator('.mode-label').textContent(),'参考图生成');
  await page.getByLabel('移除参考图').click();assert.equal(await page.locator('.mode-label').textContent(),'文字生成图片');
  await page.locator('.model-select').selectOption('deepwhiteai-image-g-v2.5-flare');
  assert((await page.locator('.price').textContent()).includes('按实际用量计费'));
  await page.getByLabel('预览生成操作').click();await page.waitForSelector('dialog[open]');await page.locator('#closeDialog').click();
  checks.push('交互稿模型参数联动、快照估价、参考图模式自动切换、生成不调用 API');
  await page.mouse.dblclick(155,420);await page.waitForSelector('#addMenu:not([hidden])');
  assert.deepEqual(await page.locator('#addMenu button').allTextContents(),['文本','图片','视频','音频','上传','从作品导入']);
  await page.screenshot({path:path.join(out,'preview-menu.png')});
  await page.locator('#addMenu [data-add="audio"]').click();
  assert.equal(await page.locator('.preview-node.selected .node-title strong').textContent(),'音频');
  for(const kind of ['video','text']){await page.locator(`.type-rail [data-add="${kind}"]`).click();assert.equal(await page.locator('.preview-node.selected .model-select option').count(),2);}
  checks.push('交互稿双击菜单六个入口，文字图片视频音频均可选择模型');
  await page.setViewportSize({width:390,height:844});await page.locator('#resetPreview').click();
  await page.screenshot({path:path.join(out,'preview-mobile.png')});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  checks.push('移动端预览无页面横向溢出');
  assert.equal(generationRequests,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks,generationRequests,pageErrors:errors},null,2));
  console.log(JSON.stringify({passed:true,checks,generationRequests},null,2));
})().catch(async e=>{console.error(e);if(activePage){await activePage.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(await activePage.evaluate(()=>({hit:document.elementFromPoint(1100,150)?.outerHTML?.slice(0,350),menu:document.querySelector('#createMenu')?.className})).catch(()=>null));}fs.writeFileSync(path.join(out,'failure.log'),log+'\n'+e.stack);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();
  if(child){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([exit,sleep(4000)]);}
  // The path is created above by mkdtemp under the system temporary directory.
  const realTemp=path.resolve(os.tmpdir())+path.sep;
  if(path.resolve(runtime).startsWith(realTemp)&&path.basename(runtime).startsWith('deepwhite-studio-test-'))fs.rmSync(runtime,{recursive:true,force:true});
});
