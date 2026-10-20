/* One settings navigator owns visibility; native forms keep their handlers and state. */
(() => {
  'use strict';
  const nav = document.querySelector('.settings-top nav');
  if (!nav) return;
  const root = document.documentElement;
  root.classList.add('studio-settings-sidebar');
  nav.setAttribute('aria-orientation', 'vertical');
  const dreamina=nav.querySelector('[data-tab="dreamina"]');
  if(dreamina)nav.insertBefore(dreamina,nav.querySelector('[data-tab="storage"]'));
  const form = document.getElementById('apiForm'), modelManager = document.getElementById('modelManager');
  const intro = document.querySelector('#apiPanel .intro');
  const originalIntro = {title:intro.querySelector('h1').textContent, text:intro.querySelector('p').textContent};
  const connectionCards = document.querySelector('.studio-connection-cards');
  const dirtyNote = document.createElement('p');
  dirtyNote.className = 'settings-unsaved-note'; dirtyNote.hidden = true; dirtyNote.setAttribute('role', 'status');
  dirtyNote.textContent = '连接设置有未保存的修改，切换分类会保留。';
  document.querySelector('.settings-top').append(dirtyNote);
  let active = 'api';
  const buttons = () => [...nav.querySelectorAll('[data-tab]')];
  function paint(tab) {
    if (!buttons().some(button => button.dataset.tab === tab)) tab = 'api';
    active = tab; root.dataset.settingsTab = tab;
    for (const panel of document.querySelectorAll('main > section')) {
      const shown = panel.id === (['api','models'].includes(tab) ? 'apiPanel' : tab + 'Panel');
      panel.hidden = !shown;
    }
    for (const button of buttons()) {
      const selected = button.dataset.tab === tab;
      button.id ||= 'settingsTab-' + button.dataset.tab;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      button.setAttribute('aria-controls', ['api','models'].includes(button.dataset.tab) ? 'apiPanel' : button.dataset.tab + 'Panel');
    }
    const panel = document.getElementById(['api','models'].includes(tab) ? 'apiPanel' : tab + 'Panel');
    if (panel) { panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby','settingsTab-' + tab); }
    const models = tab === 'models';
    modelManager.hidden = !models;
    // Keep the model controls inside apiForm: native locking, sync, and preferences
    // continue to address the exact same elements, including disabled states.
    for (const child of form.children) {
      if (child === modelManager) continue;
      child.classList.toggle('settings-model-view-hidden', models && child !== form.firstElementChild && child.id !== 'apiResult');
    }
    connectionCards.hidden = models;
    const account=document.getElementById('settingsAccountConnection');if(account)account.hidden=models;
    intro.querySelector('h1').textContent = models ? '模型' : originalIntro.title;
    intro.querySelector('p').textContent = models ? '连接成功后自动同步可用模型；启停与移除会保留到下次同步。' : originalIntro.text;
    document.querySelector('.settings-model-connection')?.remove();
    if (models) {
      const note = document.createElement('div'); note.className = 'settings-model-connection';
      const text = document.createElement('span'); text.textContent = '当前平台的模型与能力';
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '重新同步';
      refresh.onclick = () => document.getElementById('fetchModels').click();
      note.append(text, refresh); modelManager.before(note);
    }
    const dirty = window.StudioSettingsFormState?.();
    dirtyNote.hidden = !(dirty?.dirty || dirty?.storageDirty);
    window.dispatchEvent(new CustomEvent('studio:settings-tab', {detail:{tab}}));
  }
  function open(tab, click = true) {
    const button = buttons().find(button => button.dataset.tab === tab);
    if (click && button) { button.click(); return; }
    paint(tab);
  }
  // Some optional native tabs use capture handlers and stop propagation. Capture
  // the intended tab before them and apply the common visibility after they run.
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-tab]'); if (!button) return;
    // Trusted pointer events may run microtasks between capture and target.
    // A task runs after all legacy target handlers, including Dreamina capture.
    setTimeout(() => paint(button.dataset.tab), 0);
  }, true);
  nav.addEventListener('keydown', event => {
    if (!['ArrowDown','ArrowUp'].includes(event.key) || !event.target.closest('[data-tab]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const list=buttons(), index=list.indexOf(event.target.closest('[data-tab]'));
    const next=list[(index + (event.key==='ArrowDown'?1:-1) + list.length)%list.length];
    next.click(); next.focus();
  }, true);
  form.addEventListener('input', () => queueMicrotask(() => { dirtyNote.hidden = !window.StudioSettingsFormState?.().dirty; }));
  const storage = document.getElementById('storagePanel'), legacy = document.getElementById('storageForm')?.closest('details');
  if (storage && legacy) storage.append(legacy);
  const projectStorage = document.getElementById('studioProjectStorage');
  if (storage && projectStorage) storage.insertBefore(projectStorage, legacy);
  document.getElementById('openComfyEngine')?.addEventListener('click', () => window.StudioLocalEngine?.open());
  document.querySelectorAll('[data-open-settings]').forEach(button => button.addEventListener('click', () => open(button.dataset.openSettings)));
  window.StudioSettingsNavigation = Object.freeze({open, get active(){return active;}});
  paint(new URLSearchParams(location.search).get('tab') || 'api');
  const optionalTabsReady=()=>{
    const optional=nav.querySelector('[data-tab="dreamina"]');
    if(optional)nav.insertBefore(optional,nav.querySelector('[data-tab="storage"]'));
    paint(active);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',optionalTabsReady,{once:true});else optionalTabsReady();
})();
