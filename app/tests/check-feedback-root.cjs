const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1050}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:3874')?r.continue():r.abort());
  await context.route('**/api/studio/account',r=>r.fulfill({json:{username:'测试账户',balance:123.45,symbol:'¥',avatar_url:'/static/studio-mark.svg'}}));
  await page.goto('http://127.0.0.1:3874/static/canvas.html?id=controlfixture');
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id==='controlfixture');
  await page.waitForTimeout(500);
  await page.evaluate(()=>{nodes=[{id:'ui-image',type:'generator',x:300,y:150,w:780,apiProvider:'mcp-fixture',model:'deepwhiteai-image-g-v2.5-lowprice',studioPrompt:'测试节点，不执行生成',count:1,studioParams:{},studioParamsModel:'deepwhiteai-image-g-v2.5-lowprice'}];connections=[];viewport={x:0,y:0,scale:1};render();});
  const node=page.locator('[data-id=ui-image]');
  await node.locator('.studio-image-footer .studio-count-inline select').waitFor();
  assert.equal(await node.locator('.studio-image-settings-popup [aria-label="生成张数"]').count(),0);
  await node.locator('.studio-model-trigger').click();
  assert.equal(await page.locator('#studioModelPicker [aria-label="调用平台"]').count(),0);
  // The channel is chosen in the picker's 调用渠道 list, then the model.
  await page.locator('#studioModelPicker .studio-picker-channel-row select').selectOption('mcp-fixture');
  await page.locator('#studioModelPicker .studio-picker-option').first().click();
  assert.equal(await page.evaluate(()=>nodes[0].apiProvider),'mcp-fixture');
  fs.mkdirSync('test-output/feedback-0926',{recursive:true});await page.screenshot({path:'test-output/feedback-0926/canvas-ui.png'});
  await page.getByRole('button',{name:'测试账户',exact:true}).click();
  assert.equal(await page.locator('.dw-account-wallet:not([data-generation-status])>strong').textContent(),'¥123.45');assert.equal(await page.locator('.dw-account-identity img').count(),1);
  await page.screenshot({path:'test-output/feedback-0926/account-ui.png'});await page.locator('.dw-library header button').click();
  const settings=await context.newPage();settings.on('pageerror',e=>errors.push(e.message));await settings.goto('http://127.0.0.1:3874/settings');
  await settings.locator('.studio-connection-cards').waitFor();await settings.locator('.studio-connection-cards button').filter({hasText:'本地 ComfyUI'}).click();
  await settings.locator('.studio-engine-dialog[open]').waitFor();await settings.locator('.studio-engine-dialog [data-close]').click();
  await settings.locator('.studio-connection-cards button').filter({hasText:'即梦账号'}).click();await settings.locator('#dreaminaPanel').waitFor({state:'visible'});
  await settings.locator('[data-tab=api]').click();await settings.screenshot({path:'test-output/feedback-0926/settings-ui.png'});
  assert.deepEqual(errors,[]);console.log('PASS model-first channel menu, external count, connection settings, engine dialog, no page errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
