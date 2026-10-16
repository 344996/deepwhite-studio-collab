'use strict';
// Offline build only. The application serves CSS and never loads this compiler.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),staticRoot=path.join(root,'static');
const output=path.join(staticRoot,'canvas-utilities.css'),manifest=path.join(staticRoot,'canvas-utilities.manifest.json');
const compilerPath=path.join(staticRoot,'vendor/js/tailwindcss-cdn.js');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const normalize=text=>text.replace(/\r\n/g,'\n').replace(/\?v=[^"'\s<>]+/g,'');
async function collect(){
  const directory=path.join(__dirname,'vendor/tailwindcss-3.4.17');
  const {defaultExtractor}=await import(pathToFileURL(path.join(directory,'defaultExtractor.mjs')).href);
  const extract=defaultExtractor({tailwindConfig:{prefix:'',separator:':'}});
  // Include lazy first-party modules as well as the current page. Vendor, user
  // project data, generated CSS, tests and other HTML pages are not build inputs.
  const files=['canvas.html',...fs.readdirSync(staticRoot).filter(n=>n.endsWith('.js')),...fs.readdirSync(path.join(staticRoot,'js')).filter(n=>n.endsWith('.js')).map(n=>'js/'+n)].sort();
  const candidates=new Set(),inputs=[];
  for(const file of files){
    const text=normalize(fs.readFileSync(path.join(staticRoot,file),'utf8'));
    assert(!/tailwind\.(?:config|plugin)|text\/tailwindcss|@apply\b/.test(text),'Custom compiler configuration requires an explicit build update: '+file);
    for(const candidate of extract(text))if(candidate&&!/\s/.test(candidate))candidates.add(candidate);
    inputs.push({file,sha256:sha(text)});
  }
  const compiler=fs.readFileSync(compilerPath,'utf8');assert(compiler.includes('"3.4.17"'),'Review a compiler version change before rebuilding');
  const sorted=[...candidates].sort();
  const source={version:1,tailwind:'3.4.17',compilerSha256:sha(compiler),extractorHashes:Object.fromEntries(['defaultExtractor.mjs','regex.mjs','splitAtTopLevelOnly.mjs'].map(name=>[name,sha(normalize(fs.readFileSync(path.join(directory,name),'utf8')))])),inputs,candidateCount:sorted.length,candidatesSha256:sha(sorted.join('\n'))};
  return {source,candidates:sorted,compiler};
}
function verify(data){
  const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));
  assert.deepEqual(saved.source,data.source,'Canvas utility inputs changed; run node app/tools/build-canvas-utilities.cjs');
  assert.equal(sha(fs.readFileSync(output)),saved.cssSha256,'Generated canvas utility CSS was edited or is missing');
  return saved;
}
async function compile(data){
  let playwright;try{playwright=require('playwright');}catch{playwright=require(process.env.PLAYWRIGHT_MODULE||'data/local-path');}
  const browser=await playwright.chromium.launch(process.env.CHROMIUM_EXECUTABLE?{headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE}:{headless:true,channel:'msedge'});
  try{
    const context=await browser.newContext();await context.route('**/*',route=>route.abort());const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.addScriptTag({content:data.compiler});
    await page.evaluate(candidates=>{const carrier=document.createElement('div');carrier.style.setProperty('display','none','important');carrier.className=candidates.join(' ');document.body.append(carrier);},data.candidates);
    await page.waitForFunction(()=>[...document.querySelectorAll('style')].some(s=>s.textContent.includes('.w-4')&&s.textContent.includes('.h-4')),{},{timeout:60000});
    // The pinned compiler processes the complete carrier in one pass. Its output
    // remains the compiler's original preflight, plugins and utility ordering.
    const css=await page.evaluate(()=>[...document.querySelectorAll('style')].find(s=>s.textContent.includes('tailwindcss v3.4.17')).textContent);
    assert.deepEqual(errors,[]);assert(css.includes('box-sizing:border-box')&&css.includes('.w-4'),'Compiler output lacks preflight or icon utilities');
    return '/* Generated offline by tools/build-canvas-utilities.cjs. Do not edit. */\n'+css.trim()+'\n';
  }finally{await browser.close();}
}
async function main(){
  const data=await collect();
  if(process.argv.includes('--check')){verify(data);console.log('Canvas utilities are current: '+data.source.inputs.length+' source files.');return;}
  const css=await compile(data);fs.writeFileSync(output,css);fs.writeFileSync(manifest,JSON.stringify({source:data.source,cssSha256:sha(css)},null,2)+'\n');
  console.log(JSON.stringify({inputs:data.source.inputs.length,candidates:data.candidates.length,cssBytes:Buffer.byteLength(css),output}));
}
module.exports={collect,compile,verify,output,manifest};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
