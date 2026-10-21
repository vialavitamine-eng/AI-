/*
 * 관리자 페이지 동작 코드
 *
 * - Project URL과 공개용(anon) 키만 사용합니다 (js/config.js 에서 읽어요). 비밀 키는 이 파일에 없습니다.
 * - 목록의 모든 사용자 입력은 textContent / .value 로만 화면에 넣습니다. HTML 해석 방식은 쓰지 않습니다.
 * - CSV 는 =, +, -, @ (그리고 탭·줄바꿈) 으로 시작하는 값 앞에 ' 를 붙입니다.
 * - 로그인은 이메일 링크(비밀번호 없음). 데이터는 DB 의 RLS 규칙이 관리자에게만 열어 줍니다.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var BASE = '';
  try { BASE = new URL(CFG.supabaseUrl || CFG.submitFormUrl).origin; } catch (e) { BASE = ''; }
  var KEY = String(CFG.publicKey || '').trim();

  var SESSION_KEY = 'myfit_admin_session';
  var PAGE_LIMIT = 1000;
  var STATUS = { 'new': '신규', 'contacted': '연락함', 'done': '완료' };
  var KIND = { 'launch_alert': '출시 알림', 'trial': '체험단' };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var COLS = 'id,kind,contact,name,consent_required,consent_link_quiz,consent_marketing,quiz_summary,status,admin_note,created_at';

  var state = { session: null, rows: [], view: [] };

  function $(id) { return document.getElementById(id); }

  /* ---------- 화면 도우미 (텍스트만 넣는 함수들) ---------- */
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function setMsg(id, text, kind) {
    var e = $(id);
    e.textContent = text || '';
    e.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function show(which) {
    ['boot', 'login', 'app'].forEach(function (v) { $(v + '-view').hidden = (v !== which); });
  }
  function clearRows() {
    var tb = $('rows');
    while (tb.firstChild) tb.removeChild(tb.firstChild);
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = {};
    new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }

  /* ---------- 세션 (이 탭을 닫으면 사라져요) ---------- */
  function saveSession(s) {
    state.session = s;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* 저장 못 해도 동작은 계속 */ }
  }
  function loadSession() {
    try {
      var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (s && typeof s.access_token === 'string' && typeof s.expires_at === 'number') return s;
    } catch (e) { /* 무시 */ }
    return null;
  }
  function clearSession() {
    state.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 무시 */ }
  }

  /* 이메일 링크를 눌러 돌아왔을 때 주소 뒤(#...)에 로그인 정보가 붙어 와요. 읽은 즉시 주소에서 지웁니다. */
  function consumeHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error') || p.get('error_code') || p.get('error_description')) return { error: true };
    var at = p.get('access_token');
    if (!at) return null;
    var exp = parseInt(p.get('expires_in') || '3600', 10);
    if (!(exp > 0)) exp = 3600;
    return { session: { access_token: at, refresh_token: p.get('refresh_token') || '', expires_at: Math.floor(Date.now() / 1000) + exp } };
  }

  /* ---------- 서버 호출 ---------- */
  function refreshSession() {
    var s = state.session;
    if (!s || !s.refresh_token) return Promise.reject({ code: 'auth' });
    return fetch(BASE + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (res) {
      if (!res.ok) throw { code: 'auth' };
      return res.json();
    }).then(function (d) {
      if (!d || !d.access_token) throw { code: 'auth' };
      saveSession({
        access_token: d.access_token,
        refresh_token: d.refresh_token || s.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600)
      });
    });
  }
  function ensureToken() {
    var s = state.session;
    if (!s) return Promise.reject({ code: 'auth' });
    if (s.expires_at - Math.floor(Date.now() / 1000) > 60) return Promise.resolve(s.access_token);
    return refreshSession().then(function () { return state.session.access_token; });
  }
  function authed(path, init) {
    return ensureToken().then(function (tok) {
      var i = init || {};
      i.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, i.headers || {});
      return fetch(BASE + path, i);
    }).then(function (res) {
      if (res.status === 401) throw { code: 'auth' };
      return res;
    });
  }

  /* ---------- 로그인 / 로그아웃 ---------- */
  function sendLink(email) {
    var redirect = location.origin + '/admin/';
    return fetch(BASE + '/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect), {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      /* create_user:false → 이미 만들어 둔 관리자 계정에만 링크를 보내요. 아무나 계정을 만들 수 없어요. */
      body: JSON.stringify({ email: email, create_user: false })
    });
  }

  function onLoginSubmit(e) {
    e.preventDefault();
    var email = $('login-email').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { setMsg('login-msg', '이메일 형식을 확인해 주세요.', 'err'); return; }
    var btn = $('login-btn');
    btn.disabled = true;
    setMsg('login-msg', '전송 중이에요...');
    sendLink(email).then(function (res) {
      if (res.status === 429) {
        setMsg('login-msg', '요청이 너무 많아요. 1분쯤 뒤에 다시 시도해 주세요.', 'err');
        btn.disabled = false;
      } else if (res.ok || res.status === 422) {
        /* 계정이 있든 없든 같은 안내를 보여 줘요(관리자 이메일이 외부에 드러나지 않게). */
        setMsg('login-msg', '입력한 주소가 관리자 계정이면 로그인 링크가 전송돼요. 메일함(스팸함 포함)을 확인해 주세요.', 'ok');
        setTimeout(function () { btn.disabled = false; }, 30000);
      } else {
        setMsg('login-msg', '링크를 보내지 못했어요. 잠시 후 다시 시도해 주세요.', 'err');
        btn.disabled = false;
      }
    }).catch(function () {
      setMsg('login-msg', '네트워크 오류가 났어요. 잠시 후 다시 시도해 주세요.', 'err');
      btn.disabled = false;
    });
  }

  function doLogout(message) {
    var s = state.session;
    clearSession();
    state.rows = [];
    state.view = [];
    clearRows();
    $('who').hidden = true;
    $('who-email').textContent = '';
    show('login');
    setMsg('login-msg', message || '', message ? 'err' : '');
    if (s && s.access_token) {
      fetch(BASE + '/auth/v1/logout?scope=local', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token }
      }).catch(function () { /* 서버에 못 알려도 이 탭의 로그인 정보는 이미 지웠어요 */ });
    }
  }

  function handleErr(err) {
    if (err && err.code === 'auth') { doLogout('로그인이 만료되었어요. 다시 로그인해 주세요.'); return; }
    setMsg('app-msg', '불러오지 못했어요. 잠시 후 새로고침해 주세요.', 'err');
  }

  /* ---------- 목록 ---------- */
  function loadRows() {
    setMsg('app-msg', '불러오는 중...');
    return authed('/rest/v1/form_submissions?select=' + COLS + '&order=created_at.desc&limit=' + PAGE_LIMIT)
      .then(function (res) {
        if (!res.ok) throw { code: 'http' };
        return res.json();
      }).then(function (rows) {
        state.rows = Array.isArray(rows) ? rows : [];
        setMsg('app-msg', '');
        render();
      });
  }

  function applyFilter() {
    var q = $('q').value.trim().toLowerCase();
    var k = $('f-kind').value;
    var s = $('f-status').value;
    state.view = state.rows.filter(function (r) {
      if (k && r.kind !== k) return false;
      if (s && r.status !== s) return false;
      if (q) {
        var hay = [r.contact, r.name, r.admin_note, r.quiz_summary].map(function (v) { return String(v || '').toLowerCase(); }).join('\n');
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function buildRow(r) {
    var tr = document.createElement('tr');
    function cell(child, cls) {
      var c = document.createElement('td');
      if (cls) c.className = cls;
      if (child) c.appendChild(child);
      tr.appendChild(c);
    }

    cell(el('span', fmtDate(r.created_at)));
    cell(el('span', KIND[r.kind] || r.kind, 'tag kind'));
    cell(el('span', r.contact), 'contact');
    cell(el('span', r.name));

    var cons = document.createElement('div');
    cons.appendChild(el('span', r.consent_required ? '필수 동의' : '필수 동의 없음', r.consent_required ? 'tag' : 'tag no'));
    cons.appendChild(el('span', r.consent_link_quiz ? '퀴즈 연결 동의' : '퀴즈 연결 안 함', r.consent_link_quiz ? 'tag' : 'tag no'));
    cons.appendChild(el('span', r.consent_marketing ? '광고 수신 동의' : '광고 수신 안 함', r.consent_marketing ? 'tag' : 'tag no'));
    cell(cons);

    cell(el('span', r.quiz_summary));

    var sel = document.createElement('select');
    sel.setAttribute('aria-label', '처리 상태');
    Object.keys(STATUS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = STATUS[k];
      sel.appendChild(o);
    });
    sel.value = STATUS[r.status] ? r.status : 'new';
    cell(sel);

    var ta = document.createElement('textarea');
    ta.setAttribute('aria-label', '관리자 메모');
    ta.maxLength = 2000;
    ta.value = r.admin_note || '';
    cell(ta);

    var btn = el('button', '저장');
    btn.type = 'button';
    var rowMsg = el('span', '', 'rowmsg');
    rowMsg.setAttribute('role', 'status');
    var box = document.createElement('div');
    box.appendChild(btn);
    box.appendChild(rowMsg);
    cell(box);
    btn.addEventListener('click', function () { saveRow(r, sel, ta, btn, rowMsg); });

    return tr;
  }

  function render() {
    applyFilter();
    clearRows();
    var tb = $('rows');
    state.view.forEach(function (r) { tb.appendChild(buildRow(r)); });
    var empty = $('empty');
    if (!state.view.length) {
      empty.hidden = false;
      empty.textContent = state.rows.length
        ? '조건에 맞는 신청이 없어요.'
        : '표시할 신청이 없어요. (신청이 아직 없거나, 이 계정이 관리자로 등록되지 않았을 수 있어요)';
    } else {
      empty.hidden = true;
    }
    $('count').textContent = state.view.length + '건 표시 / 전체 ' + state.rows.length + '건' +
      (state.rows.length >= PAGE_LIMIT ? ' (최근 ' + PAGE_LIMIT + '건까지만 불러왔어요)' : '');
  }

  function saveRow(r, sel, ta, btn, msgEl) {
    var status = sel.value;
    var note = ta.value.trim();
    if (!STATUS[status] || !UUID_RE.test(String(r.id))) {
      msgEl.textContent = '저장할 수 없는 값이에요.';
      msgEl.className = 'rowmsg err';
      return;
    }
    btn.disabled = true;
    msgEl.textContent = '저장 중...';
    msgEl.className = 'rowmsg';
    authed('/rest/v1/form_submissions?id=eq.' + encodeURIComponent(r.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: status, admin_note: note ? note : null })
    }).then(function (res) {
      if (!res.ok) throw { code: 'http' };
      return res.json();
    }).then(function (arr) {
      if (!Array.isArray(arr) || arr.length !== 1) throw { code: 'denied' };
      r.status = arr[0].status;
      r.admin_note = arr[0].admin_note;
      ta.value = r.admin_note || '';
      msgEl.textContent = '저장됨';
      msgEl.className = 'rowmsg ok';
    }).catch(function (err) {
      if (err && err.code === 'auth') { handleErr(err); return; }
      msgEl.textContent = (err && err.code === 'denied')
        ? '저장되지 않았어요. (관리자 권한이 없거나 이미 사라진 신청이에요)'
        : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
      msgEl.className = 'rowmsg err';
    }).then(function () { btn.disabled = false; });
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    /* 엑셀 수식 삽입 방지: =, +, -, @, 탭, 줄바꿈으로 시작하면(공백 뒤에 와도) 앞에 ' 를 붙여요. */
    if (/^[=+\-@\t\r]/.test(s) || /^\s+[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function yn(b) { return b ? 'Y' : 'N'; }
  function buildCsv(rows) {
    var head = ['신청 시각', '종류', '연락처', '이름', '필수 동의', '퀴즈 연결 동의', '광고 수신 동의', '퀴즈 요약', '처리 상태', '관리자 메모', 'ID'];
    var lines = [head.map(csvCell).join(',')];
    rows.forEach(function (r) {
      lines.push([
        fmtDate(r.created_at), KIND[r.kind] || r.kind, r.contact, r.name,
        yn(r.consent_required), yn(r.consent_link_quiz), yn(r.consent_marketing),
        r.quiz_summary, STATUS[r.status] || r.status, r.admin_note, r.id
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n'; /* 맨 앞 BOM: 엑셀에서 한글이 깨지지 않게 */
  }
  function downloadCsv() {
    var blob = new Blob([buildCsv(state.view)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'form_submissions_' + fmtDate(new Date().toISOString()).slice(0, 10).replace(/-/g, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 시작 ---------- */
  function enterApp() {
    show('boot');
    $('boot-msg').textContent = '불러오는 중...';
    authed('/auth/v1/user').then(function (res) {
      if (!res.ok) throw { code: 'auth' };
      return res.json();
    }).then(function (u) {
      $('who-email').textContent = (u && u.email) ? u.email : '';
      $('who').hidden = false;
      show('app');
      return loadRows();
    }).catch(function (err) {
      if (err && err.code === 'auth') { doLogout('로그인이 만료되었어요. 다시 로그인해 주세요.'); return; }
      show('app');
      handleErr(err);
    });
  }

  function boot() {
    if (!BASE || !KEY) {
      show('boot');
      $('boot-msg').textContent = '연결 준비 중이에요. (설정 파일을 확인해 주세요)';
      return;
    }
    var cb = consumeHash();
    if (cb && cb.error) {
      clearSession();
      show('login');
      setMsg('login-msg', '로그인 링크가 만료되었거나 이미 사용됐어요. 새 링크를 받아 주세요.', 'err');
      return;
    }
    if (cb && cb.session) saveSession(cb.session); else state.session = loadSession();
    if (!state.session) { show('login'); return; }
    enterApp();
  }

  $('login-form').addEventListener('submit', onLoginSubmit);
  $('logout-btn').addEventListener('click', function () { doLogout(''); });
  $('reload-btn').addEventListener('click', function () { loadRows().catch(handleErr); });
  $('csv-btn').addEventListener('click', downloadCsv);
  ['q', 'f-kind', 'f-status'].forEach(function (id) {
    $(id).addEventListener(id === 'q' ? 'input' : 'change', render);
  });

  boot();
})();
