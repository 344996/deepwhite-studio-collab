(() => {
  const key='deepwhite_canvas_material',root=document.documentElement;
  const select=document.createElement('select');
  select.id='studioCanvasTheme';select.setAttribute('aria-label','画布主题');select.title='画布主题';select.className='tool-btn';select.style.cssText='width:128px;cursor:pointer;font-size:11px;padding:0 8px';
  select.innerHTML='<option value="light">浅色</option><option value="dark">深色</option><option value="milk">牛奶白</option><option value="graphite">深色 · 薄荷</option>';
  document.querySelector('#quickToolbar .toolbar-fixed')?.append(select);
  function setMaterial(value){
    for(const element of [root,document.body,document.getElementById('shell')]){
      if(!element)continue;
      element.classList.remove('studio-milk','studio-graphite');
      if(value==='milk')element.classList.add('studio-milk');
      if(value==='graphite')element.classList.add('studio-graphite');
    }
    select.value=['milk','graphite'].includes(value)?value:(StudioTheme.get()==='dark'?'dark':'light');
  }
  const stored=()=>{try{return localStorage.getItem(key)||'';}catch{return '';}};
  const hasExplicitBaseTheme=()=>{try{return localStorage.getItem('studio_theme')!==null||localStorage.getItem('canvas_theme')!==null;}catch{return false;}};
  let initialMaterial=stored();
  if(!initialMaterial&&!hasExplicitBaseTheme()){
    initialMaterial='graphite';
    try{localStorage.setItem(key,initialMaterial);}catch{}
  }
  setMaterial(initialMaterial);
  select.onchange=()=>{
    const theme=select.value;
    if(['milk','graphite'].includes(theme)){localStorage.setItem(key,theme);setMaterial(theme);}
    else{localStorage.removeItem(key);setMaterial('');StudioTheme.set(theme);select.value=theme;}
  };
  let ready=document.readyState!=='loading';
  document.addEventListener('DOMContentLoaded',()=>{ready=true;setMaterial(stored());});
  window.addEventListener('studio-theme-change',()=>{
    if(!ready)return;
    localStorage.removeItem(key);
    setMaterial('');
  });
  window.addEventListener('storage',event=>{
    if(event.key===key)setMaterial(event.newValue||'');
  });
  window.addEventListener('load',()=>setMaterial(stored()));
})();
