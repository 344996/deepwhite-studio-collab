(() => {
  document.body.classList.add('studio-home');
  document.querySelector('.studio-review-link')?.remove();
  const main=document.querySelector('.ws-main');
  const intro=document.createElement('section');intro.className='home-intro';
  intro.innerHTML=`<div class="home-heading"><small>深白片场</small><h1>继续你的创作。</h1><p>自由组织人物、场景与道具，让想法成为可用的资产。</p></div><div class="home-overview"><div class="home-welcome"><div class="home-floating"><img src="/static/design-review/assets/scene-v1.png" alt="场景示意图"><img src="/static/design-review/assets/character-v1.png" alt="人物多视图示意图"></div><h2>灵感就绪，开始创作。</h2><p>从一张角色图，到一个完整的故事世界。</p><button class="ws-primary-btn" id="homeCreate">＋ 新建画布</button></div><div class="home-wallet"><span>DeepWhite 钱包</span><strong>¥ —</strong><small>账户可用余额</small><p>余额查询尚未接入，请前往 API 网站查看。</p><button id="homeApi">设置 / API</button><a href="https://api.deepwhiteai.com/" target="_blank" rel="noopener noreferrer">前往账户 ↗</a></div></div><div class="home-section-title"><h2>项目画布</h2><input id="homeSearch" placeholder="搜索当前项目的画布" aria-label="搜索画布"></div>`;
  document.querySelector('.ws-topbar').after(intro);
  intro.querySelector('#homeCreate').onclick=()=>newCanvasBtn.click();
  const assets=document.createElement('button');assets.className='ws-primary-btn';assets.textContent='项目资产';assets.style.marginLeft='10px';
  assets.onclick=()=>location.href='/static/studio-assets.html?project_id='+encodeURIComponent(currentProjectId||'default');
  intro.querySelector('#homeCreate').after(assets);
  intro.querySelector('#homeApi').onclick=()=>document.getElementById('studioSettingsButton').click();
  const demos=document.createElement('section');demos.className='home-demos';demos.innerHTML=`<h2>为资产创作准备的工具</h2><p>功能展示 · 在画布中选择图片或视频使用。以下为 AI 生成的示意素材。</p><div class="home-demo-grid"><article><img src="/static/design-review/assets/character-v1.png" alt="人物设定示意"><b>人物设定 · 灰底多视图</b></article><article><img src="/static/design-review/assets/props-v1.png" alt="图片编辑示意"><b>图片编辑 · 细节调整</b></article><article><img src="/static/design-review/assets/scene-v1.png" alt="关键帧示意"><b>视频素材 · 截取关键帧</b></article></div>`;board.after(demos);
  board.removeEventListener('mousedown',onBoardPanStart);board.removeEventListener('wheel',onBoardWheel);
  attachCardDrag=(card,c)=>{card.tabIndex=0;card.setAttribute('role','link');card.addEventListener('click',e=>{if(!e.target.closest('button,input,.ws-card-delete-confirm'))openCanvas(c);});card.addEventListener('keydown',e=>{if(e.target===card&&e.key==='Enter')openCanvas(c);});};
  const original=buildCard;buildCard=c=>{const card=original(c);const cover=document.createElement('div');cover.className='home-canvas-cover';cover.innerHTML='<span>◇</span><small>DEEPWHITE CANVAS</small>';card.prepend(cover);return card;};
  const filter=()=>{const q=document.getElementById('homeSearch').value.trim().toLowerCase();boardWorld.querySelectorAll('.ws-card').forEach(card=>card.hidden=!card.querySelector('.ws-card-title').textContent.toLowerCase().includes(q));};
  document.getElementById('homeSearch').oninput=filter;
  const renderOriginal=renderBoard;renderBoard=()=>{renderOriginal();filter();};
  renderBoard();
  const status=document.createElement('span');status.className='home-engine';status.textContent='ComfyUI · 检查中';document.querySelector('.ws-topbar-right').prepend(status);
  async function updateEngine(){try{const r=await fetch('/api/studio/local-engine');if(!r.ok)throw Error();const data=await r.json();status.textContent='ComfyUI · '+({running:'运行中',ready:'运行中',starting:'启动中',stopped:'未开启',error:'异常'}[data.state]||'未就绪');}catch{status.textContent='ComfyUI · 无法连接';}}
  updateEngine();setInterval(()=>{if(!document.hidden)updateEngine();},30000);
})();
