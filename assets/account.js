/* 账号与云同步 —— 后端用 Supabase（GoTrue 认证 + PostgREST 存一份 JSON 快照）。
   配置写在 data/auth-config.js；没配置时整个功能只显示「未配置」提示，其余照常离线可用。 */
(function () {
  'use strict';

  const CFG = window.ZZ_AUTH || {};
  const BASE = String(CFG.url || '').replace(/\/+$/, '');
  const ANON = String(CFG.anonKey || '');
  const TABLE = String(CFG.table || 'zz_sync');
  const SESSION_KEY = 'zz.session.v1';
  const META_KEY = 'zz.sync.v1';
  const configured = !!(BASE && ANON);

  /* ---------------- 本地小工具 ---------------- */
  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function delLS(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  let session = readLS(SESSION_KEY, null);
  let meta = readLS(META_KEY, { auto: true });

  function saveSession(s) { session = s; if (s) writeLS(SESSION_KEY, s); else delLS(SESSION_KEY); }
  function saveMeta() { writeLS(META_KEY, meta); }

  function deviceName() {
    const ua = navigator.userAgent || '';
    const plat = /iPhone|iPad|Android/.test(ua) ? '手机' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '设备';
    return plat + '·' + Math.random().toString(36).slice(2, 6);
  }
  if (!meta.device) { meta.device = deviceName(); saveMeta(); }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------------- HTTP ---------------- */
  async function http(path, opts = {}) {
    const headers = Object.assign({
      'apikey': ANON,
      'Content-Type': 'application/json'
    }, opts.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const msg = (body && (body.error_description || body.msg || body.error || body.message)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /* ---------------- 认证 ---------------- */
  async function signUp(email, password) {
    const body = await http('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (body && body.access_token) {
      adopt(body);
      return { ok: true, needConfirm: false };
    }
    return { ok: true, needConfirm: true };
  }

  async function signIn(email, password) {
    const body = await http('/auth/v1/token?grant_type=password', {
      method: 'POST', body: JSON.stringify({ email, password })
    });
    adopt(body);
    return { ok: true };
  }

  function adopt(body) {
    const exp = Date.now() + Math.max(30, (body.expires_in || 3600) - 60) * 1000;
    saveSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: exp,
      email: (body.user && body.user.email) || '',
      uid: (body.user && body.user.id) || ''
    });
  }

  async function ensureFresh() {
    if (!session) throw new Error('未登录');
    if (Date.now() < (session.expires_at || 0)) return session;
    if (!session.refresh_token) throw new Error('登录已过期，请重新登录');
    const body = await http('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    adopt(body);
    return session;
  }

  async function signOut() {
    try { if (session) await http('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
    saveSession(null);
  }

  /* ---------------- 快照与合并 ---------------- */
  function snap() {
    const app = window.ZZ_APP;
    const data = app ? app.snapshot() : { settings: {}, progress: {} };
    return {
      v: 1,
      updatedAt: Date.now(),
      device: meta.device,
      settings: data.settings || {},
      progress: data.progress || {}
    };
  }

  // 进度/记忆按条目 ts 取新的；其余偏好取整体较新的一份
  function mergePayload(remote, local) {
    const r = remote || {};
    const l = local || {};
    const rs = r.settings || {};
    const ls = l.settings || {};
    const newer = (r.updatedAt || 0) > (l.updatedAt || 0) ? ls : rs;
    const older = (r.updatedAt || 0) > (l.updatedAt || 0) ? rs : ls;

    // 比较优先级：rev 高的更新（改答案会让 rev +1），rev 相同再比 ts；
    // 这样「改了答案」一定能压过别的设备上的旧记录，不受两边时钟快慢影响。
    function stamp(v) {
      if (v && typeof v === 'object') return { rev: v.rev || 0, ts: v.ts || 0 };
      return { rev: 0, ts: typeof v === 'number' ? v : 0 };
    }
    function wins(next, cur) {
      const a = stamp(cur);
      const b = stamp(next);
      if (b.rev !== a.rev) return b.rev > a.rev;
      return b.ts >= a.ts;
    }

    function mergeTsMap(a, b) {
      const out = {};
      Object.keys(a || {}).forEach((k) => { out[k] = a[k]; });
      Object.keys(b || {}).forEach((k) => {
        if (!(k in out) || wins(b[k], out[k])) out[k] = b[k];
      });
      return out;
    }

    const settings = Object.assign({}, older, newer);
    settings.kb = mergeTsMap(rs.kb, ls.kb);
    settings.kbMem = mergeTsMap(rs.kbMem, ls.kbMem);
    delete settings.session;

    return {
      v: 1,
      updatedAt: Math.max(r.updatedAt || 0, l.updatedAt || 0, Date.now()),
      device: meta.device,
      settings,
      progress: mergeTsMap(r.progress || {}, l.progress || {})
    };
  }

  function applyPayload(payload) {
    const app = window.ZZ_APP;
    if (app && app.apply) app.apply(payload);
  }

  function serverTs(payload) {
    return payload && payload.updatedAt ? payload.updatedAt : 0;
  }

  async function pull() {
    await ensureFresh();
    const rows = await http(`/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(session.uid)}&select=payload,updated_at`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function push(payload) {
    await ensureFresh();
    await http(`/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: session.uid,
        payload,
        updated_at: new Date(payload.updatedAt || Date.now()).toISOString()
      })
    });
    meta.lastPush = Date.now();
    meta.lastSync = Date.now();
    saveMeta();
  }

  async function syncNow(manualPull) {
    if (!configured) throw new Error('云同步还没配置');
    const local = snap();
    const row = await pull();
    if (!row) {
      await push(local);
      return { pushed: true, pulled: false };
    }
    const remote = row.payload || {};
    const merged = mergePayload(remote, local);
    applyPayload(merged);
    await push(merged);
    meta.lastPull = Date.now();
    meta.lastSync = Date.now();
    saveMeta();
    return { pushed: true, pulled: true, pulledAt: serverTs(remote) };
  }

  /* ---------------- 自动同步 ---------------- */
  let timer = null;
  function touch() {
    if (!configured || !session || !meta.auto) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      push(snap()).catch((e) => { meta.lastError = e.message; saveMeta(); });
    }, 4000);
  }

  async function bootSync() {
    if (!configured || !session) return;
    syncing = true;
    paintChips();
    try {
      await syncNow(false);
      meta.lastError = null;
    } catch (e) {
      meta.lastError = e.message;
      meta.lastErrorAt = Date.now();
    } finally {
      syncing = false;
      saveMeta();
      render();
    }
  }

  /* ---------------- 界面 ---------------- */
  let pop = null;       // 下拉面板
  let chipEl = null;    // 账号按钮
  let chipText = null;  // 账号按钮上的文字
  let syncChip = null;  // 同步状态按钮
  let syncDot = null;
  let syncText = null;
  let bodyEl = null;
  let subEl = null;
  let busy = false;
  let syncing = false;

  const SETUP_SQL = [
    'create table if not exists public.zz_sync (',
    '  user_id uuid primary key references auth.users(id) on delete cascade,',
    '  payload jsonb not null,',
    '  updated_at timestamptz not null default now()',
    ');',
    'alter table public.zz_sync enable row level security;',
    'create policy "own row read" on public.zz_sync for select using (auth.uid() = user_id);',
    'create policy "own row write" on public.zz_sync for insert with check (auth.uid() = user_id);',
    'create policy "own row update" on public.zz_sync for update using (auth.uid() = user_id);'
  ].join('\n');

  function ensureDom() {
    if (pop) return;
    pop = document.getElementById('acctPop');
    chipEl = document.getElementById('acctChip');
    chipText = document.getElementById('acctChipText');
    syncChip = document.getElementById('syncChip');
    syncDot = document.getElementById('syncDot');
    syncText = document.getElementById('syncText');
    bodyEl = document.getElementById('acctBody');
    subEl = document.getElementById('acctSub');
    if (!pop || !chipEl) return;

    pop.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) onAction(act.dataset.act);
    });
    const closeBtn = document.getElementById('acctClose');
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    chipEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.hidden) open(); else close();
    });
    if (syncChip) {
      syncChip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop.hidden) open();
        if (session && configured) {
          busyRun(() => syncNow(true));
        }
      });
    }
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || chipEl.contains(e.target) || (syncChip && syncChip.contains(e.target))) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); close(); }
    });
    paintChips();
  }

  function open() {
    ensureDom();
    if (!pop) return;
    pop.hidden = false;
    chipEl.setAttribute('aria-expanded', 'true');
    document.body.classList.add('acct-open');
    render();
    if (configured && session) bootSync();
    if (configured) {
      checkTable().then(() => render());
    }
  }

  function close() {
    if (!pop) return;
    pop.hidden = true;
    chipEl.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('acct-open');
  }

  /* 右上角两个入口：账号 + 同步状态 */
  function shortName(email) {
    if (!email) return '账号';
    const local = String(email).split('@')[0];
    return local.length > 12 ? local.slice(0, 11) + '…' : local;
  }

  function paintChips() {
    if (!chipEl) return;
    const on = !!session;
    chipText.textContent = on ? shortName(session.email) : '登录';
    chipEl.classList.toggle('on', on);
    chipEl.title = on ? (session.email + ' · 点开账号与云同步') : '登录 / 注册（云同步）';

    if (!syncChip) return;
    if (!configured || !on) { syncChip.hidden = true; return; }
    syncChip.hidden = false;
    const bad = meta.lastError && (!meta.lastSync || meta.lastErrorAt > meta.lastSync);
    syncChip.classList.toggle('sync-ok', !bad && !!meta.lastSync);
    syncChip.classList.toggle('sync-bad', !!bad);
    syncChip.classList.toggle('sync-busy', syncing);
    if (syncing) syncText.textContent = '同步中';
    else if (bad) syncText.textContent = '待重试';
    else if (meta.lastSync) syncText.textContent = fmtTime(meta.lastSync);
    else syncText.textContent = '未同步';
    syncChip.title = bad ? ('同步出错：' + meta.lastError) : ('上次同步 ' + (meta.lastSync ? fmtTime(meta.lastSync) : '—') + ' · 点一下立即同步');
  }

  async function busyRun(fn) {
    if (busy) return;
    busy = true;
    syncing = true;
    paintChips();
    try {
      const r = await fn();
      msg(r && r.pulled ? '已合并云端与本机' : '已同步到云端', 'ok');
    } catch (e) {
      meta.lastError = e.message;
      meta.lastErrorAt = Date.now();
      saveMeta();
      msg(e.message, 'bad');
    } finally {
      busy = false;
      syncing = false;
      render();
    }
  }

  function statusLine() {
    if (!configured) return '未配置云端 · 数据只存在这台设备';
    if (!session) return '未登录 · 数据只存在这台设备';
    const bits = ['已登录 ' + (session.email || '')];
    if (meta.lastSync) bits.push('上次同步 ' + fmtTime(meta.lastSync));
    return bits.join(' · ');
  }

  function render() {
    ensureDom();
    paintChips();
    if (!pop || pop.hidden) return;
    if (subEl) subEl.textContent = statusLine();
    if (!configured) { bodyEl.innerHTML = unconfiguredHTML(); return; }
    if (tableState.ok === false && tableState.reason === 'notable') { bodyEl.innerHTML = tableMissingHTML(); return; }
    bodyEl.innerHTML = session ? signedInHTML() : signedOutHTML();
  }

  function setupSQLBlock() {
    return `<pre class="acct-sql" id="acctSql">${SETUP_SQL.replace(/</g, '&lt;')}</pre>
      <button class="btn ghost" data-act="copysql">复制 SQL</button>`;
  }

  function tableMissingHTML() {
    return `
      <div class="acct-note">
        <b>后端已连上，只差建表这一步</b>
        <p>项目地址和 key 都通了（认证服务可以访问），但库里还没有 <code>${TABLE}</code> 这张表。把下面这段贴进 Supabase 的 <b>SQL Editor</b> 执行一次就好：</p>
      </div>
      ${setupSQLBlock()}
      <div class="acct-note small">
        <p>执行完回到这里重开面板，就会切成登录界面。</p>
        <p>另外在 <b>Authentication → Providers → Email</b> 里把「Confirm email」关掉，注册后就能直接登录、不用点邮件。</p>
      </div>`;
  }

  function unconfiguredHTML() {
    return `
      <div class="acct-note">
        <b>云同步还没接通</b>
        <p>账号需要一个后端来存。这个站点是纯静态的（GitHub Pages），所以用 Supabase 的免费项目：认证 + 一张表，五分钟就能开好，之后所有设备登录同一个账号，进度自动接上。</p>
      </div>
      <ol class="acct-steps">
        <li>去 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> 建一个免费项目。</li>
        <li>在 <b>SQL Editor</b> 里执行下面这段，建表并开启行级权限：</li>
      </ol>
      <pre class="acct-sql" id="acctSql">${SETUP_SQL.replace(/</g, '&lt;')}</pre>
      <button class="btn ghost" data-act="copysql">复制 SQL</button>
      <ol class="acct-steps" start="3">
        <li>在 <b>Project Settings → API</b> 复制 <code>Project URL</code> 和 <code>anon public</code> 两个值。</li>
        <li>把它们填进仓库的 <code>data/auth-config.js</code>：</li>
      </ol>
      <pre class="acct-sql">window.ZZ_AUTH = {
  url: 'https://xxxx.supabase.co',
  anonKey: 'eyJhbGciOi…'
};</pre>
      <div class="acct-note small">
        <p>另外在 <b>Authentication → Providers → Email</b> 里把「Confirm email」关掉，注册后就能直接登录。</p>
        <p>密码只交给 Supabase 认证服务，前端不保存密码；每个账号只能读写自己那一行数据（RLS）。</p>
      </div>`;
  }

  function signedOutHTML() {
    return `
      <div class="acct-tabs" id="acctTabs">
        <button class="active" data-act="tab" data-tab="login">登录</button>
        <button data-act="tab" data-tab="signup">注册</button>
      </div>
      <form class="acct-form" id="acctForm" autocomplete="on">
        <label>邮箱<input type="email" id="acctEmail" autocomplete="username" required placeholder="you@example.com"></label>
        <label>密码<input type="password" id="acctPw" autocomplete="current-password" required minlength="6" placeholder="至少 6 位"></label>
        <button class="btn primary" type="submit" id="acctSubmit">登录</button>
      </form>
      <p class="acct-msg" id="acctMsg"></p>
      <p class="acct-hint">没有账号就切到「注册」。登录后这台设备的数据会与云端合并，换设备登录同一个账号即可接着用。</p>`;
  }

  function signedInHTML() {
    const kb = (window.ZZ_APP && window.ZZ_APP.snapshot().settings || {}).kbMem || {};
    const n = Object.keys(kb).length;
    return `
      <div class="acct-who">
        <div>
          <b>${(session.email || '').replace(/</g, '&lt;')}</b>
          <span>卡片记忆 ${n} 张 · 设备 ${meta.device}</span>
        </div>
        <button class="btn ghost" data-act="logout">退出</button>
      </div>
      <div class="acct-rows">
        <div class="acct-row">
          <span>自动同步</span>
          <label class="acct-switch"><input type="checkbox" id="acctAuto" ${meta.auto ? 'checked' : ''}><i></i></label>
        </div>
        <div class="acct-row"><span>上次同步</span><b>${fmtTime(meta.lastSync)}</b></div>
        <div class="acct-row"><span>上次拉取</span><b>${fmtTime(meta.lastPull)}</b></div>
      </div>
      <div class="acct-actions">
        <button class="btn primary" data-act="sync">立即同步</button>
        <button class="btn ghost" data-act="pullonly">从云端覆盖本机</button>
        <button class="btn ghost" data-act="pushonly">把本机传到云端</button>
      </div>
      <p class="acct-msg" id="acctMsg"></p>
      <p class="acct-hint">同步内容：做题进度与错题、卡片记忆程度、偏好设置。冲突时按每条记录的时间戳取新的。</p>`;
  }

  let flash = null;
  let tableState = { ok: null, reason: '', msg: '' };

  async function checkTable() {
    if (!configured) { tableState = { ok: false, reason: 'noconfig' }; return tableState; }
    try {
      const res = await fetch(`${BASE}/rest/v1/${TABLE}?select=user_id&limit=1`, { headers: { apikey: ANON } });
      if (res.status === 404) {
        const j = await res.json().catch(() => null);
        if (j && j.code === 'PGRST205') { tableState = { ok: false, reason: 'notable' }; return tableState; }
      }
      if (res.status === 401 || res.status === 200 || res.status === 206) {
        tableState = { ok: true, reason: '' };
        return tableState;
      }
      tableState = { ok: false, reason: 'http', msg: 'HTTP ' + res.status };
      return tableState;
    } catch (e) {
      tableState = { ok: false, reason: 'net', msg: e.message };
      return tableState;
    }
  }
  function msg(text, kind) {
    flash = text ? { text: String(text), kind: kind || '' } : null;
    paintMsg();
  }
  function paintMsg() {
    const el = document.getElementById('acctMsg');
    if (!el) return;
    el.textContent = flash ? flash.text : '';
    el.className = 'acct-msg' + (flash && flash.kind ? ' ' + flash.kind : '');
  }

  async function onAction(act) {
    if (busy) return;
    try {
      if (act === 'copysql') {
        await navigator.clipboard.writeText(SETUP_SQL);
        msg('SQL 已复制', 'ok');
        return;
      }
      if (act === 'tab') return;
      if (act === 'logout') {
        busy = true;
        await signOut();
        busy = false;
        render();
        return;
      }
      if (act === 'sync') {
        busy = true;
        msg('同步中…');
        const r = await syncNow(true);
        busy = false;
        meta.lastError = null; meta.lastErrorAt = 0; saveMeta();
        msg(r.pulled ? '已合并云端并回传' : '已上传到云端', 'ok');
        render();
        return;
      }
      if (act === 'pullonly') {
        busy = true;
        msg('拉取中…');
        const row = await pull();
        if (!row) { msg('云端还没有数据', 'warn'); busy = false; return; }
        applyPayload(row.payload);
        meta.lastPull = Date.now(); meta.lastSync = Date.now();
        meta.lastError = null; meta.lastErrorAt = 0; saveMeta();
        busy = false;
        msg('已用云端数据覆盖本机', 'ok');
        render();
        return;
      }
      if (act === 'pushonly') {
        busy = true;
        msg('上传中…');
        await push(snap());
        meta.lastError = null; meta.lastErrorAt = 0; saveMeta();
        busy = false;
        msg('已上传', 'ok');
        render();
      }
    } catch (e) {
      busy = false;
      msg(e.message || '出错了', 'err');
    }
  }

  function bindForm() {
    const tabs = document.getElementById('acctTabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        [...tabs.children].forEach((x) => x.classList.toggle('active', x === b));
        mode = b.dataset.tab;
        const submit = document.getElementById('acctSubmit');
        if (submit) submit.textContent = mode === 'signup' ? '注册' : '登录';
        const pw = document.getElementById('acctPw');
        if (pw) pw.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      });
    }
    const form = document.getElementById('acctForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const email = document.getElementById('acctEmail').value.trim();
        const pw = document.getElementById('acctPw').value;
        if (!email || pw.length < 6) { msg('邮箱和至少 6 位密码', 'warn'); return; }
        busy = true;
        msg(mode === 'signup' ? '注册中…' : '登录中…');
        try {
          if (mode === 'signup') {
            const r = await signUp(email, pw);
            if (r.needConfirm) {
              busy = false;
              msg('注册成功，请到邮箱点确认链接后再登录（或在 Supabase 里关掉 Confirm email）', 'warn');
              return;
            }
          } else {
            await signIn(email, pw);
          }
          const syncRes = await syncNow(false);
          busy = false;
          meta.lastError = null; meta.lastErrorAt = 0; saveMeta();
          msg(syncRes.pulled ? '登录成功，已合并云端数据' : '登录成功，本机数据已上传', 'ok');
          render();
        } catch (err) {
          busy = false;
          msg(err.message || '出错了', 'err');
        }
      });
    }
    const auto = document.getElementById('acctAuto');
    if (auto) {
      auto.addEventListener('change', () => {
        meta.auto = !!auto.checked;
        saveMeta();
        msg(meta.auto ? '已开启自动同步' : '已关闭自动同步', 'ok');
      });
    }
  }

  let mode = 'login';

  // 每次重绘后重新绑定（面板很小，直接绑；只在 render 里做一次，避免重复监听）
  const _render = render;
  render = function () { _render(); bindForm(); paintMsg(); };

  /* ---------------- 对外 ---------------- */
  window.ZZ_ACCOUNT = {
    open,
    close,
    touch,
    configured,
    syncNow,
    get session() { return session; },
    _render: () => render()
  };

  // 启动：先把右上角的两个药丸和下拉绑上，再恢复登录态
  function init() {
    ensureDom();
    paintChips();
    if (configured && session) {
      bootSync();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
