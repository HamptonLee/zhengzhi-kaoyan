/* 政治真题速查 —— 纯静态前端，数据来自 data/questions.js（window.ZZ_DATA） */
(function () {
  'use strict';

  const DATA = window.ZZ_DATA;
  const $ = (id) => document.getElementById(id);
  const cardEl = $('card');
  const gridEl = $('numGrid');
  const suggestEl = $('suggest');

  if (!DATA || !Array.isArray(DATA.questions) || !DATA.questions.length) {
    cardEl.innerHTML = '<div class="empty-state">没有找到题库数据。<br>请先在项目目录运行：<br>' +
      '<code>python build/build_data.py</code></div>';
    return;
  }

  const SUBJECTS = [...new Set(DATA.questions.map((q) => q.subject))];
  const PARTS = ['唯物论', '辩证法', '认识论', '唯物史观', '政治经济学', '科学社会主义'];
  const KEY_STORE = 'zz.manual.v1';
  const KEY_PROGRESS = 'zz.progress.v1';
  const KEY_SETTINGS = 'zz.settings.v1';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) { /* file:// 下个别浏览器禁用存储，忽略 */ }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    }
  };

  let manual = store.get(KEY_STORE, {});
  let progress = store.get(KEY_PROGRESS, {});

  // 手填答案覆盖题库数据
  DATA.questions.forEach((q) => {
    const m = manual[q.id];
    if (m && (m.answer || m.explain)) {
      q.answer = (m.answer || q.answer || '').toUpperCase();
      q.explain = m.explain || q.explain;
      q.answerSource = 'manual';
    }
  });

  const byScope = new Map();
  DATA.questions.forEach((q) => {
    const k = scopeKey(q);
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(q);
  });

  const settings = store.get(KEY_SETTINGS, {});
  const hasAnswers = !!(DATA.meta && DATA.meta.answered > 0);
  const state = {
    subject: SUBJECTS.includes(settings.subject) ? settings.subject : SUBJECTS[0],
    part: PARTS.includes(settings.part) ? settings.part : PARTS[0],
    type: settings.type === '多选' ? '多选' : '单选',
    id: settings.id || null,
    picked: [],
    revealed: false,
    submitted: false,
    quiz: settings.quiz !== undefined ? settings.quiz !== false : hasAnswers
  };

  if (state.subject !== '马克思主义哲学') state.part = '';

  /* ---------------- 工具 ---------------- */
  function scopeKey(q) {
    return q.subject + '|' + (q.subject === '马克思主义哲学' ? (q.part || '') : '') + '|' + q.type;
  }

  function currentScope() {
    return state.subject + '|' + (state.subject === '马克思主义哲学' ? state.part : '') + '|' + state.type;
  }

  function currentList() {
    return byScope.get(currentScope()) || [];
  }

  function findById(id) {
    return DATA.questions.find((q) => q.id === id) || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isCorrect(q) {
    const p = progress[q.id];
    return !!(p && p.correct === true);
  }

  function markSeen(q) {
    if (!progress[q.id]) {
      progress[q.id] = { picked: [], correct: null, seen: true, ts: Date.now() };
    } else {
      progress[q.id].seen = true;
    }
    store.set(KEY_PROGRESS, progress);
  }

  function recordAttempt(q, picked, correct) {
    progress[q.id] = { picked: picked.slice(), correct, seen: true, ts: Date.now() };
    store.set(KEY_PROGRESS, progress);
  }

  function answeredCount() {
    return Object.values(progress).filter((p) => p && p.correct !== null && p.correct !== undefined).length;
  }

  function scrollCard() {
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- 过滤区 ---------------- */
  function renderFilters() {
    const sRow = $('subjectRow');
    sRow.innerHTML = SUBJECTS.map((s) =>
      `<button class="chip${s === state.subject ? ' active' : ''}" data-subject="${esc(s)}">${esc(s)}</button>`
    ).join('');
    sRow.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        state.subject = b.dataset.subject;
        if (state.subject !== '马克思主义哲学') state.part = '';
        else if (!PARTS.includes(state.part)) state.part = PARTS[0];
        state.id = null;
        render();
        const first = currentList()[0];
        if (first) showQuestion(first.id, false);
      });
    });

    const pRow = $('partRow');
    pRow.hidden = state.subject !== '马克思主义哲学';
    if (!pRow.hidden) {
      pRow.innerHTML = PARTS.map((p) =>
        `<button class="chip${p === state.part ? ' active' : ''}" data-part="${esc(p)}">${esc(p)}</button>`
      ).join('');
      pRow.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
          state.part = b.dataset.part;
          state.id = null;
          render();
          const first = currentList()[0];
          if (first) showQuestion(first.id, false);
        });
      });
    }

    const tRow = $('typeRow');
    tRow.innerHTML = ['单选', '多选'].map((t) =>
      `<button class="${t === state.type ? 'active' : ''}" data-type="${t}">${t}</button>`
    ).join('');
    tRow.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        state.type = b.dataset.type;
        state.id = null;
        render();
        const first = currentList()[0];
        if (first) showQuestion(first.id, false);
      });
    });

    $('modeBtn').textContent = '模式 · ' + (state.quiz ? '自测' : '背题');
    const wrongTotal = Object.values(progress).filter((p) => p && p.correct === false).length;
    $('wrongCount').textContent = String(wrongTotal);
    const aiTotal = DATA.questions.filter((q) => q.answerSource === 'generated').length;
    $('brandSub').textContent =
      `1994–2025 · ${DATA.questions.length} 题 · 已对 ${answeredCount()} 题` +
      (DATA.meta && DATA.meta.answered ? ` · 已导答案 ${DATA.meta.answered}` : ' · 答案待导入') +
      (aiTotal ? `（AI 待校对 ${aiTotal}）` : '');
  }

  /* ---------------- 侧栏题号 ---------------- */
  function renderGrid() {
    const list = currentList();
    const q = findById(state.id);
    $('sideTitle').textContent = (state.subject === '马克思主义哲学' ? state.part + ' · ' : state.subject + ' · ') + state.type;
    $('sideHint').textContent = `${list.length} 题`;
    gridEl.innerHTML = list.map((item) => {
      const p = progress[item.id];
      let cls = 'empty';
      if (p && p.correct === true) cls = 'ok';
      else if (p && p.correct === false) cls = 'bad';
      else if (p && p.seen) cls = 'seen';
      if (q && item.id === q.id) cls += ' active';
      const dupe = list.filter((x) => x.no === item.no).length > 1;
      return `<button class="${cls}" data-id="${esc(item.id)}" title="卷面第 ${item.no} 题${dupe ? '（该号有多题）' : ''}">${item.no}</button>`;
    }).join('');
    gridEl.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => showQuestion(b.dataset.id, true));
    });
  }

  /* ---------------- 题目卡 ---------------- */
  function showQuestion(id, doScroll) {
    const q = findById(id);
    if (!q) return;
    state.id = id;
    state.picked = [];
    state.revealed = false;
    state.submitted = false;
    saveSettings();
    renderCard();
    renderGrid();
    if (doScroll) scrollCard();
  }

  function saveSettings() {
    store.set(KEY_SETTINGS, {
      subject: state.subject, part: state.part, type: state.type, quiz: state.quiz, id: state.id
    });
  }

  function renderCard() {
    const q = findById(state.id);
    if (!q) {
      cardEl.innerHTML = '<div class="empty-state">输入题号，或点击右侧题号开始。</div>';
      return;
    }
    const list = currentList();
    const idx = list.findIndex((x) => x.id === q.id);
    const dupe = list.filter((x) => x.no === q.no);
    const p = progress[q.id];
    const solved = p && typeof p.correct === 'boolean';
    const revealed = state.revealed;
    const showAnswer = revealed;
    const answerLetters = (q.answer || '').split('');

    const head = `
      <div class="card-head">
        <span class="qno">${q.no}</span>
        <span class="scope-name">${esc((q.part || q.subject) + ' · ' + q.type)}</span>
        <span class="tag year">${q.year}</span>
        ${q.relatedIds && q.relatedIds.length ? '<span class="tag">同题重复</span>' : ''}
        ${solved ? `<span class="tag" style="color:${p.correct ? 'var(--ok)' : 'var(--bad)'};border-color:currentColor">${p.correct ? '上次答对' : '上次答错'}</span>` : ''}
        <span class="spacer"></span>
        <span>${idx + 1} / ${list.length}</span>
      </div>`;

    const dupeRow = dupe.length > 1
      ? `<div class="pending" style="margin:0 0 14px;padding:9px 12px;font-size:13px">
           该题号在本题型下有 ${dupe.length} 道题（源文档混编）：
           ${dupe.map((x) => `<a href="#" data-jump="${esc(x.id)}" style="margin-right:8px">${x.year} 年</a>`).join('')}
         </div>`
      : '';

    const options = q.options.map((o) => {
      let cls = 'option';
      const picked = state.picked.includes(o.key);
      if (picked && !state.submitted && !revealed) cls += ' picked';
      if (showAnswer) {
        if (answerLetters.includes(o.key)) cls += ' correct';
        else if (picked) cls += ' wrong';
        else if (state.picked.includes(o.key)) cls += ' picked';
      } else if (state.submitted) {
        if (picked && !(q.answer || '').includes(o.key)) cls += ' wrong';
      }
      return `<button class="${cls}" data-opt="${o.key}" ${showAnswer ? 'disabled' : ''}>
        <span class="letter">${o.key}</span><span>${esc(o.text)}</span>
      </button>`;
    }).join('');

    let actions = '';
    if (state.quiz) {
      if (!state.submitted && !revealed) {
        actions = `<button class="btn primary" id="submitBtn" ${state.picked.length ? '' : 'disabled'}>提交答案</button>
          <button class="btn ghost" id="revealBtn">直接看答案</button>
          <button class="btn ghost" id="prevBtn" ${idx <= 0 ? 'disabled' : ''}>← 上一题</button>
          <span class="hint">${state.type === '多选' ? '可多选，选完点提交' : '点一个选项，再提交'}</span>`;
      } else if (!state.submitted && revealed) {
        actions = `<button class="btn primary" id="nextBtn">下一题 →</button>
          <button class="btn ghost" id="revealBtn">收起答案</button>
          <span class="hint">已看答案，本题不计入正确率</span>`;
      } else {
        actions = `<button class="btn primary" id="nextBtn">下一题 →</button>
          <button class="btn ghost" id="prevBtn" ${idx <= 0 ? 'disabled' : ''}>← 上一题</button>
          <span class="hint">${p && p.correct ? '答对了' : '已记入错题本'}</span>`;
      }
    } else {
      actions = `<button class="btn primary" id="revealBtn">${revealed ? '收起答案' : '看答案'}</button>
        <button class="btn ghost" id="prevBtn" ${idx <= 0 ? 'disabled' : ''}>← 上一题</button>
        <button class="btn ghost" id="nextBtn" ${idx >= list.length - 1 ? 'disabled' : ''}>下一题 →</button>`;
    }

    let answerBox = '';
    if (revealed) {
      if (q.answer) {
        const srcLabel = q.answerSource === 'manual' ? '手动录入' : q.answerSource === 'generated' ? 'AI 生成 · 待校对' : '导入答案';
        const aiNote = q.answerSource === 'generated'
          ? '<div class="ai-note">本题答案与讲解由 AI 生成，尚未人工核对，仅供参考；发现错误可在下方手填覆盖。</div>'
          : '';
        answerBox = `<div class="answer-box">
          <div class="answer-line">
            <span class="label">答案</span>
            <span class="value">${esc(q.answer)}</span>
            <span class="src">${srcLabel}</span>
          </div>
          ${aiNote}
          <p class="explain ${q.explain ? '' : 'empty'}">${q.explain ? esc(q.explain) : '这道题暂时只有答案，还没有讲解。'}</p>
        </div>`;
      } else {
        answerBox = `<div class="pending">
          <strong>答案待导入。</strong>把带答案的文件放进 <code>import/</code> 目录后运行导入命令，或直接在这里手填。
          <div id="manualSlot"></div>
        </div>`;
      }
    }

    cardEl.innerHTML = `${head}${dupeRow}
      <p class="stem">${esc(q.stem)}</p>
      <div class="options">${options}</div>
      <div class="card-actions">${actions}</div>
      ${answerBox}`;

    bindCardEvents(q, list, idx, revealed);
  }

  function bindCardEvents(q, list, idx, revealed) {
    cardEl.querySelectorAll('[data-jump]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); showQuestion(a.dataset.jump, false); });
    });

    cardEl.querySelectorAll('.option').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.revealed || state.submitted) return;
        const key = btn.dataset.opt;
        if (state.quiz) {
          if (state.type === '多选') {
            const i = state.picked.indexOf(key);
            if (i >= 0) state.picked.splice(i, 1); else state.picked.push(key);
          } else {
            state.picked = [key];
          }
          renderCard();
          if (state.type === '单选') {
            // 单选点了就自动提交，少一次点击
            setTimeout(() => submitAnswer(), 120);
          }
        } else {
          state.picked = [key];
          renderCard();
        }
      });
    });

    const revealBtn = $('revealBtn');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        state.revealed = !state.revealed;
        if (state.revealed) markSeen(q);
        renderCard();
        renderGrid();
        renderFilters();
      });
    }

    const submitBtn = $('submitBtn');
    if (submitBtn) submitBtn.addEventListener('click', () => submitAnswer());

    const nextBtn = $('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => goRelative(1));

    const prevBtn = $('prevBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => goRelative(-1));

    const slot = $('manualSlot');
    if (slot && revealed && !q.answer) renderManualForm(slot, q);
  }

  function renderManualForm(slot, q) {
    slot.innerHTML = `<div class="manual-form">
      <div class="row">
        <input class="ans" id="mAns" placeholder="答案，如 ABD" value="${esc(q.answer || '')}">
        <button class="btn primary" id="mSave">保存</button>
        <span class="hint" style="color:var(--ink-3)">保存后只存在本机浏览器，可随时改</span>
      </div>
      <textarea id="mExplain" placeholder="讲解（可选）"></textarea>
    </div>`;
    $('mSave').addEventListener('click', () => {
      const ans = ($('mAns').value || '').toUpperCase().replace(/[^A-E]/g, '');
      const explain = $('mExplain').value.trim();
      if (!ans) { alert('答案不能为空'); return; }
      manual[q.id] = { answer: ans, explain: explain || null, ts: Date.now() };
      store.set(KEY_STORE, manual);
      q.answer = ans;
      q.explain = explain || null;
      q.answerSource = 'manual';
      state.picked = ans.split('');
      state.revealed = true;
      renderCard();
      renderGrid();
      renderFilters();
    });
  }

  function submitAnswer() {
    const q = findById(state.id);
    if (!q) return;
    if (!q.answer) {
      state.revealed = true;
      markSeen(q);
      renderCard();
      renderGrid();
      return;
    }
    if (!state.picked.length) return;
    const picked = state.picked.slice().sort().join('');
    const correct = picked === q.answer.split('').sort().join('');
    recordAttempt(q, state.picked, correct);
    state.submitted = true;
    state.revealed = true;
    renderCard();
    renderGrid();
    renderFilters();
  }

  function goRelative(delta) {
    const list = currentList();
    const idx = list.findIndex((x) => x.id === state.id);
    const next = list[idx + delta];
    if (next) showQuestion(next.id, true);
  }

  /* ---------------- 题号跳转 ---------------- */
  function jumpByNumber(raw) {
    const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    if (!n || n < 0) return false;
    const list = currentList();
    const hits = list.filter((q) => q.no === n);
    if (hits.length === 1) {
      showQuestion(hits[0].id, true);
      return true;
    }
    if (hits.length > 1) {
      // 同号多题：先展示第一道，并在卡片里给出候选切换
      showQuestion(hits[0].id, true);
      return true;
    }
    // 没这号：找最近的
    let nearest = null;
    for (const q of list) {
      if (!nearest || Math.abs(q.no - n) < Math.abs(nearest.no - n)) nearest = q;
    }
    if (nearest) {
      showQuestion(nearest.id, true);
      const tip = document.createElement('div');
      tip.className = 'pending';
      tip.style.margin = '0 0 14px';
      tip.textContent = `本题区没有第 ${n} 题（卷面题号最大 ${Math.max(...list.map((x) => x.no))}），已跳到最接近的第 ${nearest.no} 题。`;
      cardEl.prepend(tip);
    }
    return false;
  }

  /* ---------------- 搜索 ---------------- */
  function runSearch(kw) {
    const key = kw.trim().toLowerCase();
    if (!key) { suggestEl.hidden = true; suggestEl.innerHTML = ''; return; }
    const hits = DATA.questions.filter((q) =>
      q.stem.toLowerCase().includes(key) ||
      String(q.year).includes(key) ||
      (q.part || '').toLowerCase().includes(key) ||
      q.subject.toLowerCase().includes(key)
    ).slice(0, 12);
    if (!hits.length) {
      suggestEl.innerHTML = '<div class="empty-state" style="padding:14px">没有匹配的题</div>';
      suggestEl.hidden = false;
      return;
    }
    suggestEl.innerHTML = hits.map((q) => `
      <button data-id="${esc(q.id)}">
        <b>${q.no}</b> ${esc(q.stem.slice(0, 46))}${q.stem.length > 46 ? '…' : ''}
        <span class="meta">${q.year} · ${esc((q.part || q.subject) + q.type)}</span>
      </button>`).join('');
    suggestEl.hidden = false;
    suggestEl.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const q = findById(b.dataset.id);
        state.subject = q.subject;
        state.part = q.subject === '马克思主义哲学' ? q.part : '';
        state.type = q.type;
        suggestEl.hidden = true;
        $('searchInput').value = '';
        render();
        showQuestion(q.id, true);
      });
    });
  }

  /* ---------------- 弹层 ---------------- */
  function openModal(title, html) {
    $('modalTitle').textContent = title;
    $('modalContent').innerHTML = html;
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }

  function showWrongBook() {
    const wrong = DATA.questions.filter((q) => progress[q.id] && progress[q.id].correct === false);
    if (!wrong.length) {
      openModal('错题本', '<div class="empty-state">还没有错题。做错一道就会自动收进来。</div>');
      return;
    }
    openModal('错题本', `
      <p style="color:var(--ink-3);font-size:13px;margin:0 0 8px">共 ${wrong.length} 道，点击可跳转复习</p>
      ${wrong.map((q) => `
        <div class="wrong-item" data-id="${esc(q.id)}">
          <div class="no">${q.no}</div>
          <div class="txt"><b>${q.year} · ${esc(q.part || q.subject)}${q.type}</b>　${esc(q.stem.slice(0, 40))}…</div>
          <div class="rm"><button class="btn ghost" data-rm="${esc(q.id)}">移除</button></div>
        </div>`).join('')}`);
    $('modalContent').querySelectorAll('[data-rm]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        delete progress[b.dataset.rm];
        store.set(KEY_PROGRESS, progress);
        renderFilters(); renderGrid(); renderCard();
        showWrongBook();
      });
    });
    $('modalContent').querySelectorAll('.wrong-item').forEach((el) => {
      el.addEventListener('click', () => {
        const q = findById(el.dataset.id);
        state.subject = q.subject;
        state.part = q.subject === '马克思主义哲学' ? q.part : '';
        state.type = q.type;
        render();
        showQuestion(q.id, true);
        closeModal();
      });
    });
  }

  function showStats() {
    const total = DATA.questions.length;
    const attempted = Object.entries(progress).filter(([, p]) => p && typeof p.correct === 'boolean');
    const correct = attempted.filter(([, p]) => p.correct).length;
    const rate = attempted.length ? Math.round((correct / attempted.length) * 100) : 0;

    const scopes = new Map();
    DATA.questions.forEach((q) => {
      const k = (q.part || q.subject) + ' · ' + q.type;
      if (!scopes.has(k)) scopes.set(k, { total: 0, done: 0, ok: 0 });
      const s = scopes.get(k);
      s.total++;
      const p = progress[q.id];
      if (p && typeof p.correct === 'boolean') { s.done++; if (p.correct) s.ok++; }
    });

    openModal('统计', `
      <div class="stat-grid">
        <div class="stat-cell"><div class="k">已做</div><div class="v">${attempted.length}<span style="font-size:13px;color:var(--ink-3)"> / ${total}</span></div></div>
        <div class="stat-cell"><div class="k">正确率</div><div class="v">${rate}%</div></div>
        <div class="stat-cell"><div class="k">错题</div><div class="v">${attempted.length - correct}</div></div>
        <div class="stat-cell"><div class="k">已导入答案</div><div class="v">${(DATA.meta && DATA.meta.answered) || 0}</div></div>
      </div>
      <table class="stat-table">
        <thead><tr><th>范围</th><th>进度</th><th>正确率</th></tr></thead>
        <tbody>
          ${[...scopes.entries()].map(([k, s]) => `
            <tr><td>${esc(k)}</td><td class="num">${s.done}/${s.total}</td>
            <td class="num">${s.done ? Math.round((s.ok / s.done) * 100) + '%' : '—'}</td></tr>`).join('')}
        </tbody>
      </table>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="exportBtn">导出做题记录</button>
        <button class="btn ghost" id="resetBtn">清空我的记录</button>
      </div>`);

    $('exportBtn').addEventListener('click', exportProgress);
    $('resetBtn').addEventListener('click', () => {
      if (!confirm('确定清空做题记录和手填答案？此操作不可撤销。')) return;
      progress = {};
      manual = {};
      store.set(KEY_PROGRESS, progress);
      store.set(KEY_STORE, manual);
      closeModal();
      location.reload();
    });
  }

  function exportProgress() {
    const payload = { exportedAt: new Date().toISOString(), progress, manual };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '政治刷题记录.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindGlobal() {
    $('jumpForm').addEventListener('submit', (e) => {
      e.preventDefault();
      jumpByNumber($('noInput').value);
      $('noInput').select();
    });

    $('searchInput').addEventListener('input', (e) => runSearch(e.target.value));
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = suggestEl.querySelector('button');
        if (first) first.click();
      }
      if (e.key === 'Escape') suggestEl.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search')) suggestEl.hidden = true;
    });

    $('randomBtn').addEventListener('click', () => {
      const list = currentList();
      const q = list[Math.floor(Math.random() * list.length)];
      if (q) showQuestion(q.id, true);
    });

    $('wrongBtn').addEventListener('click', showWrongBook);
    $('statsBtn').addEventListener('click', showStats);
    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

    $('modeBtn').addEventListener('click', () => {
      state.quiz = !state.quiz;
      state.submitted = false;
      state.revealed = false;
      state.picked = [];
      saveSettings();
      renderFilters();
      renderCard();
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (!$('modal').hidden) { if (e.key === 'Escape') closeModal(); return; }

      if (e.key === '/') { e.preventDefault(); $('noInput').focus(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goRelative(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); goRelative(1); return; }
      if (e.key.toLowerCase() === 'r') { $('randomBtn').click(); return; }
      if (e.key.toLowerCase() === 'm') { $('modeBtn').click(); return; }
      if (e.key === 'Enter') {
        if (state.quiz && !state.submitted && state.picked.length) { e.preventDefault(); submitAnswer(); }
        else if (state.quiz && state.submitted) { e.preventDefault(); goRelative(1); }
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 5) {
        const opt = cardEl.querySelector(`.option[data-opt="${'ABCDE'[n - 1]}"]`);
        if (opt) opt.click();
      }
    });
  }

  function render() {
    renderFilters();
    renderGrid();
    renderCard();
    renderFilters(); // 进度文本跟随
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bindGlobal();

    // 支持分享/书签直链：index.html?id=学科/部分/题型/题号&reveal=1
    let deep = null;
    try {
      const params = new URLSearchParams(location.search);
      const idParam = params.get('id');
      if (idParam) {
        deep = findById(idParam);
        if (deep) {
          state.subject = deep.subject;
          state.part = deep.subject === '马克思主义哲学' ? (deep.part || '') : '';
          state.type = deep.type;
          state.id = deep.id;
          state.revealed = params.get('reveal') === '1';
          state.quiz = false;
          if (state.revealed) markSeen(deep);
        }
      }
    } catch (e) { /* 老浏览器忽略 */ }

    const list = currentList();
    let startId = state.id;
    if (!startId || !findById(startId) || !list.some((q) => q.id === startId)) {
      startId = list.length ? list[0].id : null;
    }
    state.id = startId;
    render();
  }

  init();
})();
