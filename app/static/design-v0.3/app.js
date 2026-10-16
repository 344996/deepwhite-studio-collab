(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  $('#design-theme').onchange=e=>{document.documentElement.dataset.theme=e.target.value;};
  const toastEl = $('#toast');
  let toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  // Route between the self-contained preview sections without leaving the page.
  const pageTitles = {home:'项目概览',canvas:'创作画布',assets:'资产库',tools:'制作工具',settings:'设置账户'};
  function go(page) {
    if (!pageTitles[page]) return;
    $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
    $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    $('#top-title').textContent = pageTitles[page];
    $('#node-menu').hidden = true;
    window.scrollTo({top:0,behavior:'smooth'});
  }
  $$('.nav-item').forEach(el => el.addEventListener('click', () => go(el.dataset.page)));
  $$('[data-goto]').forEach(el => el.addEventListener('click', () => go(el.dataset.goto)));
  $$('.recent-card').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('canvas'); } }));
  $$('[data-toast]').forEach(el => el.addEventListener('click', () => toast(el.dataset.toast)));

  // Canvas node menu and example nodes.
  const nodeMenu = $('#node-menu');
  $('#add-node-menu').addEventListener('click', () => { nodeMenu.hidden = !nodeMenu.hidden; });
  document.addEventListener('click', e => { if (!nodeMenu.contains(e.target) && e.target !== $('#add-node-menu')) nodeMenu.hidden = true; });
  let addedCount = 0;
  const nodeExamples = {
    text:['≋','镜头补充 · 未命名文本','双击即可继续编辑文本'],
    image:['▧','参考图片 · 新增素材','图片节点 ID n-demo-'],
    video:['▶','视频镜头 · 新增草案','待补充素材与关键帧'],
    audio:['♫','音频片段 · 港口雨声','环境音 · 演示素材']
  };
  function addNode(kind, titleOverride) {
    const data = nodeExamples[kind] || nodeExamples.text;
    addedCount++;
    const card = document.createElement('div');
    card.className = 'added-node';
    card.dataset.nodeId = `n-demo-${String(addedCount).padStart(2,'0')}`;
    const title = document.createElement('b');
    const type = document.createElement('span');
    type.className = 'added-type';
    type.textContent = data[0];
    title.append(type, document.createTextNode(titleOverride || data[1]));
    const detail = document.createElement('small');
    detail.textContent = `${data[2]}${String(addedCount).padStart(2,'0')}`;
    card.append(title, detail);
    $('#canvas-node-list').append(card);
    toast(`已添加示例节点 ${card.dataset.nodeId}（非资产 ID）`);
    nodeMenu.hidden = true;
    return card;
  }
  $$('[data-add-node]').forEach(el => el.addEventListener('click', () => addNode(el.dataset.addNode)));

  // Modal templates are static local markup. No network or model calls are made.
  const backdrop = $('#modal-backdrop');
  const modalContent = $('#modal-content');
  function openModal(content) {
    modalContent.innerHTML = content;
    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#modal-close').focus();
  }
  function closeModal() { backdrop.hidden = true; document.body.style.overflow = ''; }
  $('#modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); $('#agent-drawer').classList.remove('open'); $('#agent-drawer').setAttribute('aria-hidden','true'); nodeMenu.hidden = true; } });

  const characterSrc = '../design-review/assets/character-v1.png';
  const standardSrc = '../examples/standard-character.png';
  const sceneSrc = '../design-review/assets/scene-v1.png';
  const propsSrc = '../design-review/assets/props-v1.png';
  function characterModal(standard = false) {
    const image = standard ? standardSrc : characterSrc;
    const heading = standard ? '标准设定 · 构图案例' : '顾言 · 人物处理';
    openModal(`<div class="eyebrow">${standard?'STANDARD LAYOUT / EXAMPLE':'CHARACTER ASSET / DW-CHAR-0042'}</div><h2 id="modal-title">${heading}</h2><p class="modal-subtitle">${standard?'示意素材，不代表顾言的人物生成结果。':'稳定资产 ID DW-CHAR-0042 · 当前版本 v1.3 · 此节点为 n-01'}</p><div class="modal-layout"><div class="modal-preview ${standard?'standard-preview':''}"><img src="${image}" alt="${heading}预览"><span class="preview-caption">${standard?'标准设定构图案例 · 示例人物':'顾言 · 当前人物参考'}</span></div><div class="modal-controls"><h3>${standard?'构图说明':'人物处理'}</h3>${standard?'<div class="modal-note">灰底三联排版案例：左侧为 45° 头颈特写，中间为正面无头全身，右侧为完整背面。图中人物仅作版式示意。</div><button class="button outline small" id="back-character">返回人物处理</button>':'<button class="modal-action" data-char-action="standard"><span>≋</span><b>灰底标准设定<small>45° 头颈特写、正面无头全身、完整背面</small></b></button><button class="modal-action" data-char-action="wardrobe"><span>◈</span><b>换装<small>保留人物身份，替换服装与配饰</small></b></button><button class="modal-action" data-char-action="edit"><span>✎</span><b>编辑<small>调整描述与局部设定</small></b></button><button class="modal-action" data-char-action="hd"><span>↗</span><b>高清<small>输出高清修复演示状态</small></b></button><button class="modal-action" data-char-action="compare"><span>⇄</span><b>版本对比<small>并排查看 v1.2 与 v1.3</small></b></button>'}</div></div><div class="modal-foot"><span>操作均为本地演示，不调用模型</span><span>来源：${standard?'静态构图案例':'人物草案 · 林制作人'}</span></div>`);
    if (standard) { $('#back-character').addEventListener('click', () => characterModal(false)); return; }
    $$('[data-char-action]', modalContent).forEach(btn => btn.addEventListener('click', () => {
      const action = btn.dataset.charAction;
      const labels = {standard:'灰底标准设定',wardrobe:'换装',edit:'编辑',hd:'高清处理'};
      if (action === 'compare') {
        openModal(`<div class="eyebrow">VERSION COMPARE</div><h2 id="modal-title">顾言 · 版本对比</h2><p class="modal-subtitle">同一稳定资产 DW-CHAR-0042 的版本对比布局 · 两侧使用同一示意图</p><div class="modal-layout"><div class="modal-preview"><img src="${characterSrc}" alt="顾言 v1.2"><span class="preview-caption">v1.2 · 2026.09.14</span></div><div class="modal-preview"><img src="${characterSrc}" alt="顾言 v1.3"><span class="preview-caption">v1.3 · 当前版本 · 已确认</span></div></div><div class="modal-foot"><span>节点 ID n-01 与资产 ID 分开记录</span><button class="button outline small" id="compare-done">完成</button></div>`);
        $('#compare-done').addEventListener('click', closeModal);
      } else if (action === 'standard') {
        openModal(`<div class="eyebrow">STANDARD LAYOUT / EXAMPLE</div><h2 id="modal-title">标准设定 · 构图案例</h2><p class="modal-subtitle">示意素材，不代表顾言的人物生成结果</p><div class="modal-layout"><div class="modal-preview standard-preview"><img src="${standardSrc}" alt="标准设定构图案例示意"><span class="preview-caption">标准设定构图案例 · 示例人物</span></div><div class="modal-controls"><h3>构图说明</h3><div class="modal-note">灰底三联排版案例：左侧为 45° 头颈特写，中间为正面无头全身，右侧为完整背面。图中人物仅作版式示意。</div><button class="button outline small" id="back-character">返回人物处理</button></div></div>`);
        $('#back-character').addEventListener('click', () => characterModal(false));
      } else {
        openModal(`<div class="eyebrow">CHARACTER ACTION / DEMO</div><h2 id="modal-title">${labels[action] || '人物处理'}</h2><p class="modal-subtitle">这是交互状态演示，不会向模型提交请求</p><div class="modal-layout"><div class="modal-preview"><img src="${characterSrc}" alt="顾言人物图"><span class="preview-caption">输入资产 · 顾言 v1.3</span></div><div class="modal-controls"><h3>${labels[action] || '处理选项'}</h3>${action==='wardrobe'?'<label class="modal-note">服装描述<textarea class="modal-prompt" aria-label="换装描述">深色防雨风衣，衣领略湿，保持顾言面部与发型一致。</textarea></label>':action==='edit'?'<label class="modal-note">人物描述<textarea class="modal-prompt" aria-label="编辑人物描述">顾言，28岁，沉静克制，深色短发。</textarea></label>':`<div class="modal-note">${action==='hd'?'预览高清处理选项：提升细节与清晰度。':'灰底标准设定可保留当前服装，也可另建候选版本。'}</div>`}<button class="button primary small" id="apply-char-action">${action==='edit'?'保存演示修改':'预览处理选项'}</button></div></div>`);
        $('#apply-char-action').addEventListener('click', () => { toast(`${labels[action]}演示已记录为候选操作`); closeModal(); });
      }
    }));
  }
  function sceneModal() {
    openModal(`<div class="eyebrow">LOCATION ASSET / DW-LOC-0018</div><h2 id="modal-title">雨夜 · 旧港口</h2><p class="modal-subtitle">场景资产 DW-LOC-0018 · 节点 n-03 · 外景 / 夜 / 暴雨初歇</p><div class="modal-tabs" role="tablist"><button class="active" data-scene-tab="angles">反向角度</button><button data-scene-tab="panorama">360 环境全景</button><button data-scene-tab="redraw">线稿与色块</button></div><div id="scene-tab-content"><div class="modal-note">查看同一场景的机位方向，用来规划人物走位与反打镜头。</div><div class="angle-grid"><button><img src="${sceneSrc}" alt="正向机位"><span>正向 · 仓库门</span></button><button><img src="${sceneSrc}" alt="反向机位"><span>反向 · 港池方向</span></button><button><img src="${sceneSrc}" alt="侧向机位"><span>侧向 · 栈桥边缘</span></button></div></div><div class="modal-foot"><span>所有角度均为同一示例场景图</span><span>场景版本 v1.1 · 已确认</span></div>`);
    $$('[data-scene-tab]', modalContent).forEach(btn => btn.addEventListener('click', () => {
      $$('[data-scene-tab]', modalContent).forEach(tab => tab.classList.toggle('active', tab === btn));
      const target = $('#scene-tab-content');
      if (btn.dataset.sceneTab === 'panorama') target.innerHTML = `<div class="modal-note">环境全景浏览状态 · 360° 控件为演示示意</div><div class="panorama"><img src="${sceneSrc}" alt="雨夜港口环境全景示意"><span>拖动查看环境 · 360° 全景规划中</span></div>`;
      else if (btn.dataset.sceneTab === 'redraw') target.innerHTML = `<div class="modal-note">场景重绘预览选项：以线稿锁定空间结构，或用色块探索光线与主色。此版本仅展示状态。</div><div class="angle-grid"><button><img src="${sceneSrc}" alt="场景结构线稿示意"><span>线稿结构</span></button><button><img src="${sceneSrc}" alt="场景色块示意"><span>色块氛围</span></button><button><img src="${sceneSrc}" alt="场景原图"><span>原始参考</span></button></div>`;
      else target.innerHTML = `<div class="modal-note">查看同一场景的机位方向，用来规划人物走位与反打镜头。</div><div class="angle-grid"><button><img src="${sceneSrc}" alt="正向机位"><span>正向 · 仓库门</span></button><button><img src="${sceneSrc}" alt="反向机位"><span>反向 · 港池方向</span></button><button><img src="${sceneSrc}" alt="侧向机位"><span>侧向 · 栈桥边缘</span></button></div>`;
    }));
  }
  function videoModal() {
    openModal(`<div class="eyebrow">VIDEO SHOT / NODE n-04</div><h2 id="modal-title">镜头 01 · 顾言走向仓库</h2><p class="modal-subtitle">当前镜头节点引用人物 DW-CHAR-0042 与场景 DW-LOC-0018</p><div class="modal-layout"><div class="modal-preview"><img src="${sceneSrc}" alt="视频镜头关键帧"><span class="preview-caption">首帧 · 00:00 · 16:9 · 6 秒</span></div><div class="modal-controls"><h3>提示词草案</h3><textarea class="modal-prompt" aria-label="视频镜头提示词">@顾言 从画面左侧走向雨夜港口旧仓库，停在门前，克制地抬眼确认门牌。镜头缓慢跟随，雨水沿屋檐滴落。中景，6秒。</textarea><h3>引用素材</h3><div class="modal-note">@顾言 <small>DW-CHAR-0042 · v1.3</small><br>@雨夜旧港口 <small>DW-LOC-0018 · v1.1</small></div><h3>关键帧</h3><div class="video-keyframes"><div><img src="${sceneSrc}" alt="镜头首帧"><small>00:00 首帧</small></div><div><img src="${sceneSrc}" alt="镜头中间帧"><small>00:03 中间帧</small></div><div><img src="${sceneSrc}" alt="镜头尾帧"><small>00:06 尾帧</small></div></div></div></div><div class="modal-foot"><span>视频生成与关键帧编辑均为静态演示</span><button class="button outline small" id="video-save">保存镜头草案</button></div>`);
    $('#video-save').addEventListener('click', () => { toast('镜头草案已保存到本地演示状态'); closeModal(); });
  }
  $$('.canvas-node[data-open-modal]').forEach(el => {
    const open = () => { const type = el.dataset.openModal; type === 'character' ? characterModal() : type === 'standard' ? characterModal(true) : type === 'scene' ? sceneModal() : videoModal(); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  // Model and generation controls only show local settings and a demo message.
  const modelFamilies={'Seedance':['Seedance 2.5','Seedance 2.0 Fast'],'Veo':['Veo 3','Veo 3 Fast']};
  function modelMenu(family='Seedance') {
    openModal(`<div class="eyebrow">MODEL SELECT / DEMO</div><h2 id="modal-title">选择模型</h2><p class="modal-subtitle">DeepWhite API · 系列 → 版本。静态示例，真实选项以已启用模型为准。</p><div class="modal-layout"><div class="modal-controls">${Object.keys(modelFamilies).map(f=>`<button class="modal-action" data-model-family="${f}">${f} ›</button>`).join('')}</div><div class="modal-controls">${modelFamilies[family].map(m=>`<button class="modal-action" data-model="${m}">${m}</button>`).join('')}</div></div><div class="modal-foot">未连接 · 金额仅为演示，不是实时价格</div>`);
  }
  $('#model-select').addEventListener('click',()=>modelMenu());
  document.addEventListener('click',e=>{const f=e.target.closest('[data-model-family]');if(f)modelMenu(f.dataset.modelFamily);});
  document.addEventListener('click', e => {
    const item = e.target.closest('[data-model]');
    if (item) { $('#model-select').innerHTML = `${item.dataset.model} <small>⌄</small>`; closeModal(); toast(`已选择演示模型：${item.dataset.model}`); }
  });
  $('#param-open').addEventListener('click', () => openModal(`<div class="eyebrow">SHOT PARAMETERS / DEMO</div><h2 id="modal-title">视频参数</h2><p class="modal-subtitle">调整当前镜头展示参数；不会调用模型</p><div class="field-grid"><label>画幅<select id="demo-aspect"><option>竖屏 9:16</option><option>横屏 16:9</option><option>方形 1:1</option></select></label><label>时长<select id="demo-duration"><option>6 秒</option><option>8 秒</option><option>10 秒</option></select></label><label>清晰度<select><option>1080p · 演示</option><option>720p · 演示</option></select></label><label>镜头节奏<select><option>自然叙事</option><option>缓慢克制</option><option>快速推进</option></select></label></div><div class="modal-foot"><span>演示预估固定显示为 ¥ 1.80</span><button class="button primary small" id="save-params">应用参数</button></div>`));
  document.addEventListener('click', e => { if (e.target.id === 'save-params') { $('#param-open').innerHTML = `${$('#demo-aspect').value} <span>·</span> ${$('#demo-duration').value} <small>⌄</small>`; closeModal(); toast('视频参数已更新为演示状态'); } });
  $('#generate-demo').addEventListener('click', () => openModal(`<div class="eyebrow">GENERATION PREVIEW / NO MODEL CALL</div><h2 id="modal-title">演示生成确认</h2><p class="modal-subtitle">这是静态演示操作，不会调用模型，也不会扣费。</p><div class="modal-note">镜头：顾言走向仓库 · ${$('#model-select').textContent}<br>参数：${$('#param-open').textContent}<br>演示预估：¥ 1.80（不会实际扣费）</div><div class="modal-foot"><span>点击后只显示演示完成状态</span><button class="button primary small" id="confirm-demo-generation">继续演示</button></div>`));
  document.addEventListener('click', e => { if (e.target.id === 'confirm-demo-generation') { closeModal(); toast('演示已完成：没有调用模型或扣费'); } });

  // Asset filters and local confirmation, citation, and version interactions.
  let category = 'all';
  function filterAssets() {
    const status = $('#asset-status').value;
    const term = $('#asset-search').value.trim().toLowerCase();
    let shown = 0;
    $$('.asset-card').forEach(card => {
      const matches = (category === 'all' || card.dataset.category === category) && (status === 'all' || card.dataset.status === status) && (!term || `${card.dataset.name} ${card.dataset.assetId}`.toLowerCase().includes(term));
      card.hidden = !matches;
      if (matches) shown++;
    });
    $('#asset-empty').hidden = shown > 0;
  }
  $$('.category-tab').forEach(btn => btn.addEventListener('click', () => { category = btn.dataset.category; $$('.category-tab').forEach(tab => tab.classList.toggle('active', tab === btn)); filterAssets(); }));
  $('#asset-status').addEventListener('change', filterAssets);
  $('#asset-search').addEventListener('input', filterAssets);
  $('#clear-filters').addEventListener('click', () => { category='all'; $('#asset-status').value='all'; $('#asset-search').value=''; $$('.category-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.category==='all')); filterAssets(); });
  $('#folder-view-toggle').addEventListener('click', () => { $('#folder-strip').hidden = !$('#folder-strip').hidden; $('#folder-view-toggle').classList.toggle('active', !$('#folder-strip').hidden); });
  $$('[data-folder]').forEach(btn => btn.addEventListener('click', () => { category = btn.dataset.folder === '全部' ? 'all' : btn.dataset.folder; $$('.category-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.category===category)); filterAssets(); }));
  $('#asset-grid').addEventListener('click', e => {
    const action = e.target.closest('[data-asset-action]');
    if (!action) return;
    const card = action.closest('.asset-card');
    const id = card.dataset.assetId;
    if (action.dataset.assetAction === 'confirm') {
      card.dataset.status = '已确认';
      card.querySelector('.candidate-mark').className = 'approved-mark';
      card.querySelector('.approved-mark').textContent = '✓ 已确认';
      action.textContent = '已确认此版本';
      action.disabled = true;
      toast(`${card.dataset.name} v0.2 已确认 · 资产 ${id}`);
      filterAssets();
    } else if (action.dataset.assetAction === 'use') {
      addNode(card.dataset.category === '场景' ? 'image' : 'image', `${card.dataset.name} · 资产引用`);
      const created = $('#canvas-node-list').lastElementChild;
      created.dataset.assetId = id;
      created.querySelector('small').textContent = `资产 ${id} · 节点 ${created.dataset.nodeId}`;
      toast(`${card.dataset.name} 已引用到画布 · 资产 ID ${id}，节点 ID ${created.dataset.nodeId}`);
      go('canvas');
    } else if (action.dataset.assetAction === 'versions') {
      openModal(`<div class="eyebrow">ASSET VERSIONS</div><h2 id="modal-title">${card.dataset.name} · 版本记录</h2><p class="modal-subtitle">稳定资产 ID ${id} · 节点 ID 独立管理</p><div class="mapping-list"><div class="mapping-row"><span class="mapping-icon">✓</span><span><b>v1.3 · 当前确认版本</b><small>人物设定 · 林制作人 · 2026.09.24</small></span><span class="mapping-status">已确认</span></div><div class="mapping-row"><span class="mapping-icon">◷</span><span><b>v1.2 · 历史版本</b><small>上一个已确认版本 · 2026.09.14</small></span><span class="mapping-status">历史</span></div><div class="mapping-row"><span class="mapping-icon">↗</span><span><b>来源记录</b><small>来自画布节点引用，节点 ID 不作为资产 ID</small></span><span class="mapping-status">可追溯</span></div></div>`);
    }
  });
  $('#asset-add').addEventListener('click', () => { toast('新建资产将在真实资产工作流中开放'); });

  // RH mapping demo uses only local input values and keeps no secrets.
  $('#rh-add').addEventListener('click', () => {
    const name = $('#rh-name').value.trim() || '未命名应用';
    const id = $('#rh-id').value.trim() || '未填写（仅演示）';
    const site = $('#rh-site').value;
    const inputText = $('#rh-text-field').value;
    const inputImage = $('#rh-image-field').value;
    const output = $('#rh-output-field').value;
    const row = document.createElement('div');
    row.className = 'mapping-row';
    const icon = document.createElement('span'); icon.className='mapping-icon'; icon.textContent='⇄';
    const description = document.createElement('span');
    const title = document.createElement('b'); title.textContent = `${name} · ${inputText.split(' ')[0]} / ${inputImage.split(' ')[0]} → ${output.split(' ')[0]}`;
    const detail = document.createElement('small'); detail.textContent = `${site} · ${id} · 演示映射，未连接`;
    description.append(title, detail);
    const state = document.createElement('span'); state.className='mapping-status'; state.textContent='未连接';
    row.append(icon, description, state);
    $('#mapping-list').prepend(row);
    toast(`已添加 RunningHub 演示映射：${inputText.split(' ')[0]} / ${inputImage.split(' ')[0]} → ${output.split(' ')[0]}`);
  });
  $('#rh-test').addEventListener('click', () => toast('模拟连接完成：未连接站点，未使用凭证，也未发送请求'));

  // Agent presents a proposed plan before adding two example nodes.
  const drawer = $('#agent-drawer');
  $('#agent-open').addEventListener('click', () => { drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); $('#agent-description').focus(); });
  $('#agent-close').addEventListener('click', () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); });
  $('#agent-preview').addEventListener('click', () => { $('#agent-preview-box').hidden = false; toast('已生成本地演示草案，请检查拟建节点'); });
  $('#agent-apply').addEventListener('click', () => { go('canvas'); addNode('video','镜头节点 · 仓库入口'); addNode('audio','音频节点 · 港口雨声'); drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); toast('已应用两个示例节点；没有调用 Agent 服务'); });

  $('#check-update').addEventListener('click', () => { $('#update-result').hidden = false; toast('模拟检查完成：当前预览已是最新版本'); });
})();
