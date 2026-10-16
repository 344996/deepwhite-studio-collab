(() => {
  const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-home-0927.css';document.head.append(css);
  const bar=document.querySelector('.home-section-title'),views=document.createElement('div');views.className='studio-home-views';
  let mode=localStorage.getItem('studio:home:view')==='list'?'list':'grid';
  for(const [value,label] of [['grid','网格视图'],['list','列表视图']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.view=value;
    button.onclick=()=>{mode=value;localStorage.setItem('studio:home:view',value);refresh();};views.append(button);
  }
  bar?.append(views);
  const search=document.createElement('input');search.type='search';search.placeholder='搜索项目文件夹';search.setAttribute('aria-label','搜索项目文件夹');search.className='studio-project-search';
  projectListEl.before(search);
  function filterProjects(){const query=search.value.trim().toLowerCase();projectListEl.querySelectorAll('.ws-project-row').forEach(el=>{el.hidden=!el.querySelector('.ws-project-name').textContent.toLowerCase().includes(query);});}
  search.oninput=filterProjects;
  const prior=renderProjects;renderProjects=(...args)=>{const result=prior(...args);filterProjects();return result;};
  function refresh(){document.body.classList.toggle('studio-home-list',mode==='list');views.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===mode)));}
  refresh();
})();
