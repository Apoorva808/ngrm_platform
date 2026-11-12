/* NGRM frontend — shared client: API calls, page chrome by role, consent panel, small helpers. */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var f1 = function (n) { return (Math.round(n * 10) / 10).toFixed(1); };
  var f0 = function (n) { return String(Math.round(n)); };
  var ordinal = function (n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); };
  var bandCls = { building: 'warning', progressing: 'accent', ready: 'success' };

  // Keep a section up to date without a page refresh. Runs only while the tab is visible and the person
  // is not typing, so nothing they are writing is replaced.
  function live(fn, seconds, stampEl) {
    var stamp = function () { if (stampEl) stampEl.textContent = 'Live · updated ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); };
    stamp();
    setInterval(function () {
      var a = document.activeElement, typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if (document.hidden || typing) return;
      Promise.resolve(fn()).then(stamp, function () {});
    }, (seconds || 30) * 1000);
  }
  // An identical change already on its way (for example after a double-click) is not sent twice.
  var inflight = {};
  function api(method, url, body) {
    var key = method !== 'GET' ? method + ' ' + url + ' ' + JSON.stringify(body || null) : null;
    if (key && inflight[key]) return inflight[key];
    var p = send(method, url, body);
    if (key) { inflight[key] = p; var done = function () { delete inflight[key]; }; p.then(done, done); }
    return p;
  }
  function send(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  function toast(msg) {
    var box = $('#toasts'); if (!box) return;
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; box.appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }

  var NAV = {
    student: [['readiness-index.html', 'My score', 'score'], ['student-roadmap.html', 'My plan', 'plan'], ['skill-credentials.html', 'Evidence & privacy', 'evidence']],
    mentor: [['mentor-dashboard.html', 'Mentor dashboard', 'mentor']],
    college_admin: [['mentor-dashboard.html', 'College dashboard', 'mentor']],
    employer: [['employer-portal.html', 'Skill supply', 'employer']],
    researcher: [['research.html', 'Outcome study', 'research']],
    admin: [['admin.html', 'Admin', 'admin']],
  };
  var HOME = { student: 'readiness-index.html', mentor: 'mentor-dashboard.html', college_admin: 'mentor-dashboard.html', employer: 'employer-portal.html', researcher: 'research.html', admin: 'admin.html' };
  var EYE = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16c4.2-7 8.6-10 13-10s8.8 3 13 10c-4.2 7-8.6 10-13 10S7.2 23 3 16z" fill="none" stroke="#F4F6FB" stroke-width="2.2" stroke-linejoin="round"/><circle cx="16" cy="16" r="4.6" fill="#02C39A"/></svg>';

  function chrome(page, me, meta) {
    var demo = !meta || meta.demoMode;
    var links = [['index.html', 'Home', 'home']].concat(me ? NAV[me.role] || [] : [['login.html', 'Sign in', 'login']]);
    var top = document.createElement('div');
    top.innerHTML =
      '<a class="skip-link" href="#main" id="skipLink">Skip to main content</a>' +
      '<div class="utility-bar" role="region" aria-label="Pilot status and display settings"><div class="container"><span class="pilot-note"><span class="pilot-dot" aria-hidden="true"></span>' + (demo ? 'Pilot · sample data only' : 'Pilot') + '</span>' +
      '<div class="a11y-controls" role="group" aria-label="Display settings">' +
      '<button class="a11y-btn" type="button" data-size="normal" aria-label="Normal text size">A</button><button class="a11y-btn" type="button" data-size="large" aria-label="Text size plus 15 percent">A+</button>' +
      '<button class="a11y-btn" type="button" data-size="xlarge" aria-label="Text size plus 30 percent">A++</button><button class="a11y-btn" type="button" id="contrastBtn">High contrast</button></div></div></div>' +
      '<header class="site-header"><div class="container header-inner">' +
      '<a class="brand" href="index.html" aria-label="NGRM home"><span class="brand-mark">' + EYE + '</span><span><b>NGRM</b><small>National Graduate Readiness Mission</small></span></a>' +
      '<button class="menu-btn" type="button" id="menuBtn" aria-expanded="false" aria-controls="mainNav">Menu</button>' +
      '<nav class="main-nav" id="mainNav" aria-label="Main">' +
      links.map(function (n) { return '<a class="nav-link" href="' + n[0] + '"' + (n[2] === page ? ' aria-current="page"' : '') + '>' + n[1] + '</a>'; }).join('') +
      (me ? '<span class="user-menu"><a class="who" href="account.html" title="Your account: ' + esc(me.email) + '">' + esc(me.name) + '</a><button class="btn btn-secondary btn-sm" type="button" id="signOut">Sign out</button></span>' : '') +
      '</nav></div></header>';
    document.body.insertBefore(top, document.body.firstChild);
    // The page title belongs inside the main region, so screen-reader users land on it.
    var banner = $('.page-banner'), main = $('#main');
    if (banner && main && banner.parentNode !== main) main.insertBefore(banner, main.firstChild);
    var foot = document.createElement('footer'); foot.className = 'site-footer';
    foot.innerHTML = '<div class="container"><div><p><b>NGRM · National Graduate Readiness Mission</b></p><p class="muted">Built by Team NAVDRISHTI. An independent, student-founded project. Not a government service.</p></div>' +
      '<div><p class="muted">' + (demo ? 'Pilot. All people, colleges, employers and figures are sample data. ' : 'Pilot. ') + 'Scoring formula ' + esc(meta ? meta.formulaVersion : 'v0.1') + '. Designed for the Digital Personal Data Protection Act, 2023. <a href="privacy.html">Privacy notice</a></p></div></div>';
    document.body.appendChild(foot);
    var t = document.createElement('div'); t.id = 'toasts'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t);

    var prefs = { size: 'normal', hc: false };
    try { prefs = JSON.parse(localStorage.getItem('ngrm:prefs') || 'null') || prefs; } catch (e) {}
    function apply() {
      document.documentElement.setAttribute('data-font-size', prefs.size); document.documentElement.classList.toggle('high-contrast', !!prefs.hc);
      $$('.a11y-btn[data-size]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.size === prefs.size)); });
      $('#contrastBtn').setAttribute('aria-pressed', String(!!prefs.hc));
      try { localStorage.setItem('ngrm:prefs', JSON.stringify(prefs)); } catch (e) {}
    }
    $$('.a11y-btn[data-size]').forEach(function (b) { b.addEventListener('click', function () { prefs.size = b.dataset.size; apply(); }); });
    $('#contrastBtn').addEventListener('click', function () { prefs.hc = !prefs.hc; apply(); });
    apply();
    $('#menuBtn').addEventListener('click', function () { var o = $('#mainNav').classList.toggle('open'); this.setAttribute('aria-expanded', String(o)); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { $('#mainNav').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); } });
    $('#skipLink').addEventListener('click', function (e) { e.preventDefault(); var m = $('#main'); if (m) m.focus(); });
    var so = $('#signOut'); if (so) so.addEventListener('click', function () { api('POST', '/api/auth/sign-out').then(function () { location.href = 'login.html'; }); });
  }

  /** Load meta and the signed-in user; send people to sign-in or their own home if they lack the role. */
  function boot(page, roles) {
    return Promise.all([api('GET', '/api/meta'), api('GET', '/api/me').then(function (m) { return m.user ? m : null; })])
      .then(function (r) {
        var meta = r[0], me = r[1];
        if (roles && !me) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop()); return new Promise(function () {}); }
        if (roles && roles.indexOf(me.user.role) < 0) { location.href = HOME[me.user.role] || 'index.html'; return new Promise(function () {}); }
        // On a temporary password, the only place to go is the Account page, to choose a real one.
        if (me && me.user.mustChangePassword && page !== 'account') { location.href = 'account.html'; return new Promise(function () {}); }
        chrome(page, me && me.user, meta);
        return { meta: meta, me: me && me.user, consents: me && me.consents };
      });
  }

  /** Consent panel for students: per purpose, with a guardian path for under-18s. */
  function consentPanel(el, meta, current, opts) {
    opts = opts || {};
    var keys = opts.keys || Object.keys(meta.consentPurposes);
    el.innerHTML = '<form class="card" id="consentForm" novalidate style="display:grid;gap:0.85rem">' +
      '<header><h2>' + esc(opts.title || 'Before you start: your consent') + '</h2><span class="small muted">You can change any of these later</span></header>' +
      '<p class="muted">' + esc(opts.intro || 'NGRM only stores what you agree to here. The first box is needed to use NGRM; the others are optional.') + '</p>' +
      '<fieldset><legend class="small">Are you 18 or older?</legend><div style="display:flex;gap:1.25rem;flex-wrap:wrap"><label class="check"><input type="radio" name="adult" id="adult-y" value="y" checked> Yes</label><label class="check"><input type="radio" name="adult" id="adult-n" value="n"> No</label></div></fieldset>' +
      '<div class="field" id="guardianBox" hidden><label for="g-name">Parent or guardian’s name</label><input type="text" id="g-name"><label class="check" style="margin-top:0.4rem"><input type="checkbox" id="g-ok"> <span>My parent or guardian has read this and agrees (needed under the DPDP Act for anyone under 18)</span></label></div>' +
      keys.map(function (k) { return '<label class="check"><input type="checkbox" id="c-' + k + '"' + (current && current[k] ? ' checked' : '') + '> <span>' + esc(meta.consentPurposes[k]) + (k === 'profile' ? ' <b>(needed)</b>' : '') + '</span></label>'; }).join('') +
      '<p class="small">Before you choose, read the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a>: what is collected, who sees it, and how to take it back.</p><p class="small" id="consentErr" style="color:var(--danger)" hidden></p><div><button class="btn btn-primary" type="submit">' + esc(opts.button || 'Save my choices') + '</button></div></form>';
    // Keep a recorded under-18 status and guardian, so updating consent later does not quietly mark the student as an adult.
    if (current && current.isAdult === false) { $('#adult-n', el).checked = true; $('#guardianBox', el).hidden = false; $('#g-name', el).value = current.guardianName || ''; }
    $$('input[name=adult]', el).forEach(function (r) { r.addEventListener('change', function () { $('#guardianBox', el).hidden = $('#adult-y', el).checked; }); });
    $('#consentForm', el).addEventListener('submit', function (e) {
      e.preventDefault();
      var purposes = {}; keys.forEach(function (k) { purposes[k] = $('#c-' + k, el).checked; });
      var adult = $('#adult-y', el).checked, err = $('#consentErr', el);
      if (opts.requireProfile && !purposes.profile) { err.hidden = false; err.textContent = 'Tick the first box to use NGRM. Everything else is optional.'; return; }
      if (!adult && !$('#g-ok', el).checked) { err.hidden = false; err.textContent = 'Under 18: your parent or guardian needs to agree. Add their name and tick the box.'; return; }
      api('POST', '/api/me/consents', { purposes: purposes, isAdult: adult, guardianName: $('#g-name', el).value })
        .then(function (c) { err.hidden = true; toast('Your choices are saved.'); if (opts.onDone) opts.onDone(c); })
        .catch(function (x) { err.hidden = false; err.textContent = x.message; });
    });
  }

  function ring(el, value) {
    var r = 62, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, value)) / 100);
    el.innerHTML = '<svg viewBox="0 0 150 150" aria-hidden="true"><circle cx="75" cy="75" r="' + r + '" fill="none" stroke="var(--surface-subtle)" stroke-width="12"/><circle cx="75" cy="75" r="' + r + '" fill="none" stroke="var(--mint)" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg><div class="val"><b>' + f1(value) + '</b><span>out of 100</span></div>';
    el.setAttribute('role', 'img'); el.setAttribute('aria-label', 'Readiness score ' + f1(value) + ' out of 100');
  }
  function showError(el, e) { el.innerHTML = '<div class="error-box">' + esc(e.message || 'Something went wrong.') + '</div>'; }

  window.NGRM = { $: $, $$: $$, esc: esc, f1: f1, f0: f0, ordinal: ordinal, bandCls: bandCls, api: api, toast: toast, live: live, boot: boot, consentPanel: consentPanel, ring: ring, showError: showError, HOME: HOME };
})();
