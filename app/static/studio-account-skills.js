(() => {
  const style = document.createElement('style');
  style.textContent = `
  .dw-library{width:min(640px,calc(100vw - 32px));max-height:84vh;overflow:auto;border:1px solid #7775;border-radius:20px;padding:24px;background:var(--card-solid,#fff);color:var(--text,#222);box-shadow:0 24px 100px #0006}
  .dw-library [hidden]{display:none!important}.dw-library::backdrop{background:#0007}.dw-library header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.dw-library h2{margin:0;font-size:20px}
  .dw-library button,.dw-library input,.dw-skill-select{padding:9px 12px;border:1px solid #8886;border-radius:9px;background:transparent;color:inherit}.dw-library a{color:#c5a879}.dw-library input{display:block;width:100%;box-sizing:border-box;margin:10px 0}.dw-library button{cursor:pointer;margin:4px 8px 4px 0}.dw-library pre{white-space:pre-wrap;max-height:300px;overflow:auto;font:13px/1.7 monospace}.dw-library p{font-size:13px;line-height:1.7}.dw-skill-row{padding:12px 0;border-bottom:1px solid #8884;display:flex;gap:8px;align-items:center}.dw-skill-row span{flex:1}.dw-message{min-height:22px;color:#cfac79}.dw-skill-select{margin:8px 0;width:100%}.dw-skill-select option{color:#222;background:#fff}.dw-link-button{border:0!important;text-decoration:underline;padding:4px!important}.dw-balance-list{display:grid;gap:8px;margin:12px 0 20px}.dw-balance-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:12px;border:1px solid #8884;border-radius:10px}.dw-balance-row small{opacity:.72}.dw-balance-row strong{font-variant-numeric:tabular-nums}.dw-account-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;width:28px;height:28px;border-radius:50%;background:#9a895b33;overflow:hidden;margin-right:8px;flex-shrink:0}.dw-account-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.dw-account-identity{display:flex;align-items:center;gap:8px;margin-bottom:18px}.dw-account-identity .dw-account-avatar{width:44px;height:44px}.dw-account-wallet{display:flex;flex-direction:column;gap:12px;padding:24px;border:1px solid #9994;border-radius:16px;margin-bottom:20px;background:linear-gradient(140deg,#cbb68715,transparent)}.dw-account-wallet>strong{font-size:36px;font-variant-numeric:tabular-nums;letter-spacing:-1px}.dw-account-wallet>small{opacity:.75}`;
  document.head.append(style);

  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/studio/' + path, {
      method,
      headers: body ? {'Content-Type': 'application/json'} : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '操作失败，请检查输入后重试。');
    return data;
  }

  function dialog(title) {
    const element = document.createElement('dialog');
    element.className = 'dw-library';
    const head = document.createElement('header');
    const heading = document.createElement('h2');
    const close = document.createElement('button');
    heading.textContent = title;
    close.textContent = '关闭';
    close.onclick = () => element.close();
    head.append(heading, close);
    element.append(head);
    document.body.append(element);
    element.addEventListener('close', () => element.remove());
    ['pointerdown', 'mousedown', 'keydown', 'dblclick', 'wheel'].forEach(type => element.addEventListener(type, event => event.stopPropagation()));
    element.showModal();
    return element;
  }

  let account = null, skills = [];
  function providersChanged() {
    const message = {type: 'providers-changed', updated_at: Date.now()};
    window.postMessage(message, location.origin);
    window.dispatchEvent(new Event('studio-providers-changed'));
    try { const channel = new BroadcastChannel('studio-api'); channel.postMessage(message); channel.close(); } catch {}
  }
  function wallet() {
    const box = document.querySelector('.home-wallet');
    if (!box) return;
    box.querySelector('strong').textContent = account?.balance != null ? account.symbol + account.balance.toFixed(2) : '—';
    box.querySelector('p').textContent = account ? `${account.username} · ${account.balance != null ? 'API 账户余额' : '暂未获取余额换算信息'}` : '登录 DeepWhite API 账号后查看钱包余额。';
    const button = box.querySelector('#homeApi');
    if (button) { button.textContent = account ? '账户 / 刷新余额' : '登录账户'; button.onclick = openAccount; }
  }
  function avatar() {
    const element = document.createElement('span');
    element.className = 'dw-account-avatar';
    element.textContent = (account?.username || '账').slice(0, 1);
    if (account?.avatar_url) {
      const image = document.createElement('img');
      image.src = account.avatar_url;
      image.alt = '账户头像';
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => image.remove();
      element.append(image);
    }
    return element;
  }
  function paintAccount() {
    accountButton.replaceChildren();
    accountButton.setAttribute('aria-label', account?.username || '登录 / 注册');
    if (account) accountButton.append(avatar());
    accountButton.append(document.createTextNode(account?.username || '登录 / 注册'));
    wallet();
  }
  async function refresh() { try { account = await api('account'); } catch { account = null; } paintAccount(); }

  async function paintBalances(list, message) {
    list.replaceChildren();
    list.textContent = '正在读取渠道余额…';
    try {
      const result = await api('channel-balances');
      list.replaceChildren();
      for (const item of result.items || []) {
        const row = document.createElement('div');
        row.className = 'dw-balance-row';
        const name = document.createElement('span'); name.textContent = item.name;
        const amount = document.createElement('strong');
        // A currency symbol (¥, $) goes before the amount; a code or unit (CNY, 积分) after it.
        const symbol = /^[^\p{L}\p{N}]{1,3}$/u.test(item.unit || '');
        amount.textContent = item.status === 'available' && item.balance != null ? (symbol ? `${item.unit}${item.balance}` : `${item.balance} ${item.unit || ''}`.trim()) : item.status === 'unsupported' ? '未接入' : '暂不可用';
        const state = document.createElement('small'); state.textContent = item.message || (item.status === 'available' ? `更新于 ${item.updated_at}` : item.status === 'unsupported' ? '该渠道没有受支持的余额查询方式' : '余额读取失败，请稍后刷新');
        const stamp = document.createElement('small'); stamp.textContent = item.updated_at ? new Date(item.updated_at).toLocaleString() : '';
        row.append(name, amount, state, stamp); list.append(row);
      }
      if (!result.items?.length) list.textContent = '尚未配置 API 渠道。';
    } catch (error) { list.replaceChildren(); message.textContent = error.message; }
  }

  async function openAccount() {
    const d = dialog('DeepWhite API 账户');
    const body = document.createElement('div'); d.append(body);
    const message = document.createElement('p'); message.className = 'dw-message'; d.append(message);
    const links = document.createElement('p');
    links.innerHTML = '<a href="https://api.deepwhiteai.com/" target="_blank" rel="noopener">充值 / 找回密码 / 网站验证 ↗</a>';
    d.append(links);

    // Login is independent of optional provider balance requests and local editing.
    if (!account) { showLogin(body, message, d); return; }

    if (account) {
      const identity = document.createElement('div'); identity.className = 'dw-account-identity';
      const name = document.createElement('strong'); name.textContent = account.username; identity.append(avatar(), name); body.append(identity);
      const info = document.createElement('section'); info.className = 'dw-account-wallet';
      const label = document.createElement('small'); label.textContent = 'DeepWhite API 登录账户余额';
      const amount = document.createElement('strong'); amount.textContent = account.balance != null ? account.symbol + account.balance.toFixed(2) : '暂不可用';
      const hint = document.createElement('small'); hint.textContent = '与 API 网站共用账户 · 以网站账单为准';
      info.append(label, amount, hint); body.append(info);
      const generation = document.createElement('section'); generation.className = 'dw-account-wallet'; generation.dataset.generationStatus = account.generation?.status || 'action_required';
      const heading = document.createElement('strong'); heading.style.fontSize = '18px'; heading.textContent = account.generation?.status === 'ready' ? '官方 API 已连接' : '官方 API 连接';
      const detail = document.createElement('p'); detail.textContent = account.generation?.message || '账户已登录，点击重新连接可自动配置生成 API 和模型。';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = account.generation?.status === 'ready' ? '刷新授权和模型' : '重新连接官方 API';
      retry.onclick = async () => {
        retry.disabled = true; detail.textContent = '正在连接生成授权并同步模型…';
        try { const result = await api('account/provision', 'POST'); account.generation = result.generation; generation.dataset.generationStatus = result.generation.status; detail.textContent = result.generation.message; heading.textContent = result.generation.status === 'ready' ? '官方 API 已连接' : '官方 API 需要处理'; providersChanged(); }
        catch (error) { detail.textContent = error.message; }
        finally { retry.disabled = false; }
      };
      const privacy = document.createElement('small'); privacy.textContent = '生成授权属于当前账户；退出、切换账户或关闭后台后，本机停止使用该授权。网站令牌保留以便下次登录复用，可在 API 网站撤销。自选 API 不受影响。';
      generation.append(heading, detail, retry, privacy); body.append(generation);
    }

    const balanceHeading = document.createElement('strong'); balanceHeading.textContent = '配置渠道余额'; body.append(balanceHeading);
    const balanceList = document.createElement('div'); balanceList.className = 'dw-balance-list'; body.append(balanceList);
    const refreshBalances = document.createElement('button'); refreshBalances.textContent = '刷新渠道余额';
    refreshBalances.onclick = async () => { refreshBalances.disabled = true; await paintBalances(balanceList, message); refreshBalances.disabled = false; };
    body.append(refreshBalances);
    // Optional third-party balance probes must never delay account controls.
    paintBalances(balanceList, message);

    if (account) {
      const logout = document.createElement('button'); logout.textContent = '退出登录';
      logout.onclick = async () => { logout.disabled = true; try { await api('account/logout', 'POST'); await refresh(); providersChanged(); d.close(); } catch (error) { message.textContent = error.message; } finally { logout.disabled = false; } };
      body.append(logout);
      return;
    }
  }

  function showLogin(body, message, dialogElement, initialMessage = '') {
    body.replaceChildren();
    const form = document.createElement('form');
    form.innerHTML = '<input name="username" autocomplete="username" placeholder="API 网站用户名或邮箱" required maxlength="128"><input name="password" type="password" autocomplete="current-password" placeholder="密码" required maxlength="256"><input name="code" placeholder="两步验证码" autocomplete="one-time-code" hidden disabled><button type="submit">登录并连接 API</button><p>本地画布可直接使用，无需登录。登录后会为当前账户创建或复用此画布的专用生成令牌，并自动同步模型；调用按 API 网站账户余额计费。密码不保存，生成授权只保留在本次会话内，最多 12 小时。也可在设置中使用自己的其他 API。</p>';
    form.setAttribute('aria-label', 'API 网站登录');
    for (const [name, label] of [['username','用户名'],['password','密码'],['code','两步验证码']]) form.elements[name].setAttribute('aria-label', label);
    const signup = document.createElement('button'); signup.type = 'button'; signup.className = 'dw-link-button'; signup.textContent = '创建 API 账户';
    signup.onclick = async () => { try { const caps = await api('account/capabilities'); if (!caps.registration_available) throw Error(caps.turnstile_check ? 'API 网站要求安全验证，请前往网站完成注册。' : 'API 网站当前未开放此注册方式。'); showRegistration(body, message, dialogElement, caps); } catch (error) { message.textContent = error.message; } };
    body.append(form, signup);
    message.textContent = initialMessage;
    let two = false;
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button'); button.disabled = true; message.textContent = '正在连接…';
      try {
        const data = two ? await api('account/verify', 'POST', {code: form.elements.code.value}) : await api('account/login', 'POST', {username: form.elements.username.value, password: form.elements.password.value});
        form.elements.password.value = '';
        if (data.two_factor) {
          two = true; form.elements.username.disabled = true; form.elements.password.disabled = true; form.elements.password.hidden = true;
          form.elements.code.hidden = false; form.elements.code.disabled = false; form.elements.code.required = true; message.textContent = '请输入两步验证码。';
        } else { await refresh(); providersChanged(); if (!account) throw Error('登录请求已接受，但账户信息读取失败，请刷新重试。'); dialogElement.close(); await openAccount(); }
      } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
    };
  }

  function showRegistration(body, message, dialogElement, caps) {
    body.replaceChildren();
    const form = document.createElement('form');
    form.innerHTML = '<input name="username" autocomplete="username" placeholder="用户名（最多 20 个字符）" required maxlength="20"><input name="password" type="password" autocomplete="new-password" placeholder="密码（8–20 个字符）" required minlength="8" maxlength="20"><input name="confirm_password" type="password" autocomplete="new-password" placeholder="确认密码" required minlength="8" maxlength="20"><input name="email" type="email" autocomplete="email" placeholder="电子邮件（验证必需）" required><div data-email-verification style="display:flex;gap:8px;align-items:center"><input name="verification_code" placeholder="邮箱验证码" required style="flex:1"><button type="button" data-send-code>发送验证码</button></div><small>收不到邮件时请检查垃圾邮件；重新发送后请使用最新验证码。</small><label data-terms><input name="agree_terms" type="checkbox"> 我已阅读并同意 <a href="https://api.deepwhiteai.com/user-agreement" target="_blank" rel="noopener">用户协议</a></label><label data-privacy><input name="agree_privacy" type="checkbox"> 我已阅读并同意 <a href="https://api.deepwhiteai.com/privacy-policy" target="_blank" rel="noopener">隐私政策</a></label><button type="submit">创建账户</button>';
    const emailRequired = !!caps.email_verification;
    form.elements.email.required = emailRequired;
    const emailVerification = form.querySelector('[data-email-verification]');
    emailVerification.hidden = !emailRequired;
    form.elements.verification_code.required = emailRequired;
    const terms = form.querySelector('[data-terms]'); terms.hidden = !caps.user_agreement_enabled; if (caps.user_agreement_enabled) form.elements.agree_terms.required = true;
    const privacy = form.querySelector('[data-privacy]'); privacy.hidden = !caps.privacy_policy_enabled; if (caps.privacy_policy_enabled) form.elements.agree_privacy.required = true;
    const back = document.createElement('button'); back.type = 'button'; back.className = 'dw-link-button'; back.textContent = '返回登录';
    back.onclick = () => showLogin(body, message, dialogElement);
    body.append(form, back);
    let cooldown = 0, timer = null;
    const send = form.querySelector('[data-send-code]');
    const updateCooldown = () => { send.disabled = cooldown > 0; send.textContent = cooldown > 0 ? `重新发送（${cooldown}s）` : '发送验证码'; };
    send.onclick = async () => {
      try { const result = await api('account/verification?email=' + encodeURIComponent(form.elements.email.value.trim()), 'GET'); cooldown = Number(result.retry_after) || 60; updateCooldown(); message.textContent = result.message || '验证码已发送，请查收邮件。'; timer = setInterval(() => { cooldown -= 1; updateCooldown(); if (cooldown <= 0) clearInterval(timer); }, 1000); }
      catch (error) { const wait = Number((error.message.match(/(\d+) 秒/) || [])[1]); if (wait) { cooldown = wait; updateCooldown(); timer = setInterval(() => { cooldown -= 1; updateCooldown(); if (cooldown <= 0) clearInterval(timer); }, 1000); } message.textContent = error.message; }
    };
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button[type="submit"]'); button.disabled = true; message.textContent = '正在创建账户…';
      try {
        const result = await api('account/register', 'POST', {
          username: form.elements.username.value.trim(), password: form.elements.password.value,
          confirm_password: form.elements.confirm_password.value, email: form.elements.email.value.trim(),
          verification_code: form.elements.verification_code.value.trim(),
          agree_terms: form.elements.agree_terms.checked, agree_privacy: form.elements.agree_privacy.checked
        });
        if (timer) clearInterval(timer);
        showLogin(body, message, dialogElement, result.message || '账号已创建，请使用新账号登录。');
      } catch (error) { message.textContent = error.message; }
      finally { if (button.isConnected) button.disabled = false; }
    };
  }

  async function loadSkills() { skills = (await api('skills')).items; }
  async function openSkills() {
    const d = dialog('Skill 技能库'); const intro = document.createElement('p'); intro.textContent = '导入你自己的技能文件夹。SKILL.md 是主指令；agent-skill.json 中的 instructionReferences 可指定附加说明。选择文本节点中的技能后，生成时自动使用。仅加载文本，不运行脚本。'; d.append(intro);
    const input = document.createElement('input'); input.type = 'file'; input.webkitdirectory = true; input.multiple = true; input.setAttribute('aria-label', '导入技能文件夹'); d.append(input);
    const msg = document.createElement('p'); msg.className = 'dw-message'; d.append(msg); const list = document.createElement('div'); d.append(list);
    async function draw() {
      await loadSkills(); list.replaceChildren(); if (!skills.length) list.textContent = '还没有技能。请选择含 SKILL.md 的文件夹。';
      for (const skill of skills) {
        const row = document.createElement('div'); row.className = 'dw-skill-row'; const title = document.createElement('span'); title.textContent = skill.name + ` · ${skill.file_count} 个文件`;
        const view = document.createElement('button'); view.textContent = '查看'; view.onclick = async () => { try { const data = await api('skills/' + skill.id); const preview = dialog(skill.name); const pre = document.createElement('pre'); pre.textContent = data.files['SKILL.md']; preview.append(pre); } catch (error) { msg.textContent = error.message; } };
        const del = document.createElement('button'); del.textContent = '删除'; del.onclick = async () => { if (del.dataset.confirm !== 'yes') { del.dataset.confirm = 'yes'; del.textContent = '确认删除'; return; } try { await api('skills/' + skill.id, 'DELETE'); await draw(); } catch (error) { msg.textContent = error.message; } };
        row.append(title, view, del); list.append(row);
      }
    }
    input.onchange = async () => {
      try { input.disabled = true; const files = [...input.files], roots = files.filter(file => file.name === 'SKILL.md'); if (roots.length !== 1) throw Error('每次请选择一个含 SKILL.md 的技能文件夹。'); const base = roots[0].webkitRelativePath.slice(0, -8), content = {}; let total = 0;
        for (const file of files) { if (!file.webkitRelativePath.startsWith(base) || !/\.(md|txt|json)$/i.test(file.name)) continue; total += file.size; if (total > 512000) throw Error('技能文本合计不能超过 500 KB。'); content[file.webkitRelativePath.slice(base.length)] = await file.text(); }
        await api('skills', 'POST', {name: base.split('/').filter(Boolean).pop() || '我的技能', files: content}); msg.textContent = '已导入，可在文本节点选择使用。'; await draw();
      } catch (error) { msg.textContent = error.message; } finally { input.disabled = false; input.value = ''; }
    };
    try { await draw(); } catch (error) { msg.textContent = error.message; }
  }

  const host = document.querySelector('#quickToolbar .toolbar-fixed') || document.querySelector('.ws-topbar-right') || document.querySelector('.sv2-header-tools');
  if (!host) return;
  const accountButton = document.createElement('button'); accountButton.id = 'studioAccountButton'; accountButton.type = 'button'; accountButton.className = 'studio-settings-button'; accountButton.textContent = '登录 / 注册'; accountButton.onclick = openAccount; host.append(accountButton);
  refresh().then(() => {
    const url = new URL(location.href);
    if (url.searchParams.has('studio-account')) {
      url.searchParams.delete('studio-account'); history.replaceState(history.state, '', url);
      openAccount();
    }
  });
  window.StudioAccount = {open: openAccount, refresh};
})();
