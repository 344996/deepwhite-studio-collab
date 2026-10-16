const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:3874';
  await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  await page.goto(base+'/static/canvas.html?id=controlfixture');
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id==='controlfixture');
  await page.waitForTimeout(500);
  await page.evaluate(()=>{nodes.push({id:'localdraft',type:'prompt',text:'仍未保存的手工草稿',x:100,y:100,w:300});localCanvasDirty=true;clearTimeout(saveTimer);saveTimer=null;render();});
  const res=await page.request.post(base+'/test/external-edit');assert(res.ok());
  await page.locator('#studioCanvasConflict').waitFor();
  assert(await page.evaluate(()=>nodes.some(n=>n.id==='localdraft')));
  const remote=(await(await page.request.get(base+'/api/canvases/controlfixture')).json()).canvas;
  assert(remote.nodes.some(n=>n.id==='external'));
  await page.evaluate(()=>saveCanvas());
  const after=(await(await page.request.get(base+'/api/canvases/controlfixture')).json()).canvas;
  assert(after.nodes.some(n=>n.id==='external'));assert(!after.nodes.some(n=>n.id==='localdraft'));
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出本地草稿'}).click();assert((await download).suggestedFilename().endsWith('.json'));
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'载入最新画布'}).click();
  await page.waitForFunction(()=>!document.getElementById('studioCanvasConflict')&&nodes.some(n=>n.id==='external'));
  assert(!await page.evaluate(()=>nodes.some(n=>n.id==='localdraft')));
  assert.deepEqual(errors,[]);
  console.log('PASS external update preserves dirty draft, blocks stale saves, exports draft and loads latest');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
