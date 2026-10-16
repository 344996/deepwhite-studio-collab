/* Browser checks against an isolated runtime; all generation calls are mocked. */
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=fs.mkdtempSync(path.join(os.tmpdir(),'deepwhite-assets-')),base='http://127.0.0.1:3860',out=path.join(root,'test-output');
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,page,log='';const errors=[],submitted=[],jobs=new Map(),checks=[];
async function api(url,body){const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return r.json();}
(async()=>{
 child=spawn(path.join(root,'python/python.exe'),[path.join(root,'tests/catalog-browser-server.py')],{cwd:root,windowsHide:true,env:{...process.env,DEEPWHITE_STUDIO_PORT:'3860',DEEPWHITE_STUDIO_RUNTIME_DIR:runtime,PYTHONUTF8:'1'}});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{await api('/api/studio/health');break;}catch{await pause(200);}}
 await api('/api/studio/settings/sync-models',{id:'deepwhite',name:'DeepWhite',base_url:'https://api.deepwhiteai.com/v1',api_key:'sk-asset-fixture',enabled:true,primary:true});
 const project=(await api('/api/projects',{name:'资产工具验收'})).project,canvas=(await api('/api/canvases',{title:'资产处理',kind:'classic',project:project.id})).canvas;
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1500,height:1050}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());assert.equal(u.origin,base,'No external traffic');
 if(u.pathname==='/api/studio/generations'&&req.method()==='POST'){const body=req.postDataJSON();submitted.push(body);const job={id:body.request_id,request:body,resolved_model:body.model,status:'succeeded',created_at:Date.now()/1000,updated_at:Date.now()/1000,children:[],task_ids:['mock-asset'],outputs:[{url:'/static/studio-mark.svg?asset-result='+submitted.length,kind:'image'}],text:'',error:''};jobs.set(job.id,job);return route.fulfill({json:job});}
 if(u.pathname==='/api/studio/generations')return route.fulfill({json:{items:[...jobs.values()]}});
 if(u.pathname.startsWith('/api/studio/generations/'))return route.fulfill({json:jobs.get(u.pathname.split('/').pop())||{}});
 return route.continue();});
 await page.goto(base+'/static/canvas.html?id='+canvas.id);await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof StudioAssetTools!=='undefined');await pause(300);
 await page.evaluate(()=>{createImageCardFromUrl('/static/studio-mark.svg',{x:100,y:180},'人物原图');createImageCardFromUrl('/static/studio-mark.svg?clothes',{x:700,y:180},'衣服参考');});
 const d=page.locator('.studio-asset-dialog');
 async function open(group){await page.evaluate(group=>{const n=nodes.find(n=>n.name==='人物原图');return StudioAssetTools.open(group,n,{url:n.url,name:n.name,kind:'image'});},group);await d.getByLabel('具体型号').waitFor();}
 await open('person');assert(await d.getByRole('button',{name:'生成处理结果',exact:true}).isDisabled());
 await d.getByLabel('处理要求').fill('替换为参考图中的黑色外套');await d.getByLabel('从画布选择额外参考').selectOption('0');await d.getByText('查看实际发送的提示词').click();assert((await d.locator('pre').innerText()).includes('图2：服装参考'));
 await d.getByRole('button',{name:'生成处理结果',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='outfit'));await pause(200);assert.equal(submitted.length,1);assert.deepEqual(submitted[0].references.map(r=>r.url),['/static/studio-mark.svg','/static/studio-mark.svg?clothes']);assert(submitted[0].prompt.includes('不移植图2的人脸'));
 checks.push('换装要求校验、角色参考顺序、参数与请求正确，原图保留');
 await open('person');await d.getByLabel('模型系列').selectOption({label:'Nano Banana'});assert((await d.getByLabel('具体型号').textContent()).length>0);await d.getByLabel('处理功能').selectOption('prop');await d.getByLabel('处理要求').fill('把手中的物品替换成一本书');await d.getByRole('button',{name:'生成处理结果',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='prop'));await pause(200);assert(submitted[1].model.includes('image-nb-'));assert.equal(submitted[1].references.length,1);
 await open('scene');await d.getByLabel('处理功能').selectOption('scene-reverse');await d.getByRole('button',{name:'生成处理结果',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='scene-reverse'));await pause(200);assert(submitted[2].prompt.includes('不是左右镜像'));
 checks.push('模型系列与具体版本两级切换；Nano Banana 修改及场景反向提示词');
 await open('edit');await d.getByLabel('处理要求').fill('仅修改涂抹区域，改成蓝色');const draw=d.getByLabel('涂抹修改区域');const rect=await draw.boundingBox();await page.mouse.move(rect.x+30,rect.y+30);await page.mouse.down();await page.mouse.move(rect.x+70,rect.y+70);await page.mouse.up();
 await d.getByRole('button',{name:'生成处理结果',exact:true}).click();await page.waitForFunction(()=>nodes.some(n=>n.studioProcessing?.type==='image-edit'));await pause(200);assert.equal(submitted[3].references.length,2);assert(submitted[3].references[1].url.includes('/assets/'));assert(submitted[3].prompt.includes('红色区域标注'));assert.equal(submitted[3].references[0].url,'/static/studio-mark.svg');
 checks.push('实际画笔标注、PNG 上传、原图与标注图顺序，明确非原生蒙版编辑');
 await page.evaluate(()=>{const n=nodes.find(n=>n.name==='人物原图');StudioAssetTools.compare(n,{url:n.url,name:n.name,kind:'image'});});await d.getByLabel('图片 B').selectOption('0');await d.getByRole('button',{name:'添加对比节点',exact:true}).click();await page.locator('.studio-compare-node').waitFor();
 const slider=page.getByLabel('双图对比分界线');await slider.fill('72');await slider.dispatchEvent('change');await page.evaluate(async()=>{render();await saveCanvas();});assert.equal(await page.getByLabel('双图对比分界线').inputValue(),'72');await page.reload();await page.waitForFunction(()=>nodes.some(n=>n.studioCompare));assert.equal(await page.getByLabel('双图对比分界线').inputValue(),'72');assert.equal(submitted.length,4);
 await page.screenshot({path:path.join(out,'asset-compare-node.png')});
 // Delete through production shortcut and undo without losing either source image.
 await page.evaluate(()=>{selected.clear();selected.add(nodes.find(n=>n.studioCompare).id);document.activeElement?.blur();refreshSelectionVisuals();});await page.keyboard.press('Delete');await page.waitForFunction(()=>!nodes.some(n=>n.studioCompare));await page.keyboard.press('Control+z');await page.waitForFunction(()=>nodes.some(n=>n.studioCompare));assert(await page.evaluate(()=>nodes.some(n=>n.name==='人物原图')));
 checks.push('对比节点滑动、重绘、保存重开、删除撤销均保留素材；恢复不重发生成');
 await open('person');await d.getByRole('button',{name:'关闭资产工具',exact:true}).click();assert.equal(submitted.length,4);
 // A stale reference must not be submitted after the source changes.
 await open('person');await d.getByLabel('处理要求').fill('换白色上衣');await page.evaluate(()=>{nodes.find(n=>n.name==='人物原图').url='/static/studio-mark.svg?changed';});await d.getByLabel('处理要求').fill('换白色衬衫');assert(await d.getByRole('button',{name:'生成处理结果',exact:true}).isDisabled());assert.equal(submitted.length,4);
 checks.push('关闭不提交；源图变更后阻止使用陈旧参考');assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'asset-tools-checks.json'),JSON.stringify({passed:true,checks,paidCalls:0},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
})().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(out,'asset-tools-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'asset-tools-server.log'),log);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child){const done=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([done,pause(4000)]);}assert(path.resolve(runtime).startsWith(path.join(os.tmpdir(),'deepwhite-assets-')));fs.rmSync(runtime,{recursive:true,force:true});});
