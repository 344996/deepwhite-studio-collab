const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:3870',out=path.resolve('test-output/design-v0.3');
fs.mkdirSync(out,{recursive:true});
let browser;const errors=[],unsafe=[],bad=[],checks=[];
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1050},deviceScaleFactor:1});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400)bad.push(r.url());});
 await page.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==base||!u.pathname.startsWith('/static/')||req.method()!=='GET'){
     unsafe.push(req.method()+' '+req.url());return route.abort();
   }
   return route.continue();
 });
 await page.goto(base+'/static/design-v0.3/index.html');
 await page.screenshot({path:path.join(out,'home.png'),fullPage:true});
 for(const name of ['首页项目','创作画布','资产库','制作工具','设置账户']){
   await page.getByLabel('导航：'+name,{exact:true}).click();
 }
 checks.push('五个主导航可操作');
 await page.getByLabel('导航：创作画布',{exact:true}).click();
 await page.locator('[data-open-modal=standard]').first().click();assert(!(await page.locator('[role=dialog]').innerText()).includes('正面、侧面与背面'));await page.getByLabel('关闭弹窗',{exact:true}).click();
 await page.locator('#param-open').click();await page.locator('[role=dialog]').waitFor();
 await page.getByLabel('关闭弹窗',{exact:true}).click();
 await page.locator('#model-select').click();await page.locator('[role=dialog]').waitFor();
 await page.getByLabel('关闭弹窗',{exact:true}).click();
 await page.locator('#generate-demo').click();await page.locator('#confirm-demo-generation').click();
 checks.push('模型和参数弹窗、生成演示反馈');
 await page.locator('#add-node-menu').click();await page.locator('[data-add-node="audio"]').click();
 await page.locator('#agent-open').click();await page.locator('#agent-preview').click();
 await page.locator('#agent-preview-box').waitFor();const before=await page.locator('#canvas-node-list').evaluate(e=>e.children.length);await page.locator('#agent-apply').click();assert.equal(await page.locator('#canvas-node-list').evaluate(e=>e.children.length),before+2);await page.waitForTimeout(400);
 checks.push('音频示例节点、Agent计划预览与模拟写入');
 await page.screenshot({path:path.join(out,'canvas.png'),fullPage:true});
 await page.getByLabel('导航：资产库',{exact:true}).click();
 await page.locator('[data-asset-action="confirm"]').click();
 assert.equal(await page.locator('[data-asset-id="DW-CHAR-0047"]').getAttribute('data-status'),'已确认');
 await page.getByLabel('按资产状态筛选').selectOption({label:'已确认'});
 await page.getByLabel('文件夹视图',{exact:true}).click();
 checks.push('候选资产确认、状态筛选与文件夹视图');
 await page.screenshot({path:path.join(out,'assets.png'),fullPage:true});
 await page.getByLabel('导航：设置账户',{exact:true}).click();
 await page.getByLabel('RunningHub 应用名称',{exact:true}).fill('高清演示验收 <b id=probe>测试</b>');
 await page.getByLabel('RunningHub 站点地址或应用 ID',{exact:true}).fill('demo_app_001');
 await page.locator('#rh-add').click();assert.equal(await page.locator('#probe').count(),0);assert((await page.locator('#mapping-list').innerText()).includes('高清演示验收'));
 await page.locator('#check-update').click();
 checks.push('RH应用配置与更新演示');await page.getByLabel('导航：首页项目',{exact:true}).click();for(const theme of ['light','dark','milk','graphite']){await page.getByLabel('预览主题',{exact:true}).selectOption(theme);assert.equal(await page.locator('html').getAttribute('data-theme'),theme);await page.waitForTimeout(450);if(theme==='milk')await page.screenshot({path:path.join(out,'milk.png'),fullPage:true});}checks.push('四主题在独立预览中切换，不写正式主题设置');
 assert.deepEqual(errors,[]);assert.deepEqual(unsafe,[]);assert.deepEqual(bad,[]);
 for(const url of ['/workspace/API/.env','/static/../workspace/API/.env','/','/static/']){
   const r=await fetch(base+url,{redirect:'manual'});assert([302,404].includes(r.status));
 }
 checks.push('预览无外部请求、无API生成请求，服务不公开工作区配置或目录列表');
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({checks,errors,unsafe,bad},null,2));
 console.log('PASS '+checks.join('；'));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();});
