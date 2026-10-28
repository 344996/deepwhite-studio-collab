/* F02 (handover 2026-10-26): text files are imported or explicitly refused, never silently dropped.
   Classic: the real "添加 → 上传" picker. Smart: the shared file handler used by its picker and drops. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start,delay,assert}=require('./smart-p1-harness.cjs');
const MiB=1024*1024;
async function main(){
 const h=await start('text-import');
 let failed=0;
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e.message||e).split('\n')[0]);}};
 try{
  const png=fs.readFileSync(path.join(__dirname,'../static/design-review/assets/scene-v1.png'));
  const files=[
   {name:'utf8.txt',mimeType:'text/plain',buffer:Buffer.from('第一场 雨夜站台\n林夏 🌧','utf8')},
   {name:'bom.txt',mimeType:'text/plain',buffer:Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from('带 BOM 的剧本','utf8')])},
   {name:'gb.txt',mimeType:'text/plain',buffer:Buffer.from([0xD3,0xEA,0xD2,0xB9,0xD5,0xBE,0xCC,0xA8])},
   {name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)},
   {name:'big.txt',mimeType:'text/plain',buffer:Buffer.alloc(2*MiB+1,'a')},
   {name:'exact.txt',mimeType:'text/plain',buffer:Buffer.alloc(2*MiB,'b')},
   {name:'scene.png',mimeType:'image/png',buffer:png}];
  const created=(await h.api('/api/canvases','POST',{title:'text import',kind:'classic'})).canvas;
  const page=await h.newPage();
  await page.goto(h.base+'/static/canvas.html?id='+created.id);
  await page.waitForFunction(()=>typeof canvas!=='undefined'&&canvas?.id&&typeof setStatus==='function');await delay(800);
  await page.evaluate(()=>{window.__status=[];const original=setStatus;setStatus=m=>{window.__status.push(String(m));return original(m);};});
  await page.locator('#workspaceCanvasRail button',{hasText:'添加'}).first().click();await delay(300);
  const chooser=page.waitForEvent('filechooser');await page.locator('[data-studio-add="upload"]:visible').first().click();
  await (await chooser).setFiles(files);await delay(2500);
  const state=()=>page.evaluate(()=>({prompts:nodes.filter(n=>n.type==='prompt').map(n=>({title:n.title,text:n.text})),images:nodes.filter(n=>n.type==='image').length,status:window.__status||[]}));
  const s=await state();
  const text=title=>s.prompts.find(p=>p.title===title)?.text;
  await check('classic: UTF-8 with emoji, BOM and GB18030 are imported intact',()=>{
   assert.equal(text('utf8'),'第一场 雨夜站台\n林夏 🌧');assert.equal(text('bom'),'带 BOM 的剧本');assert.equal(text('gb'),'雨夜站台');
  });
  await check('classic: exactly 2 MiB is accepted, over 2 MiB is refused by name',()=>{
   assert.equal(text('exact')?.length,2*MiB);assert.equal(text('big'),undefined);
   assert(s.status.some(m=>/big\.txt/.test(m)&&/2 MB/.test(m)),'no message for big.txt: '+JSON.stringify(s.status));
  });
  await check('classic: the oversized file does not stop the files after it, and the image is imported too',()=>{
   assert(text('exact')!==undefined,'exact.txt after big.txt was skipped');assert.equal(s.images,1);
  });
  await check('classic: an empty file is reported, not silent',()=>{
   assert.equal(text('empty'),'');assert(s.status.some(m=>/empty\.txt/.test(m)&&/空文件/.test(m)),JSON.stringify(s.status));
  });
  await check('classic: imported text survives save and reopen',async()=>{
   await page.evaluate(()=>saveCanvas());await delay(800);
   const saved=(await h.api('/api/canvases/'+created.id)).canvas.nodes.filter(n=>n.type==='prompt');
   assert.equal(saved.find(n=>n.title==='gb')?.text,'雨夜站台');assert.equal(saved.find(n=>n.title==='utf8')?.text,'第一场 雨夜站台\n林夏 🌧');
  });

  const c=await h.smartCanvas('smart text',[{id:'media',type:'smart-image',title:'图',x:100,y:100,images:[]}]);
  const smart=await h.newPage();await h.openSmart(smart,c.id);
  await check('smart: a text file in a mixed drop is named and skipped, the image is kept',async()=>{
   const r=await smart.evaluate(async b64=>{
    const toasts=[];const original=toast;toast=m=>{toasts.push(String(m));return original(m);};
    const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
    const before=nodes.flatMap(n=>n.images||[]).length;
    await handleFiles([new File(['剧本正文'],'script.txt',{type:'text/plain'}),new File([bytes],'scene.png',{type:'image/png'})]);
    return {toasts,added:nodes.flatMap(n=>n.images||[]).length-before};
   },png.toString('base64'));
   assert.equal(r.added,1,'image was not kept');
   assert(r.toasts.some(m=>/script\.txt/.test(m)&&/经典画布/.test(m)),'text was dropped silently: '+JSON.stringify(r.toasts));
  });
  assert.deepEqual(h.errors,[]);assert.deepEqual(h.external,[]);
 }catch(e){console.error(h.log().slice(-2000));throw e;}
 finally{await h.stop();}
 if(failed){console.log(failed+' check(s) failed');process.exit(1);}
}
main().catch(e=>{console.error(e);process.exit(1);});
