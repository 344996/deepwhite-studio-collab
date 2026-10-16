/* Branding only. The original canvas engine and interaction handlers are unchanged. */
(() => {
  const prefixTitle = () => {
    if (!document.title.includes('深白片场')) document.title = `${document.title.replace(/\s*[·|]?\s*DeepWhite Studio/g, '').trim()} · 深白片场`;
  };
  prefixTitle();
  new MutationObserver(prefixTitle).observe(document.querySelector('title'), {childList:true,subtree:true,characterData:true});
  const sidebar = document.querySelector('.ws-sidebar');
  if (sidebar) {
    const brand = document.createElement('div');
    brand.className = 'studio-brand-bar';
    brand.innerHTML = '<img src="/static/studio-mark.svg" alt=""><span>深白片场<small>创作工作台</small></span>';
    sidebar.prepend(brand);
    const link = document.createElement('a');
    link.href = '/preview'; link.className = 'studio-review-link'; link.textContent = '查看节点交互稿';
    document.querySelector('.ws-topbar-right')?.prepend(link);
  }
  const back = document.querySelector('.smart-back');
  if (back) {
    back.setAttribute('aria-label', '返回深白片场工作台');
    const mark = document.createElement('img');
    mark.src = '/static/studio-mark.svg'; mark.alt = '深白片场'; mark.width = 22; mark.height = 22;
    back.prepend(mark);
  }
  // Settings stay in a modal so the live canvas and unsaved edits remain mounted.
  if (sidebar || back || document.querySelector('#quickToolbar')) {
    const button = document.createElement('button');
    button.type = 'button'; button.id = 'studioSettingsButton';
    button.className = 'studio-settings-button'; button.textContent = '⚙ 设置 / API';
    button.title = 'API 密钥、连接测试、模型与基础设置';
    const host = document.querySelector('#quickToolbar .toolbar-fixed') || document.querySelector('.ws-topbar-right');
    if (host) host.append(button);
    else { button.classList.add('studio-settings-floating'); document.body.append(button); }
    const dialog = document.createElement('dialog'); dialog.id = 'studioSettingsDialog'; dialog.setAttribute('aria-label','深白片场设置');
    const frame = document.createElement('iframe'); frame.title = 'API 与基础设置'; dialog.append(frame); document.body.append(dialog);
    function close() {
      if (!frame.contentWindow.studioCanClose || frame.contentWindow.studioCanClose()) {
        dialog.close(); frame.src = 'about:blank'; button.focus();
      }
    }
    button.onclick = event => { event.stopPropagation(); frame.src = '/settings'; dialog.showModal(); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    ['pointerdown','mousedown','dblclick','keydown','wheel'].forEach(type => dialog.addEventListener(type,event=>event.stopPropagation()));
    window.addEventListener('message', event => {
      if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === 'studio-settings-close') close();
    });
  }
})();
