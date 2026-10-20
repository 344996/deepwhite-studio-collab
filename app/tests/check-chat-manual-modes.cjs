'use strict';
// Production page and local assets in an isolated browser. All APIs are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/gpt-chat.html'), 'utf8');
const base = 'http://gpt-chat.test';
const errors = [], forbidden = [], requests = [], checks = [];
const out = path.join(root, 'test-output/chat-manual-modes');
fs.mkdirSync(out, {recursive:true});
let conversation = {id:'old-conversation',title:'旧版记录',mode:'agent',messages:[
  {role:'user',content:'保留我的旧记录'},
  {role:'assistant',type:'image',agent_reply:'旧版生成说明仍可查看',image_urls:['/static/studio-mark.svg']},
]};
const config = {chat_model:'test-chat',image_model:'test-image',api_providers:[
  {id:'test-provider',name:'本地模拟平台',enabled:true,chat_models:['test-chat'],image_models:['test-image']},
]};
async function openPage(browser, savedMode){
  const context = await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  await context.addInitScript(value => {
    localStorage.setItem('studio_theme','graphite');
    if(value) localStorage.setItem('gpt_chat_settings_v1',JSON.stringify({mode:value}));
  }, savedMode);
  await context.route('**/*',async route => {
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==base){forbidden.push(req.url());return route.abort();}
    if(url.pathname==='/api/config')return route.fulfill({json:config});
    if(url.pathname==='/api/conversations')return route.fulfill({json:{conversations:[{id:conversation.id,title:conversation.title,last_message:'保留我的旧记录'}]}});
    if(url.pathname==='/api/conversations/old-conversation')return route.fulfill({json:{conversation}});
    if(req.method()==='POST'&&['/api/chat','/api/chat/stream'].includes(url.pathname)){
      const body=req.postDataJSON();requests.push({path:url.pathname,body});
      if(url.pathname==='/api/chat/stream'){
        assert.equal(body.mode,'chat');
        conversation={...conversation,messages:[...conversation.messages,{role:'user',content:body.message},{role:'assistant',content:'普通聊天流式回复'}]};
        const events=[{type:'meta',conversation:{...conversation,messages:conversation.messages.slice(0,-1)}},{type:'delta',delta:'普通聊天'},{type:'delta',delta:'流式回复'},{type:'done',conversation}];
        return route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')});
      }
      assert.equal(body.mode,'image');
      conversation={...conversation,messages:[...conversation.messages,{role:'user',content:body.message},{role:'assistant',type:'image',image_urls:['/static/studio-mark.svg']}]};
      return route.fulfill({json:{conversation}});
    }
    if(url.pathname.startsWith('/static/')){
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
      if(file.startsWith(path.join(root,'static')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
        const contentType={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';
        return route.fulfill({contentType,body:fs.readFileSync(file)});
      }
    }
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
    forbidden.push(req.method()+' '+url.pathname);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/static/gpt-chat.html');
  await page.locator('#messages').getByText('旧版生成说明仍可查看',{exact:true}).waitFor();
  return {context,page};
}
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{channel:'msedge'})});
  try{
    const fresh=await openPage(browser);
    assert.equal(await fresh.page.evaluate(()=>mode),'chat','fresh page starts in ordinary chat');
    assert.equal(await fresh.page.locator('#agentModeBtn').count(),0);
    assert.equal(await fresh.page.locator('#imageControls').isVisible(),false);
    await fresh.page.locator('#messageInput').fill('请用普通聊天回复');
    await fresh.page.locator('#sendBtn').click();
    await fresh.page.locator('#messages').getByText('普通聊天流式回复',{exact:true}).waitFor();
    assert.equal(requests.at(-1).path,'/api/chat/stream');
    assert.equal(requests.at(-1).body.model,'test-chat');
    assert.equal(await fresh.page.locator('#sendBtn').isEnabled(),true);
    checks.push('fresh page defaults to ordinary chat; native streaming payload, deltas and final conversation remain functional');
    await fresh.context.close();

    const {context,page}=await openPage(browser,'agent');
    assert.equal(await page.evaluate(()=>mode),'chat');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gpt_chat_settings_v1')).mode),'chat');
    assert.equal(await page.locator('#messages .generated').count(),1);
    await page.evaluate(()=>setMode('agent'));
    assert.equal(await page.evaluate(()=>mode),'chat');
    assert.equal(await page.locator('#chatModeBtn').getAttribute('aria-pressed'),'true');
    checks.push('legacy agent preference normalizes to chat while historical image results and descriptions remain visible');

    await page.locator('#imageModeBtn').click();
    assert.equal(await page.evaluate(()=>mode),'image');
    assert.equal(await page.locator('#imageControls').isVisible(),true);
    await page.locator('#modelPickerBtn').click();
    assert.equal(await page.locator('#modelPickerTitle').innerText(),'生图模型');
    await page.locator('#modelList button').filter({hasText:'test-image'}).click();
    await page.locator('#messageInput').fill('手动创建一张图片');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(()=>!document.getElementById('sendBtn').disabled);
    assert.equal(requests.at(-1).path,'/api/chat');
    assert.equal(requests.at(-1).body.mode,'image');
    assert.equal(requests.at(-1).body.image_model,'test-image');
    assert.equal(await page.locator('#messages .generated').count(),2);
    await page.locator('#chatModeBtn').click();
    assert.equal(await page.locator('#imageControls').isVisible(),false);
    await page.screenshot({path:path.join(out,'manual-chat.png')});
    checks.push('explicit image mode uses the image model and original manual endpoint; switching back restores chat controls');
    await context.close();

    assert.doesNotMatch(html,/\/api\/chat\/agent|agentModeBtn|mode\s*===\s*['"]agent['"]/);
    for(const script of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)])new vm.Script(script[1]);
    assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
    assert.equal(requests.length,2);
    checks.push('Agent selector and dispatch are absent; inline scripts compile and no external or unintended API call occurs');
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors,forbidden,requests:requests.map(item=>({path:item.path,mode:item.body.mode}))},null,2));
    checks.forEach(check=>console.log('PASS '+check));
    console.log(JSON.stringify({passed:checks.length,evidence:out}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
