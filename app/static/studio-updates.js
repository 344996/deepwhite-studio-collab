(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const messages = {
    source: '源码运行版：请通过 Git 更新，自动安装需要 Windows 独立发行包。',
    unchecked: '尚未检查更新。', latest: '当前已是此通道最新版本。', available: '有新版本，可以先下载再安装。',
    downloading: '正在下载并校验更新包…', verifying: '正在检查包内版本和文件…', ready: '更新包已校验，可以安装。',
    queued: '已收到请求，正在准备重启…', stopping: '正在停止服务…', backing_up: '正在备份本机数据…',
    switching: '正在切换程序版本…', validating: '正在验证新版本能否正常启动…', installed: '更新完成。可以重新打开画布。',
    rolled_back: '已回退到可用版本，用户数据已保留。', reverted: '上次更新已回退。',
    check_failed: '检查失败，可以重试。', download_failed: '下载未完成，可以重试。', failed: '操作未完成，请查看下面的说明。',
    recovery_required: '需要恢复，请保留安装目录并查看本机 updates/server.log。'
  };
  const busy = new Set(['downloading','verifying','queued','stopping','backing_up','switching','validating']);
  let current = null, timer = null, pending = false, action = 'install', disconnectedAt = null;
  function render(value) {
    current = value;
    $('current').textContent = value.current_version || '无法读取';
    $('status').textContent = value.message || messages[value.phase] || '请检查更新状态。';
    $('error').hidden = !value.error;
    $('error').textContent = value.error || '';
    $('notes').hidden = !value.notes;
    $('notes').textContent = value.notes || '';
    const working = busy.has(value.phase) || pending || value.maintenance;
    $('check').disabled = !value.managed || working;
    $('download').hidden = !value.managed || !['available','download_failed'].includes(value.phase);
    $('download').disabled = working;
    $('install').hidden = !value.can_install;
    $('install').disabled = working;
    $('rollback').hidden = !value.can_rollback;
    $('rollback').disabled = working;
    $('progress').hidden = value.phase !== 'downloading';
    if (value.total) { $('progress').max = value.total; $('progress').value = value.bytes || 0; }
  }
  async function request(path, payload) {
    const response = await fetch('/api/studio/updates/' + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload || {})});
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '操作失败，请重试。');
    return value;
  }
  async function refresh() {
    clearTimeout(timer);
    try {
      const response = await fetch('/api/studio/updates/status', {cache:'no-store'});
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail || '读取更新状态失败。');
      disconnectedAt = null; render(value);
    } catch (error) {
      if (current && busy.has(current.phase)) {
        disconnectedAt ||= Date.now();
        $('status').textContent = Date.now() - disconnectedAt < 120000 ? '服务正在重启，正在等待连接恢复…' : '服务尚未恢复，请重新运行 Start.cmd 并查看启动日志。';
      } else { $('error').hidden = false; $('error').textContent = error.message; }
    } finally { timer = setTimeout(refresh, current && (busy.has(current.phase) || current.maintenance) ? 1500 : 8000); }
  }
  async function perform(operation, payload) {
    pending = true; if (current) render(current);
    try {
      await request(operation, payload);
      if (operation === 'install' && current) current.phase = 'queued';
      pending = false; await refresh();
    } catch (error) {
      pending = false; if (current) render(current);
      $('error').hidden = false; $('error').textContent = error.message;
    }
  }
  $('check').addEventListener('click', () => perform('check'));
  $('download').addEventListener('click', () => perform('download'));
  function confirm(selected) {
    action = selected; $('saved').checked = false; $('confirmAction').disabled = true;
    $('confirmTitle').textContent = selected === 'rollback' ? '回退程序并保留当前数据' : '安装并重启画布';
    $('confirmAction').textContent = selected === 'rollback' ? '开始回退' : '开始安装';
    $('confirm').showModal();
  }
  $('install').addEventListener('click', () => confirm('install'));
  $('rollback').addEventListener('click', () => confirm('rollback'));
  $('saved').addEventListener('change', () => { $('confirmAction').disabled = !$('saved').checked; });
  $('confirm').addEventListener('close', () => {
    if ($('confirm').returnValue === 'confirm' && $('saved').checked) perform('install', {action, saved_and_closed:true});
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer); if (!document.hidden) refresh();
  });
  refresh();
})();
