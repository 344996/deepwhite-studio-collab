/* Shared Studio V2 presentation; connection and account actions stay native. */
(() => {
  'use strict';
  const root=document.documentElement,select=document.getElementById('theme');
  if(!select)return;
  root.classList.add('studio-v2','studio-v2-settings');
  for(const href of ['/static/studio-v2-theme.css','/static/studio-settings-v2.css']){
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);
  }
  const key='deepwhite_canvas_material';
  function selectedTheme(){
    try{const material=localStorage.getItem(key);if(['graphite','milk'].includes(material))return material;
      return localStorage.getItem('studio_theme')||localStorage.getItem('canvas_theme')||'graphite';
    }catch{return 'graphite';}
  }
  function paint(){const value=selectedTheme();root.classList.toggle('studio-graphite',value==='graphite');root.classList.toggle('studio-milk',value==='milk');select.value=value;root.style.colorScheme=['graphite','dark'].includes(value)?'dark':'light';}
  select.replaceChildren(...[['graphite','炭灰暖金'],['milk','牛奶白'],['light','浅色'],['dark','深色']].map(([value,label])=>new Option(label,value)));
  select.onchange=()=>{
    const value=select.value;
    try{if(['graphite','milk'].includes(value))localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}
    if(['dark','light'].includes(value)){window.StudioTheme.set(value);if(parent!==window)parent.postMessage({type:'studio-theme',theme:value},location.origin);}
    paint();
  };
  window.addEventListener('storage',paint);window.addEventListener('studio-theme-change',paint);paint();
  const nav=document.querySelector('.settings-top nav');nav.setAttribute('role','tablist');
  function tabs(){nav.querySelectorAll('[data-tab]').forEach(button=>{button.setAttribute('role','tab');button.tabIndex=button.getAttribute('aria-selected')==='true'?0:-1;const panel=document.getElementById(button.dataset.tab+'Panel');if(panel){button.id=button.id||'settingsTab-'+button.dataset.tab;button.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);}});}
  nav.addEventListener('click',()=>queueMicrotask(tabs));
  nav.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!event.target.matches('[role=tab]'))return;
    const buttons=[...nav.querySelectorAll('[data-tab]')],index=buttons.indexOf(event.target);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    event.preventDefault();buttons[next].click();buttons[next].focus();tabs();
  });
  tabs();window.StudioSettingsV2=Object.freeze({ready:true});
})();
