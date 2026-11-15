/* 政治真题速查 —— 纯静态前端，数据来自 data/questions.js（window.ZZ_DATA） */
(function () {
  'use strict';

  const DATA = window.ZZ_DATA;
  const KW = window.ZZ_KW || {}; // 关键词标注（data/keywords.js），没标注的题不受影响
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
  // 答对后停留多久再翻页：默认 0.9 秒，可在「统计」→ 做题偏好里调
  const DEFAULT_AUTO_NEXT_MS = 900;
  const AUTO_NEXT_MS_OPTIONS = [400, 600, 900, 1500, 2000, 3000];

  function clampAutoNextMs(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return DEFAULT_AUTO_NEXT_MS;
    return Math.min(5000, Math.max(200, n));
  }

  // 900 → "0.9 秒"，2000 → "2 秒"
  function fmtDelay(ms) {
    const s = Math.round(ms / 100) / 10;
    return (s % 1 === 0 ? String(s) : s.toFixed(1)) + ' 秒';
  }

  // 答对自动翻页的定时器：翻题、切范围、开弹层时都要取消，避免跳两题
  let autoNextTimer = null;
  function clearAutoNext() {
    if (autoNextTimer) {
      clearTimeout(autoNextTimer);
      autoNextTimer = null;
    }
  }

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
      // 账号模块据此把改动推到云端（未登录/未配置时它自己会忽略）
      if (!suspendTouch && window.ZZ_ACCOUNT) window.ZZ_ACCOUNT.touch();
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    }
  };

  let manual = store.get(KEY_STORE, {});
  let progress = store.get(KEY_PROGRESS, {});
  let suspendTouch = false; // 从云端套用数据时不要再触发上传

  // 记录题库原始答案，全部重置时把手填覆盖还原回去
  const originalAnswers = new Map(
    DATA.questions.map((q) => [q.id, { answer: q.answer, explain: q.explain, source: q.answerSource }])
  );

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
    quiz: settings.quiz !== undefined ? settings.quiz !== false : hasAnswers,
    autoNext: settings.autoNext !== false, // 答对自动下一题，默认开
    autoNextMs: clampAutoNextMs(settings.autoNextMs), // 停留时长，默认 900ms
    showKw: settings.showKw !== false, // 题干/选项里标手册关键词，默认开
    paper: null // 正在做的套卷：{ids, answers, startedAt}
  };

  if (state.subject !== '马克思主义哲学') state.part = '';

  /* ---------------- 工具 ---------------- */
  function scopeKey(q) {
    return q.subject + '|' + (q.subject === '马克思主义哲学' ? (q.part || '') : '') + '|' + q.type;
  }

  function currentScope() {
    return state.subject + '|' + (state.subject === '马克思主义哲学' ? state.part : '') + '|' + state.type;
  }

  // 复习清单 / 套卷用同一条「当前列表」通道：有清单就用清单，有套卷就用套卷，否则按题区
  let reviewQueue = [];
  let queuePos = 0;

  function paperQuestions() {
    if (!state.paper || !state.paper.ids) return null;
    return state.paper.ids.map((id) => findById(id)).filter(Boolean);
  }

  function currentList() {
    const paper = paperQuestions();
    if (paper && paper.length) return paper;
    if (reviewQueue.length) {
      const qs = reviewQueue.map((id) => findById(id)).filter(Boolean);
      if (qs.length) return qs;
    }
    return byScope.get(currentScope()) || [];
  }

  function inPaper() {
    return !!(state.paper && state.paper.ids && state.paper.ids.length);
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
    // 套卷进行中：隐藏题区筛选，换成套卷信息条
    const paperOn = inPaper();
    $('filters').hidden = paperOn;
    $('paperBar').hidden = !paperOn;
    if (paperOn) renderPaperBar();

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
    clearAutoNext();
    // 用户自己跳走了（点题号、搜题、随机），复习清单就自动收起来
    if (reviewQueue.length && reviewQueue[queuePos] !== id) clearQueue();
    state.id = id;
    state.type = q.type; // 套卷 / 复习清单会跨题型跳转，题型必须跟着题走
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
      subject: state.subject, part: state.part, type: state.type, quiz: state.quiz, id: state.id,
      autoNext: state.autoNext, autoNextMs: state.autoNextMs, showKw: state.showKw,
      kb: settings.kb || {}, // 知识点卡片的「已复习」勾选（k → 时间戳）
      kbMem: settings.kbMem || {} // 知识点卡片的三档记忆（k → {level, ts}），与选择题错题分开
    });
  }

  /* ---------------- 关键词标记 ---------------- */
  // 一条标记的提示文案：写了 note 用 note，否则用“知识点 xxx · Pxx”
  function kwTip(item) {
    if (item.note) return item.note;
    if (item.k) return '知识点 ' + item.k + (item.page ? ' · ' + item.page : '');
    if (item.c === 'core') return '核心词：答案的落点';
    if (item.c === 'none') return '手册暂未收录，但本题常考';
    if (item.c === 'ok') return '手册里的正误判断';
    return '限定 / 陷阱词：注意前提、主体与范围';
  }

  // 关键词只在「答案已经展开」时出现：自测提交后、点过「直接看答案」、套卷提交后。
  // 答之前只显示纯题目文本，避免标注泄题。
  function kwVisible() {
    return !!state.showKw && state.revealed;
  }

  // 在已转义的文本上包 <span class="kw kw-xxx" data-tip>；
  // 一遍扫描：每次只从「还没包过的纯文本」里找最靠前（同位置取最长）的标记，
  // 插进去的 span 不参与后续查找，避免标记串到别的提示文字里把 HTML 弄坏。
  function markKw(escapedText, items) {
    if (!kwVisible() || !items || !items.length) return escapedText;
    const clsOf = { core: 'kw kw-core', limit: 'kw kw-limit', none: 'kw kw-none', ok: 'kw kw-ok' };
    const pend = items
      .map((item) => ({ item, needle: esc(item.t) }))
      .filter((x) => x.needle && escapedText.indexOf(x.needle) >= 0);

    let out = '';
    let rest = escapedText;
    while (pend.length && rest) {
      let hit = -1;
      let pick = null;
      pend.forEach((x, i) => {
        const at = rest.indexOf(x.needle);
        if (at < 0) return;
        if (hit < 0 || at < hit || (at === hit && x.needle.length > pend[hit].needle.length)) {
          hit = at;
          pick = i;
        }
      });
      if (pick === null) break;
      const { item, needle } = pend.splice(pick, 1)[0];
      const cls = clsOf[item.c] || clsOf.core;
      out += rest.slice(0, hit)
        + '<span class="' + cls + '" data-tip="' + esc(kwTip(item)) + '">' + needle + '</span>';
      rest = rest.slice(hit + needle.length);
    }
    return out + rest;
  }

  function renderCard() {
    if (!state.quiz) {
      // 背题模式：主区整块换成知识点卡片（全屏单张翻阅），不再出选择题
      cardEl.innerHTML = MAN_CARDS.length
        ? deckHTML()
        : '<div class="empty-state">手册卡片数据还没加载好。</div>';
      return;
    }
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
    const kwStem = (KW[q.id] && KW[q.id].stem) || null;

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
      const kwOpts = (KW[q.id] && KW[q.id].opts) || {};
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
        <span class="letter">${o.key}</span><span class="opt-text">${markKw(esc(o.text), kwOpts[o.key])}</span>
        ${showAnswer && answerLetters.includes(o.key) ? '<span class="opt-mark ok">✓ 正确</span>' : ''}
        ${showAnswer && picked && !answerLetters.includes(o.key) ? '<span class="opt-mark bad">✗ 你选的</span>' : ''}
      </button>`;
    }).join('');

    // 判分结果横幅：手机上一眼能看清对错
    let verdict = '';
    if (solved && state.submitted) {
      const mine = (p.picked || []).slice().sort().join('');
      verdict = p.correct
        ? `<div class="verdict ok">✅ 答对了<span>答案 ${esc(q.answer)}</span></div>`
        : `<div class="verdict bad">❌ 答错了<span>你选 ${esc(mine || '—')} ｜ 正确答案 ${esc(q.answer)} ｜ 解析见下方</span></div>`;
    }

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
        // 自测已提交：答对→自动进下一题；答错→留在本题看解析
        const canAdvance = idx >= 0 && idx < list.length - 1;
        const hint = p && p.correct
          ? (!canAdvance
              ? '答对了 · 已经是本题区最后一题'
              : state.autoNext ? `答对了，${fmtDelay(state.autoNextMs)}后自动进入下一题…` : '答对了 · 点「下一题」继续')
          : '答错了 · 已留在本题，解析见下方';
        actions = `<button class="btn primary" id="nextBtn" ${canAdvance ? '' : 'disabled'}>下一题 →</button>
          <button class="btn ghost" id="prevBtn" ${idx <= 0 ? 'disabled' : ''}>← 上一题</button>
          <span class="hint">${hint}</span>`;
      }
    } else {
      actions = `<button class="btn primary" id="revealBtn" title="显示答案后才会出现关键词标注">${revealed ? '收起答案' : '显示答案'}</button>
        <button class="btn ghost" id="prevBtn" ${idx <= 0 ? 'disabled' : ''}>← 上一题</button>
        <button class="btn ghost" id="nextBtn" ${idx >= list.length - 1 ? 'disabled' : ''}>下一题 →</button>
        <span class="hint">${revealed ? '答案与关键词标注已展开' : '先自己作答，再展开答案'}</span>`;
    }

    // 记忆程度只属于知识点卡片（见 kdeck-mem），题目上不再出现

    // 复习清单的进度条（从复习中心「一键生成清单」进来时出现）
    const qbar = reviewQueue.length ? `
      <div class="qbar">
        <span class="qbar-pos">复习清单 ${queuePos + 1} / ${reviewQueue.length}</span>
        <button class="btn ghost" data-qnav="-1" ${queuePos <= 0 ? 'disabled' : ''}>← 上一题</button>
        <button class="btn ghost" data-qnav="1" ${queuePos >= reviewQueue.length - 1 ? 'disabled' : ''}>下一题 →</button>
        <button class="btn ghost" data-qexit>退出清单</button>
      </div>` : '';

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
          <div class="explain-head">解析</div>
          <p class="explain ${q.explain ? '' : 'empty'}">${q.explain ? esc(q.explain) : '这道题暂时只有答案，还没有讲解。'}</p>
          ${kpRow(q)}
        </div>`;
      } else {
        answerBox = `<div class="pending">
          <strong>答案待导入。</strong>把带答案的文件放进 <code>import/</code> 目录后运行导入命令，或直接在这里手填。
          <div id="manualSlot"></div>
        </div>`;
      }
    } else if (!state.quiz) {
      // 背题模式已整块换成知识点卡片（renderCard 开头 return），这里不会走到
      answerBox = '';
    }

    cardEl.innerHTML = `${head}${dupeRow}
      <p class="stem">${markKw(esc(q.stem), kwStem)}</p>
      <div class="options">${options}</div>
      ${verdict}
      ${qbar}
      <div class="card-actions">${actions}</div>
      ${answerBox}`;

    bindCardEvents(q, list, idx, revealed);
  }

  function bindCardEvents(q, list, idx, revealed) {
    cardEl.querySelectorAll('[data-jump]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); showQuestion(a.dataset.jump, false); });
    });

    // 解析下方「考点卡片」→ 打开对应知识点卡
    cardEl.querySelectorAll('[data-kp]').forEach((b) => {
      b.addEventListener('click', () => enterCardMode(b.dataset.kp));
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
        clearAutoNext();
        state.revealed = !state.revealed;
        if (state.revealed) markSeen(q);
        renderCard();
        renderGrid();
        renderFilters();
        if (state.revealed) scrollToResult(false);
      });
    }

    const submitBtn = $('submitBtn');
    if (submitBtn) submitBtn.addEventListener('click', () => submitAnswer());

    // 复习清单内翻题
    cardEl.querySelectorAll('[data-qnav]').forEach((btn) => {
      btn.addEventListener('click', () => queueStep(Number(btn.dataset.qnav)));
    });
    const qexit = cardEl.querySelector('[data-qexit]');
    if (qexit) {
      qexit.addEventListener('click', () => {
        clearQueue();
        renderCard();
        renderGrid();
        renderFilters();
      });
    }

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
    // 套卷另行记账：交卷按这份 answers 算分，不受以前做过的影响
    if (state.paper) {
      state.paper.answers[q.id] = { picked: state.picked.slice(), correct, ts: Date.now() };
    }
    state.submitted = true;
    state.revealed = true;
    renderCard();
    renderGrid();
    renderFilters();
    scrollToResult(correct);
    scheduleAutoNext(q, correct);
  }

  // 手机上提交后把结果滚进视野：答对看判分横幅，答错直接看解析
  function scrollToResult(correct) {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    setTimeout(() => {
      const v = cardEl.querySelector(correct ? '.verdict' : '.answer-box') ||
        cardEl.querySelector('.verdict');
      if (v) v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  // 答对自动翻到下一题；答错停在本题，解析已经展开
  function scheduleAutoNext(q, correct) {
    clearAutoNext();
    if (!correct || !state.autoNext || !state.quiz) return;
    const list = currentList();
    const idx = list.findIndex((x) => x.id === q.id);
    if (idx < 0 || idx >= list.length - 1) return; // 本题区最后一题不翻
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      // 这段时间里用户可能自己翻了页、切了范围或打开弹层，确认还停在原题再翻
      if (state.id !== q.id || !state.submitted) return;
      goRelative(1);
    }, state.autoNextMs);
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
        suggestEl.hidden = true;
        $('searchInput').value = '';
        jumpToQuestion(b.dataset.id);
      });
    });
  }

  /* ---------------- 弹层 ---------------- */
  function openModal(title, html) {
    clearAutoNext();
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
        jumpToQuestion(el.dataset.id);
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
      <div class="pref-row">
        <label class="pref">
          <input type="checkbox" id="autoNextCb" ${state.autoNext ? 'checked' : ''}>
          <span>答对后自动进入下一题</span>
        </label>
        <label class="pref pref-delay">
          <span>停留</span>
          <select id="autoNextMs" aria-label="答对后自动跳转的停留时长">
            ${[...new Set([...AUTO_NEXT_MS_OPTIONS, state.autoNextMs])]
              .sort((a, b) => a - b)
              .map((ms) => `<option value="${ms}"${ms === state.autoNextMs ? ' selected' : ''}>${fmtDelay(ms)}</option>`)
              .join('')}
          </select>
          <span>再翻页</span>
        </label>
        <span class="pref-hint">答错则停留在本题，自动展开解析</span>
      </div>
      <div class="pref-row">
        <label class="pref">
          <input type="checkbox" id="kwCb" ${state.showKw ? 'checked' : ''}>
          <span>在题目里标出关键词</span>
        </label>
        <span class="pref-hint">答题之后（提交或直接看答案）才出现；答题前只显示纯题目</span>
      </div>
      <div class="pref-row">
        <span class="pref"><b style="font-weight:600">知识点卡片</b>　熟悉 ${kbMemCount('known')} · 模糊 ${kbMemCount('fuzzy')} · 未掌握 ${kbMemCount('unknown')} · 已复习 ${kbDoneCount()} / ${MAN_CARDS.length}</span>
        <button class="btn ghost" id="kbFromStats">去背卡片</button>
        <button class="btn ghost" id="rvFromStats">复习中心</button>
        <button class="btn ghost" id="paperFromStats">组一套卷</button>
        <span class="pref-hint">卡片在「背题」模式里翻；三档记忆只记在卡片上，与选择题错题分开存</span>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="exportBtn">导出做题记录</button>
        <button class="btn ghost" id="openReset">二刷 / 重置 →</button>
      </div>`);

    $('exportBtn').addEventListener('click', exportProgress);
    $('openReset').addEventListener('click', showResetModal);
    const autoNextCb = $('autoNextCb');
    if (autoNextCb) {
      autoNextCb.addEventListener('change', (e) => {
        state.autoNext = e.target.checked;
        saveSettings();
        renderCard();
      });
    }
    const autoNextMsSel = $('autoNextMs');
    if (autoNextMsSel) {
      autoNextMsSel.addEventListener('change', (e) => {
        state.autoNextMs = clampAutoNextMs(e.target.value);
        saveSettings();
        renderCard();
      });
    }
    const kwCb = $('kwCb');
    if (kwCb) {
      kwCb.addEventListener('change', (e) => {
        state.showKw = e.target.checked;
        saveSettings();
        renderCard();
      });
    }
    const kbFromStats = $('kbFromStats');
    if (kbFromStats) {
      kbFromStats.addEventListener('click', () => { closeModal(); enterCardMode(); });
    }
    const rvFromStats = $('rvFromStats');
    if (rvFromStats) {
      rvFromStats.addEventListener('click', () => { closeModal(); openReview(); });
    }
    const paperFromStats = $('paperFromStats');
    if (paperFromStats) {
      paperFromStats.addEventListener('click', paperIntro);
    }
  }

  function showResetModal() {
    openModal('二刷 / 重置', `
      <div class="reset-box" style="margin-top:0;border-top:0;padding-top:0">
        <p class="reset-hint">
          想从头再刷一遍，就点 <b>重置做题记录</b>：所有题回到未做状态，错题本清空，正确率归零，
          <b>手填的答案会保留</b>。
        </p>
        <div class="reset-actions">
          <button class="btn primary" id="resetProgress">重置做题记录</button>
          <button class="btn ghost" id="resetWrong">只清错题本</button>
          <button class="btn ghost danger" id="resetAll">全部重置（含手填）</button>
        </div>
        <p class="reset-hint" style="margin-top:12px">
          当前：已做 <b>${Object.values(progress).filter((p) => p && typeof p.correct === 'boolean').length}</b> 题、
          错题 <b>${Object.values(progress).filter((p) => p && p.correct === false).length}</b> 道、
          手填答案 <b>${Object.keys(manual).length}</b> 条。
        </p>
      </div>`);
    $('resetWrong').addEventListener('click', () => resetData('wrong'));
    $('resetProgress').addEventListener('click', () => resetData('progress'));
    $('resetAll').addEventListener('click', () => resetData('all'));
  }

  function resetData(mode) {
    const message = mode === 'wrong'
      ? '清空错题本？正确率与已做题数不受影响。'
      : mode === 'progress'
        ? '重置做题记录？\n所有题会回到未做状态，错题本清空，手填答案保留。'
        : '全部重置？\n做题记录和手填答案都会清空，且无法恢复。';
    if (!confirm(message)) return;

    if (mode === 'wrong') {
      Object.keys(progress).forEach((id) => {
        const p = progress[id];
        if (p && p.correct === false) delete progress[id];
      });
    } else if (mode === 'progress') {
      progress = {};
    } else {
      progress = {};
      manual = {};
      DATA.questions.forEach((q) => {
        const orig = originalAnswers.get(q.id);
        if (orig) {
          q.answer = orig.answer;
          q.explain = orig.explain;
          q.answerSource = orig.source;
        }
      });
      store.set(KEY_STORE, manual);
    }
    store.set(KEY_PROGRESS, progress);
    if (mode === 'all') {
      // 统一清空：卡片已复习 + 卡片三档记忆（选择题错题已经在上面清掉了）
      settings.kb = {};
      settings.kbMem = {};
      saveSettings();
      deck.shown = Object.create(null);
      deck.idx = 0;
    }
    clearQueue();
    clearAutoNext();
    state.submitted = false;
    state.revealed = false;
    state.picked = [];
    closeModal();
    render();
    renderCard();
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

  /* ---------------- 题目 → 知识点卡片 ---------------- */
  // 这道题用到的手册知识点（去重、按编号）
  function kbUsedIn(q) {
    const entry = KW[q.id];
    if (!entry) return [];
    const seen = new Set();
    const out = [];
    const take = (it) => {
      if (!it || !it.k || seen.has(it.k) || !KB_BY_K.has(it.k)) return;
      seen.add(it.k);
      out.push(KB_BY_K.get(it.k));
    };
    (entry.stem || []).forEach(take);
    Object.keys(entry.opts || {}).forEach((letter) => (entry.opts[letter] || []).forEach(take));
    return out.sort((a, b) => (a.k < b.k ? -1 : 1));
  }

  function kpRow(q) {
    const used = kbUsedIn(q);
    if (!used.length) return '';
    return `<div class="kp-row">
      <span class="kp-head">考点卡片</span>
      ${used.map((p) => `<button class="kp-chip" data-kp="${esc(p.k)}">${esc(p.k)} · ${esc(p.title)}<i>${esc(p.page)}</i></button>`).join('')}
    </div>`;
  }

  /* ---------------- 知识点手册（卡片复习） ---------------- */
  // 数据来自 data/handbook.js：手册 35 页逐页转录出的 100 个知识点、585 条彩色词句
  const KB = (window.ZZ_KB && window.ZZ_KB.points) ? window.ZZ_KB : { chapters: [], points: [] };
  const KB_CHAPTERS = KB.chapters || [];
  const KB_POINTS = (KB.points || []).slice().sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const KB_BY_K = new Map(KB_POINTS.map((p) => [p.k, p]));
  const KB_CHAP_NAME = new Map(KB_CHAPTERS.map((c) => [c.id, c.name]));
  const Q_BY_ID = new Map(DATA.questions.map((q) => [q.id, q]));

  // 反查：知识点 → 挂了这条知识点的真题（复用题目里已有的关键词标注，不改题库、不改标注）
  const KB_RELATED = new Map();
  Object.keys(KW).forEach((id) => {
    const entry = KW[id];
    if (!entry) return;
    const seen = new Set();
    const take = (it) => {
      if (!it || !it.k || seen.has(it.k) || !KB_BY_K.has(it.k)) return;
      seen.add(it.k);
      if (!KB_RELATED.has(it.k)) KB_RELATED.set(it.k, new Set());
      KB_RELATED.get(it.k).add(id);
    };
    (entry.stem || []).forEach(take);
    Object.keys(entry.opts || {}).forEach((letter) => (entry.opts[letter] || []).forEach(take));
  });

  function kbRelated(k) {
    const set = KB_RELATED.get(k);
    if (!set) return [];
    return Array.from(set)
      .map((id) => Q_BY_ID.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.year - b.year) || (a.no - b.no) || (a.id < b.id ? -1 : 1));
  }

  function kbStore() {
    if (!settings.kb || typeof settings.kb !== 'object') settings.kb = {};
    return settings.kb;
  }
  function kbIsDone(k) { return !!kbStore()[k]; }
  function kbDoneCount() { return KB_POINTS.filter((p) => kbIsDone(p.k)).length; }

  /* ---------------- 知识点卡片：全屏单张翻阅 ---------------- */
  const MAN_PAGES = (window.ZZ_MANUAL && window.ZZ_MANUAL.pages) || [];
  const MAN_CARDS = [];
  MAN_PAGES.forEach((page) => {
    (page.cols || []).forEach((col) => col.forEach((c) => {
      MAN_CARDS.push({ k: c.k, title: c.title, paras: c.paras || [], printed: page.printed, sections: page.sections || [] });
    }));
  });
  MAN_CARDS.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const CARD_BY_K = new Map(MAN_CARDS.map((c, i) => [c.k, i]));

  const KB_LEVELS = ['known', 'fuzzy', 'unknown'];
  const KB_LEVEL_LABEL = { known: '熟悉', fuzzy: '模糊', unknown: '未掌握' };
  const CARD_SUBJECT = { 马原: '马克思主义哲学', 史纲: '史纲要', 毛中特: '毛中特+习思想', 思法: '思法', 当代: '思法' };

  function cardSubject(card) {
    const sec = (card.sections || [])[0];
    return CARD_SUBJECT[sec] || '';
  }

  // 卡片的三档记忆与选择题错题分开存：settings.kbMem / settings.progress
  function kbMemStore() {
    if (!settings.kbMem || typeof settings.kbMem !== 'object') settings.kbMem = {};
    return settings.kbMem;
  }
  function kbMemLevel(k) {
    const e = kbMemStore()[k];
    return (e && e.level) || '';
  }
  function setKbMem(k, level) {
    const st = kbMemStore();
    if (st[k] && st[k].level === level) delete st[k];
    else st[k] = { level: level, ts: Date.now() };
    saveSettings();
  }
  function kbMemCount(level) {
    let n = 0;
    MAN_CARDS.forEach((c) => { if (kbMemLevel(c.k) === level) n++; });
    return n;
  }
  function kbMarkedCount() {
    let n = 0;
    MAN_CARDS.forEach((c) => { if (kbMemLevel(c.k)) n++; });
    return n;
  }

  // 浏览位置：背题模式内嵌的卡片与全屏浮层共用同一份
  const deck = { idx: 0, shown: Object.create(null) };

  function kwCls(c) {
    return c === 'core' ? 'kw-core' : c === 'warm' ? 'kw-warm' : c === 'ok' ? 'kw-ok' : c === 'none' ? 'kw-none' : 'kw-limit';
  }

  // 在纯文本上按手册彩色词条加高亮：一遍扫描，取最靠前（同位置取最长）的一条，互不重叠
  // items 里的 p 字段 = 只在这张卡的第 p 段生效（手册常只给一个锚点字上色，靠段落定位重复字）
  function kbHl(text, items, pi) {
    const list = (items || []).filter((it) => it && it.t && (it.p === undefined || it.p === pi));
    if (!list.length) return esc(text);
    let out = '';
    let rest = text;
    while (rest.length) {
      let at = -1;
      let pick = null;
      list.forEach((it) => {
        const p = rest.indexOf(it.t);
        if (p < 0) return;
        if (at < 0 || p < at || (p === at && it.t.length > pick.t.length)) { at = p; pick = it; }
      });
      if (at < 0) { out += esc(rest); break; }
      out += esc(rest.slice(0, at));
      out += '<span class="kw ' + kwCls(pick.c) + '">' + esc(pick.t) + '</span>';
      rest = rest.slice(at + pick.t.length);
    }
    return out;
  }

  // 卡片下方的小图例：和 PDF 上的三种颜色一一对应
  function deckLegendHTML(card, point) {
    const paras = card.paras || [];
    const items = (point.items || []).filter((it) => it && it.t);
    if (!items.length) return '';
    const has = (cls) => items.some((it) => kwCls(it.c) === cls && paras.some((p) => p.indexOf(it.t) >= 0));
    if (!has('kw-core') && !has('kw-warm') && !has('kw-limit') && !has('kw-ok')) return '';
    const row = (cls, name, desc) => (has(cls)
      ? `<span class="kleg"><i class="kleg-s ${cls}"></i>${name}<b>${desc}</b></span>`
      : '');
    return `<div class="kdeck-legend">${row('kw-core', '红', '核心结论（答案落点）')}`
      + `${row('kw-warm', '橙', '强调补充（举例 / 助记）')}`
      + `${row('kw-limit', '蓝', '前提限定（主体 / 范围 / 条件）')}`
      + `${row('kw-ok', '绿', '正误判断（手册 ✅ / ❌ 的行）')}</div>`;
  }

  function deckSub(card) {
    const tags = (card.sections || []).join(' · ');
    return [card.printed, tags].filter(Boolean).join(' · ');
  }

  function deckMarkedHTML(k) {
    const lv = kbMemLevel(k);
    const at = lv && kbMemStore()[k] ? kbMemStore()[k].ts : 0;
    return `<div class="kdeck-mem">
      <span class="kdeck-mem-label">记忆程度</span>
      ${KB_LEVELS.map((x) => `<button class="mem-btn${lv === x ? ' on ' + x : ''}" data-kbmem="${x}">${KB_LEVEL_LABEL[x]}</button>`).join('')}
      <span class="kdeck-mem-hint">${lv
        ? '已记：' + KB_LEVEL_LABEL[lv] + ' · ' + new Date(at).toLocaleDateString('zh-CN')
        : '标记后进复习中心汇总；与选择题错题分开记录'}</span>
    </div>`;
  }

  // 少数卡片在手册里原本就是图（不是文字），这里用矢量图原样交付
  // 宽屏一张六段横排，窄屏换成单列版本（同一份内容，一行一件事），保证手机上字号可读
  const CARD_FIGURE = {
    '037': {
      src: 'assets/timeline-037.svg',
      narrow: 'assets/timeline-037-v.svg',
      alt: '史纲整体脉络时间轴：1840 年至今六个阶段与关键事件',
    },
  };

  function deckFigureHTML(fig) {
    if (fig.narrow) {
      return `<picture class="kdeck-fig">
        <source media="(max-width: 820px)" srcset="${fig.narrow}">
        <img src="${fig.src}" alt="${esc(fig.alt)}" loading="lazy">
      </picture>`;
    }
    return `<div class="kdeck-fig"><img src="${fig.src}" alt="${esc(fig.alt)}" loading="lazy"></div>`;
  }

  function deckCardHTML(i) {
    const card = MAN_CARDS[i];
    if (!card) return '<div class="empty-state">手册数据还没加载好。</div>';
    const point = KB_BY_K.get(card.k) || { items: [] };
    const shown = !!deck.shown[card.k];
    const rel = kbRelated(card.k);
    const fig = CARD_FIGURE[card.k];
    const body = shown
      ? (fig
        ? deckFigureHTML(fig)
        : `<div class="kdeck-paras">${(card.paras || []).map((p, pi) => '<p>' + kbHl(p, point.items, pi) + '</p>').join('')}</div>`
          + deckLegendHTML(card, point))
        + (rel.length
          ? `<div class="kdeck-rel"><div class="kdeck-rel-head">相关真题 ${rel.length} 道 · 点一下回到题目</div>`
            + rel.map((q) => `<button class="kb-q" data-q="${esc(q.id)}">${esc(q.type)} ${q.no}<i>${q.year}</i></button>`).join('')
            + '</div>'
          : '')
        + deckMarkedHTML(card.k)
      : `<button class="kdeck-veil" data-reveal>
           <b>点击查看这张卡</b>
           <span>${fig ? '这是一张时间轴图，点开看大图' : '先自己回忆：这个知识点讲什么，再点开对照全文'}</span>
         </button>`;
    return `<article class="kdeck-card${shown ? ' shown' : ''}" data-k="${esc(card.k)}">
      <div class="kdeck-head">
        <span class="kdeck-k">知识点 ${esc(card.k)}</span>
        <span class="kdeck-page">${esc(deckSub(card))}</span>
        <span class="kdeck-pos">${i + 1} / ${MAN_CARDS.length}</span>
      </div>
      <h2 class="kdeck-title">${esc((KB_BY_K.get(card.k) || {}).title || card.title)}</h2>
      <div class="kdeck-body">${body}</div>
    </article>`;
  }

  function deckNavHTML() {
    return `<div class="kdeck-nav">
      <button class="btn ghost" data-knav="-1" ${deck.idx <= 0 ? 'disabled' : ''}>← 上一张</button>
      <span class="kdeck-count">${MAN_CARDS.length ? deck.idx + 1 : 0} / ${MAN_CARDS.length}</span>
      <button class="btn ghost" data-knav="1" ${deck.idx >= MAN_CARDS.length - 1 ? 'disabled' : ''}>下一张 →</button>
      <button class="btn ghost" data-toc>目录</button>
    </div>`;
  }

  function deckHTML() {
    return '<div class="kdeck">' + deckCardHTML(deck.idx) + deckNavHTML() + '</div>';
  }

  function deckGo(delta) {
    const next = Math.min(Math.max(deck.idx + delta, 0), MAN_CARDS.length - 1);
    if (next === deck.idx) return;
    deck.idx = next;
    renderDeck();
  }

  function deckSet(k) {
    if (CARD_BY_K.has(k)) deck.idx = CARD_BY_K.get(k);
    deck.shown[k] = true;
    renderDeck();
  }

  function renderDeck() {
    if (MAN_CARDS.length && !state.quiz) cardEl.innerHTML = deckHTML();
    if (tocOpen) renderToc();
  }

  function kbSubText() {
    return MAN_CARDS.length + ' 张卡 · 已标记 ' + kbMarkedCount()
      + ' · 熟悉 ' + kbMemCount('known') + ' · 模糊 ' + kbMemCount('fuzzy') + ' · 未掌握 ' + kbMemCount('unknown');
  }

  /* ---------------- 背题模式的卡片目录（按章节 / 按页码） ---------------- */
  let tocMode = 'chapter';
  let tocOpen = false;

  function tocGroups() {
    if (tocMode === 'page') {
      return MAN_PAGES.map((p) => {
        const cards = (p.cols || []).flat();
        return {
          title: '第 ' + p.printed + ' 页' + (p.sections && p.sections.length ? ' · ' + p.sections.join(' / ') : ''),
          meta: cards.length + ' 张',
          cards: cards.map((c) => ({ k: c.k, title: c.title })),
        };
      });
    }
    const groups = KB_CHAPTERS.map((ch) => ({
      title: ch.name,
      meta: ch.kfrom + '–' + ch.kto + ' · ' + ch.pages,
      cards: MAN_CARDS.filter((c) => c.k >= ch.kfrom && c.k <= ch.kto),
    })).filter((g) => g.cards.length);
    const covered = new Set(groups.flatMap((g) => g.cards.map((c) => c.k)));
    const rest = MAN_CARDS.filter((c) => !covered.has(c.k));
    if (rest.length) {
      groups.push({ title: '其他', meta: rest[0].k + '–' + rest[rest.length - 1].k, cards: rest });
    }
    return groups;
  }

  function tocChip(c) {
    const lv = kbMemLevel(c.k);
    const on = CARD_BY_K.get(c.k) === deck.idx;
    const title = (KB_BY_K.get(c.k) || {}).title || c.title || '';
    return `<button class="ktoc-card${on ? ' on' : ''}" data-kjump="${esc(c.k)}">`
      + `<i>${esc(c.k)}</i><span>${esc(title)}</span>`
      + (lv ? `<em class="ktoc-dot ${lv}"></em>` : '')
      + '</button>';
  }

  function renderToc() {
    const panel = $('ktocPanel');
    if (!panel) return;
    const groups = tocGroups();
    panel.innerHTML = `<div class="ktoc-box" role="dialog" aria-modal="true" aria-label="卡片目录">
      <header class="ktoc-head">
        <div class="ktoc-title"><b>卡片目录</b><p>${esc(kbSubText())}</p></div>
        <div class="ktoc-seg">
          <button class="${tocMode === 'chapter' ? 'active' : ''}" data-tocmode="chapter">按章节</button>
          <button class="${tocMode === 'page' ? 'active' : ''}" data-tocmode="page">按页码</button>
        </div>
        <button class="btn ghost" data-tocclose>关闭</button>
      </header>
      <div class="ktoc-body">
        ${groups.map((g) => `<section class="ktoc-g">
          <h4>${esc(g.title)}<span>${esc(g.meta)}</span></h4>
          <div class="ktoc-cards">${g.cards.map(tocChip).join('')}</div>
        </section>`).join('')}
      </div>
    </div>`;
    const cur = panel.querySelector('.ktoc-card.on');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  function openToc() {
    if (state.quiz || !MAN_CARDS.length) return;
    tocOpen = true;
    $('ktocPanel').hidden = false;
    document.body.classList.add('toc-open');
    renderToc();
  }

  function closeToc() {
    tocOpen = false;
    $('ktocPanel').hidden = true;
    document.body.classList.remove('toc-open');
  }

  // 从题目里的「考点卡片」或统计页进来：切到背题（卡片）并定位
  function enterCardMode(k) {
    if (!MAN_CARDS.length) return;
    clearAutoNext();
    closeToc();
    state.quiz = false;
    state.submitted = false;
    state.revealed = false;
    state.picked = [];
    document.body.classList.add('card-mode');
    if (k && CARD_BY_K.has(k)) {
      deck.idx = CARD_BY_K.get(k);
      deck.shown[k] = true;
    }
    renderFilters();
    renderGrid();
    renderDeck();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 卡片交互：翻页 / 展开 / 记忆档位 / 跳真题 / 目录（委托到常驻容器，页面重绘不用重绑）
  function deckClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-tocclose]')) { e.preventDefault(); closeToc(); return; }
    const jump = t.closest('[data-kjump]');
    if (jump) { e.preventDefault(); deckSet(jump.dataset.kjump); closeToc(); return; }
    const seg = t.closest('[data-tocmode]');
    if (seg) { e.preventDefault(); tocMode = seg.dataset.tocmode; renderToc(); return; }
    if (t.closest('[data-toc]')) { e.preventDefault(); tocOpen ? closeToc() : openToc(); return; }
    const card = t.closest('.kdeck-card');
    const k = card ? card.dataset.k : '';
    const nav = t.closest('[data-knav]');
    if (nav) { e.preventDefault(); deckGo(Number(nav.dataset.knav)); return; }
    const rev = t.closest('[data-reveal]');
    if (rev && k) { e.preventDefault(); deck.shown[k] = true; renderDeck(); return; }
    const lv = t.closest('[data-kbmem]');
    if (lv && k) { e.preventDefault(); setKbMem(k, lv.dataset.kbmem); renderDeck(); return; }
    const rel = t.closest('[data-q]');
    if (rel) { e.preventDefault(); jumpToQuestion(rel.dataset.q); }
  }

  function bindDeck() {
    cardEl.addEventListener('click', deckClick);
    const panel = $('ktocPanel');
    if (panel) {
      panel.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'ktocPanel') { closeToc(); return; }
        deckClick(e);
      });
    }

    let sx = 0;
    let sy = 0;
    const start = (e) => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; };
    const end = (e) => {
      const p = e.changedTouches[0];
      const dx = p.clientX - sx;
      const dy = p.clientY - sy;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.6) deckGo(dx < 0 ? 1 : -1);
    };
    cardEl.addEventListener('touchstart', start, { passive: true });
    cardEl.addEventListener('touchend', end, { passive: true });
  }

  /* ---------------- 复习清单队列 ---------------- */
  function clearQueue() {
    reviewQueue = [];
    queuePos = 0;
  }

  function jumpToQuestion(id) {
    const q = findById(id);
    if (!q) return;
    state.subject = q.subject;
    state.part = q.subject === '马克思主义哲学' ? (q.part || '') : '';
    state.type = q.type;
    // 背题模式现在是卡片，跳题时切回自测视图
    if (!state.quiz) {
      state.quiz = true;
      state.submitted = false;
      state.revealed = false;
      state.picked = [];
      document.body.classList.remove('card-mode');
      renderFilters();
      renderGrid();
    }
    showQuestion(q.id, true);
    renderFilters();
  }

  function startQueue(ids) {
    const uniq = [...new Set(ids)].map((id) => findById(id)).filter(Boolean);
    if (!uniq.length) return;
    reviewQueue = uniq.map((q) => q.id);
    queuePos = 0;
    closeReview();
    jumpToQuestion(reviewQueue[0]);
  }

  function queueStep(delta) {
    const next = queuePos + delta;
    if (next < 0 || next >= reviewQueue.length) return;
    queuePos = next;
    jumpToQuestion(reviewQueue[queuePos]);
  }

  /* ---------------- 复习中心（错题 + 记忆程度） ---------------- */
  const rvView = { range: 'today', date: '', subject: 'all' };
  let rvGenerated = [];

  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function rvWindow() {
    if (rvView.date) {
      const t = new Date(rvView.date + 'T00:00:00').getTime();
      if (isFinite(t)) return [t, t + 86400000];
    }
    const today = dayStart(Date.now());
    if (rvView.range === 'today') return [today, Infinity];
    if (rvView.range === '7') return [today - 6 * 86400000, Infinity];
    if (rvView.range === '30') return [today - 29 * 86400000, Infinity];
    return [0, Infinity];
  }

  function rvInRange(ts) {
    const w = rvWindow();
    return typeof ts === 'number' && ts >= w[0] && ts < w[1];
  }

  function rvBuckets() {
    const out = { wrong: [], cards: { known: 0, fuzzy: 0, unknown: 0, none: 0, total: 0 } };
    DATA.questions.forEach((q) => {
      if (rvView.subject !== 'all' && q.subject !== rvView.subject) return;
      const p = progress[q.id];
      if (p && p.correct === false && rvInRange(p.ts || 0)) out.wrong.push(q);
    });
    MAN_CARDS.forEach((c) => {
      if (rvView.subject !== 'all' && cardSubject(c) !== rvView.subject) return;
      out.cards.total++;
      const lv = kbMemLevel(c.k);
      if (lv && out.cards[lv] !== undefined) out.cards[lv]++;
      else out.cards.none++;
    });
    return out;
  }

  function rvItem(q, tag) {
    const name = q.subject === '马克思主义哲学' ? (q.part || q.subject) : q.subject;
    return `<button class="rv-item" data-q="${esc(q.id)}">
      <span class="rv-no">${q.no}</span>
      <span class="rv-txt"><b>${esc(name)} · ${esc(q.type)}</b>${esc(q.stem.slice(0, 34))}${q.stem.length > 34 ? '…' : ''}</span>
      <span class="rv-tag">${esc(tag)}</span>
      <i>${q.year}</i>
    </button>`;
  }

  function rvSection(title, list, tag, emptyText) {
    return `<section class="rv-sec">
      <div class="rv-sec-head">${esc(title)}<span>${list.length} 道</span></div>
      ${list.length ? `<div class="rv-sec-list">${list.map((q) => rvItem(q, tag)).join('')}</div>`
        : `<div class="rv-empty">${esc(emptyText)}</div>`}
    </section>`;
  }

  function renderReview() {
    if ($('rvOverlay').hidden) return;
    const b = rvBuckets();
    const total = b.wrong.length + b.cards.total - b.cards.none;
    const label = rvView.date ? rvView.date
      : rvView.range === 'today' ? '今天'
        : rvView.range === '7' ? '近 7 天' : rvView.range === '30' ? '近 30 天' : '全部日期';
    $('rvSub').textContent = `${label} · ${rvView.subject === 'all' ? '全部学科' : rvView.subject} · 错题 ${b.wrong.length} 道 · 卡片标记 ${b.cards.total - b.cards.none} 张`;

    $('rvRange').querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', !rvView.date && btn.dataset.range === rvView.range);
    });
    $('rvDate').value = rvView.date;

    $('rvSubjects').innerHTML = ['all', ...SUBJECTS].map((s) =>
      `<button class="chip${rvView.subject === s ? ' active' : ''}" data-rvsubject="${esc(s)}">${esc(s === 'all' ? '全部学科' : s)}</button>`
    ).join('');

    $('rvGrid').innerHTML = `
      <div class="rv-card wrong"><b>选择题错题</b><i>${b.wrong.length}</i><span>做错且还没做对的题</span></div>
      <div class="rv-card known"><b>卡片 · 熟悉</b><i>${b.cards.known}</i><span>背卡片时标为熟悉</span></div>
      <div class="rv-card fuzzy"><b>卡片 · 模糊</b><i>${b.cards.fuzzy}</i><span>背卡片时标为模糊</span></div>
      <div class="rv-card unknown"><b>卡片 · 未掌握</b><i>${b.cards.unknown}</i><span>背卡片时标为未掌握</span></div>`;

    $('rvBody').innerHTML = `
      ${rvSection('选择题错题', b.wrong, '错', '这段时间没有错题。')}
      <div class="rv-gen">
        <button class="btn primary" id="rvGen">一键生成当天复习清单</button>
        <span class="rv-gen-hint">只收选择题错题，按「错题」排列</span>
      </div>
      <div id="rvList"></div>`;

    const gen = $('rvGen');
    gen.disabled = !b.wrong.length;
    gen.addEventListener('click', () => {
      const ids = b.wrong.map((q) => q.id).filter((id, i, arr) => arr.indexOf(id) === i);
      rvGenerated = ids;
      const box = $('rvList');
      if (!ids.length) {
        box.innerHTML = '<div class="rv-empty">这段时间没有错题，去自测或组套卷刷几道吧。</div>';
        return;
      }
      box.innerHTML = `<div class="rv-list-wrap">
        <div class="rv-list-head">复习清单 · ${ids.length} 题</div>
        <ol class="rv-list">${ids.map((id) => {
          const q = findById(id);
          return `<li>${rvItem(q, '错题')}</li>`;
        }).join('')}</ol>
        <div class="rv-list-actions">
          <button class="btn primary" id="rvStart">从第 1 题开始</button>
          <span class="rv-gen-hint">进入后可用「复习清单」进度条逐题翻</span>
        </div>
      </div>`;
      $('rvStart').addEventListener('click', () => startQueue(rvGenerated));
    });
  }

  function openReview() {
    if (!DATA.questions.length) return;
    clearAutoNext();
    $('rvOverlay').hidden = false;
    document.body.classList.add('rv-open');
    renderReview();
    $('rvOverlay').querySelector('.rv-shell').scrollTop = 0;
  }

  function closeReview() {
    $('rvOverlay').hidden = true;
    document.body.classList.remove('rv-open');
  }

  function bindReview() {
    $('reviewBtn').addEventListener('click', openReview);
    $('rvClose').addEventListener('click', closeReview);
    $('rvOverlay').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'rvOverlay') { closeReview(); return; }
      const range = t.closest('[data-range]');
      if (range) { rvView.range = range.dataset.range; rvView.date = ''; rvGenerated = []; renderReview(); return; }
      const subj = t.closest('[data-rvsubject]');
      if (subj) { rvView.subject = subj.dataset.rvsubject; rvGenerated = []; renderReview(); return; }
      const jump = t.closest('[data-q]');
      if (jump) { closeReview(); clearQueue(); jumpToQuestion(jump.dataset.q); }
    });
    $('rvDate').addEventListener('change', (e) => {
      rvView.date = e.target.value || '';
      rvGenerated = [];
      renderReview();
    });
  }

  /* ---------------- 一键组套卷（16 单选 + 17 多选） ---------------- */
  const PAPER_SINGLE = 16;
  const PAPER_MULTI = 17;
  const PAPER_FULL = PAPER_SINGLE + PAPER_MULTI * 2; // 满分 50

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildPaper() {
    const single = shuffle(DATA.questions.filter((q) => q.type === '单选' && q.answer)).slice(0, PAPER_SINGLE);
    const multi = shuffle(DATA.questions.filter((q) => q.type === '多选' && q.answer)).slice(0, PAPER_MULTI);
    return [...single, ...multi];
  }

  function startPaper() {
    const list = buildPaper();
    if (!list.length) return;
    clearQueue();
    closeModal();
    clearAutoNext();
    state.paper = { ids: list.map((q) => q.id), answers: {}, startedAt: Date.now(), prevQuiz: state.quiz };
    state.quiz = true; // 套卷按自测规则作答
    saveSettings();
    renderFilters();
    renderGrid();
    showQuestion(state.paper.ids[0], true);
    renderFilters();
  }

  function quitPaper() {
    if (!state.paper) return;
    if (!confirm('退出套卷？本次作答不会记成绩，但已答的题仍留在做题记录里。')) return;
    const prevQuiz = state.paper.prevQuiz;
    state.paper = null;
    if (typeof prevQuiz === 'boolean') state.quiz = prevQuiz; // 退出后回到原来的模式
    clearAutoNext();
    renderFilters();
    renderGrid();
    renderCard();
  }

  function renderPaperBar() {
    const p = state.paper;
    if (!p) return;
    const answered = Object.keys(p.answers).length;
    $('paperMeta').textContent =
      `已答 ${answered} / ${p.ids.length} · 单选 ${PAPER_SINGLE} 题 × 1 分 · 多选 ${PAPER_MULTI} 题 × 2 分 · 满分 ${PAPER_FULL}`;
  }

  function paperIntro() {
    const s = DATA.questions.filter((q) => q.type === '单选' && q.answer).length;
    const m = DATA.questions.filter((q) => q.type === '多选' && q.answer).length;
    openModal('组一套真题卷', `
      <p class="rv-gen-hint" style="margin:0 0 12px">从题库随机抽题，按真题结构组一套：</p>
      <ul class="paper-rules">
        <li><b>16 道单选</b>（每题 1 分）＋ <b>17 道多选</b>（每题 2 分），满分 <b>${PAPER_FULL} 分</b></li>
        <li>抽题范围：全部 ${DATA.questions.length} 道有答案的真题（可抽单选 ${s} / 多选 ${m}）</li>
        <li>作答即记入错题本与复习中心；交卷后出总分、逐题解析，错题自动回填</li>
      </ul>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="paperStart">开始作答</button>
        <button class="btn ghost" id="paperCancel">取消</button>
      </div>`);
    $('paperStart').addEventListener('click', startPaper);
    $('paperCancel').addEventListener('click', closeModal);
  }

  function finishPaper() {
    const paper = state.paper;
    if (!paper) return;
    const answered = Object.keys(paper.answers).length;
    if (answered < paper.ids.length && !confirm(`还有 ${paper.ids.length - answered} 题没答，确定交卷？`)) return;

    let score = 0;
    let sOk = 0;
    let mOk = 0;
    const rows = [];
    paper.ids.forEach((id, i) => {
      const q = findById(id);
      if (!q) return;
      const a = paper.answers[id];
      const pts = q.type === '单选' ? 1 : 2;
      const ok = !!(a && a.correct);
      if (ok) { score += pts; if (q.type === '单选') sOk++; else mOk++; }
      rows.push({ q, a, ok, pts, no: i + 1 });
    });
    const wrongRows = rows.filter((r) => !r.ok);

    state.paper = null;
    if (typeof paper.prevQuiz === 'boolean') state.quiz = paper.prevQuiz; // 交卷后回到原来的模式
    clearAutoNext();
    renderFilters();
    renderGrid();
    renderCard();

    openModal('套卷成绩', `
      <div class="paper-score">
        <div class="paper-score-main"><b>${score}</b><span>／ ${PAPER_FULL} 分</span></div>
        <div class="paper-score-sub">
          单选 ${sOk} / ${PAPER_SINGLE}　多选 ${mOk} / ${PAPER_MULTI}　错题 ${wrongRows.length} 道
          <em>错题已回填到错题本与复习中心</em>
        </div>
      </div>
      ${wrongRows.length ? `<div class="paper-wrong">
        <div class="paper-wrong-head">错题解析<span>${wrongRows.length} 道</span></div>
        ${wrongRows.map((r) => `
          <div class="paper-qa">
            <div class="paper-qa-head">
              <b>第 ${r.no} 题</b>
              <span>${r.q.year} · ${esc(r.q.part || r.q.subject)}${r.q.type} · ${r.pts} 分</span>
              <i>${r.a ? (r.a.correct ? '' : '答错') : '未作答'}</i>
            </div>
            <p class="paper-qa-stem">${esc(r.q.stem)}</p>
            <p class="paper-qa-ans">正确答案 <b>${esc(r.q.answer)}</b>${r.a ? `　你的答案 <b>${esc((r.a.picked || []).join('') || '—')}</b>` : ''}</p>
            <p class="paper-qa-exp">${esc(r.q.explain || '这道题暂时只有答案，还没有讲解。')}</p>
          </div>`).join('')}
      </div>` : '<div class="rv-empty">全对，这套卷没有错题。</div>'}
      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="paperAgain">再组一套</button>
        <button class="btn ghost" id="paperReview">去复习中心</button>
        <button class="btn ghost" id="paperDone">收起</button>
      </div>`);
    $('paperAgain').addEventListener('click', paperIntro);
    $('paperReview').addEventListener('click', () => { closeModal(); openReview(); });
    $('paperDone').addEventListener('click', closeModal);
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
      // 背题模式现在是卡片：随机翻一张卡
      if (!state.quiz) {
        deck.idx = Math.floor(Math.random() * MAN_CARDS.length);
        renderDeck();
        renderFilters();
        return;
      }
      const list = currentList();
      const q = list[Math.floor(Math.random() * list.length)];
      if (q) showQuestion(q.id, true);
    });

    $('wrongBtn').addEventListener('click', showWrongBook);
    $('reviewBtn').addEventListener('click', openReview);
    $('paperBtn').addEventListener('click', paperIntro);
    $('paperSubmit').addEventListener('click', finishPaper);
    $('paperQuit').addEventListener('click', quitPaper);
    $('statsBtn').addEventListener('click', showStats);
    $('resetBtn').addEventListener('click', showResetModal);
    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

    $('modeBtn').addEventListener('click', () => {
      if (inPaper()) return; // 套卷进行中不切模式
      clearAutoNext();
      state.quiz = !state.quiz;
      state.submitted = false;
      state.revealed = false;
      state.picked = [];
      saveSettings();
      render();
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();

      // 卡片目录打开时：Esc 关目录，方向键仍可翻卡（目录里的高亮会跟着走）
      if (tocOpen) {
        if (e.key === 'Escape') { e.preventDefault(); closeToc(); return; }
        if (tag === 'input' || tag === 'textarea') return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); deckGo(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); deckGo(1); return; }
        return;
      }
      if (tag === 'input' || tag === 'textarea') return;
      if (!$('rvOverlay').hidden) { if (e.key === 'Escape') closeReview(); return; }
      if (!$('modal').hidden) { if (e.key === 'Escape') closeModal(); return; }

      // 背题模式（卡片）里方向键翻卡
      if (!state.quiz) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); deckGo(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); deckGo(1); return; }
        if (e.key === 'Enter') {
          const first = cardEl.querySelector('[data-reveal]');
          if (first) { e.preventDefault(); deck.shown[MAN_CARDS[deck.idx].k] = true; renderDeck(); }
          return;
        }
      }

      if (e.key === '/') { e.preventDefault(); $('noInput').focus(); return; }
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!state.quiz) { tocOpen ? closeToc() : openToc(); } else { enterCardMode(); }
        return;
      }
      if (e.key.toLowerCase() === 'v') { e.preventDefault(); openReview(); return; }
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
    // 背题模式 = 知识点卡片模式：收起题目筛选与题号栏，主区整块留给卡片
    document.body.classList.toggle('card-mode', !state.quiz);
    renderFilters();
    renderGrid();
    renderCard();
    renderFilters(); // 进度文本跟随
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bindGlobal();
    bindDeck();
    bindReview();

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
          state.quiz = true; // 背题已是卡片模式，直链要落在题目上
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

  /* ---------------- 账号 / 云同步对接 ---------------- */
  // 给 assets/account.js 用：取出本机数据、套用云端数据、重绘
  window.ZZ_APP = {
    snapshot() {
      return {
        settings: JSON.parse(JSON.stringify(settings)),
        progress: JSON.parse(JSON.stringify(progress))
      };
    },
    apply(payload) {
      if (!payload) return;
      suspendTouch = true;
      try {
        if (payload.progress && typeof payload.progress === 'object') {
          progress = payload.progress;
          store.set(KEY_PROGRESS, progress);
        }
        if (payload.settings && typeof payload.settings === 'object') {
          Object.keys(settings).forEach((k) => { delete settings[k]; });
          Object.assign(settings, payload.settings);
          state.autoNext = settings.autoNext !== false;
          state.autoNextMs = clampAutoNextMs(settings.autoNextMs);
          state.showKw = settings.showKw !== false;
          if (!state.paper) {
            state.quiz = settings.quiz !== undefined ? settings.quiz !== false : hasAnswers;
          }
          store.set(KEY_SETTINGS, settings);
          document.body.classList.toggle('card-mode', !state.quiz);
        }
      } finally {
        suspendTouch = false;
      }
      render();
    },
    render,
    toast(text) {
      const el = document.getElementById('progressText');
      if (!el) return;
      const old = el.textContent;
      el.textContent = text;
      setTimeout(() => { if (el.textContent === text) el.textContent = old; }, 2600);
    }
  };

  init();
})();
