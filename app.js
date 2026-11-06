/* Detroit 26.2: the interface. All plan logic lives in engine.js. */
(function () {
  'use strict';
  const E = window.Engine;
  const KEY = 'detroit262.state.v1';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n).toLocaleString('en-US');
  const isNum = (v) => v !== '' && v != null && Number.isFinite(Number(v));

  /* ---------- Today ---------- */
  function localIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const params = new URLSearchParams(location.search);
  const fixedToday = /^\d{4}-\d{2}-\d{2}$/.test(params.get('today') || '') ? params.get('today') : null;
  const today = () => fixedToday || localIso(new Date());

  /* ---------- Storage ---------- */
  let storageOk = true;
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const init = E.initialState();
        return Object.assign(init, parsed, { targets: Object.assign(init.targets, parsed.targets) });
      }
    } catch (err) {
      storageOk = false;
    }
    return E.initialState();
  }
  let state = load();
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      storageOk = true;
    } catch (err) {
      storageOk = false;
    }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------- Interface state ---------- */
  const clampWeek = (w) => Math.max(-1, Math.min(E.LAST_WEEK, w));
  const schedWeekNow = () => Math.max(0, clampWeek(E.weekOf(today())));
  const nowWeek = () => clampWeek(E.weekOf(today()));
  const nowDay = () => (today() > E.RACE || E.weekOf(today()) < -1 ? 0 : E.dayIndex(today()));
  const ui = { tab: 'home', trainWeek: nowWeek(), trainDay: nowDay(), trainPart: 'a', schedWeek: schedWeekNow(), fuelDate: today(), foodDraft: null, liftChart: 'incline', sheet: null, ci: null, logDate: today(), error: null, confirmReset: false, confirmUndo: false, summary: null };

  /* ---------- AI coach connection ----------
     Kept apart from your logs, so the access code never ends up in a backup file. */
  const AI_KEY = 'detroit262.ai.v1';
  function loadAi() {
    const blank = { enabled: false, url: '', token: '' };
    try { return Object.assign(blank, JSON.parse(localStorage.getItem(AI_KEY) || '{}')); } catch (err) { return blank; }
  }
  let aiCfg = loadAi();
  const saveAi = () => { try { localStorage.setItem(AI_KEY, JSON.stringify(aiCfg)); } catch (err) { /* stays for this session */ } };
  const aiUrlOk = (u) => /^(https:\/\/[^\s/]+|http:\/\/localhost(:\d+)?)(\/|$)/.test(u || '');
  const aiReady = () => aiCfg.enabled && aiUrlOk(aiCfg.url) && !!aiCfg.token;
  const AI_ERRORS = {
    offline: 'You\'re offline, so the AI coach isn\'t available. Your plan still works normally.',
    timeout: 'That took too long, so the app stopped waiting.',
    unreachable: 'The app couldn\'t reach your AI server. Check the server address in Settings and your connection.',
    bad_token: 'The access code on this phone doesn\'t match your server. Check APP_TOKEN in Cloudflare.',
    no_app_token: 'Your server is missing APP_TOKEN. Add it in Cloudflare.',
    no_api_key: 'Your server is missing ANTHROPIC_API_KEY. Add it in Cloudflare.',
    bad_api_key: 'Claude rejected your API key. Check ANTHROPIC_API_KEY in Cloudflare, and your Claude Console credits.',
    busy: 'Claude is busy, or your spending limit has been reached. Try again in a minute.',
    refused: 'Claude declined this request. Try rewording your note.',
    cut_off: 'The answer was cut off. Try again.',
    bad_reply: 'The answer came back in a form the app couldn\'t use. Try again.',
    api_rejected: 'Claude rejected the request. Your worker.js may need updating.',
    too_large: 'That request was too large to send.'
  };
  const aiErrorText = (code) => `${AI_ERRORS[code] || 'Something went wrong with the AI coach.'} Nothing changed.`;
  async function aiCall(task, context, message) {
    if (navigator.onLine === false) throw new Error('offline');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetch(aiCfg.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': aiCfg.token }, body: JSON.stringify({ task, context, message: message || '' }), signal: ctl.signal });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'timeout' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (err) { /* handled below */ }
    if (!res.ok) throw new Error((data && data.error) || 'unreachable');
    if (!data) throw new Error('bad_reply');
    return data;
  }
  let aiRequest = 0; // A newer request replaces an older one, and closing a sheet cancels it.
  const CARE_TEXT = 'Chest pain, fainting, unusual shortness of breath, or dizziness can be serious. Stop training today and get medical care before you train again. If it\'s severe or happening now, call 911. The app didn\'t send this note anywhere and didn\'t change your plan.';

  /* ---------- Icons ---------- */
  const I = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 19.2a9 9 0 1 1 10 0"/><path d="M12 12.5l3.5-3.5"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/></svg>',
    train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 7.5v9M4 9.5v5M17 7.5v9M20 9.5v5M7 12h10"/></svg>',
    sched: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 2.8v4M16 2.8v4"/></svg>',
    fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c4 0 7-2.9 7-6.8 0-4.5-4-6.2-5-11.2-3.2 2.1-4.7 5.2-4.4 8-1-.5-1.7-1.5-1.9-2.6C6.100 10 5 12 5 14.200 5 18.100 8 21 12 21z"/></svg>',
    prog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.500 17l5.500-5.500 4 3.500 7.500-8"/><path d="M15.500 7h5v5"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>'
  };

  /* ---------- Small components ---------- */
  function dial(opts) {
    const size = 120;
    const r = 50;
    const c = 2 * Math.PI * r;
    const sweep = 0.82;
    const gap = c * (1 - sweep);
    const pct = opts.value == null ? 0 : Math.max(0, Math.min(1, opts.value));
    const stroke = opts.big ? 8 : 9;
    return `<button class="dial" data-action="${opts.action || ''}" aria-label="${esc(opts.aria)}">
      <svg viewBox="0 0 ${size} ${size}" role="img" aria-hidden="true">
        <g transform="rotate(${90 + (360 * (1 - sweep)) / 2} 60 60)">
          <circle class="dial-track" cx="60" cy="60" r="${r}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c - gap} ${gap}"/>
          ${opts.value == null || pct === 0 ? '' : `<circle class="dial-arc" cx="60" cy="60" r="${r}" stroke="${opts.color}" stroke-width="${stroke}" stroke-dasharray="${(c - gap) * pct} ${c}"/>`}
        </g>
        <text class="dial-value" x="60" y="${opts.unit ? 62 : 70}" font-size="${opts.big ? 36 : 34}">${esc(opts.main)}</text>
        ${opts.unit ? `<text class="dial-unit" x="60" y="81" font-size="14.5">${esc(opts.unit)}</text>` : ''}
      </svg>
      <span class="dial-label">${esc(opts.label)}</span>
    </button>`;
  }
  const notice = (kind, title, text, action) => `<${action ? 'button' : 'div'} class="notice ${kind}" ${action ? `data-action="${action}"` : ''}><b>${esc(title)}</b>${esc(text)}</${action ? 'button' : 'div'}>`;
  const chips = (group, options, value, cls) => `<div class="chips ${cls || ''}" role="group">${options.map((o) => {
    const v = typeof o === 'object' ? o.v : o;
    const l = typeof o === 'object' ? o.l : o;
    return `<button class="chip ${String(value) === String(v) ? 'on' : ''}" data-action="chip" data-group="${group}" data-v="${esc(v)}" aria-pressed="${String(value) === String(v)}">${esc(l)}</button>`;
  }).join('')}</div>`;
  const field = (attrs, unit, val, placeholder, disabled) => `<label class="field"><input type="text" ${/inputmode/.test(attrs) ? '' : 'inputmode="decimal"'} autocomplete="off" ${attrs} value="${val == null ? '' : esc(val)}" placeholder="${esc(placeholder || '')}" ${disabled ? 'disabled' : ''}>${unit ? `<span class="u">${esc(unit)}</span>` : ''}</label>`;
  const garminUpload = (cls) => `<label class="btn ${cls || 'alt'}">Import Garmin CSV<input type="file" accept=".csv,text/csv,text/comma-separated-values,application/vnd.ms-excel" class="vh" data-action-change="garmin-csv" aria-label="Choose your Garmin activities CSV"></label>`;
  const checkRow = (id, title, sub, on, action) => `<button class="check ${on ? 'on' : ''}" data-action="${action}" data-id="${esc(id)}" aria-pressed="${!!on}"><span class="box">${I.check}</span><span class="ct"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></button>`;

  /* ---------- Shared numbers ---------- */
  const weekFor = (w) => E.buildWeek(state, w, today());
  function latestWeight() {
    const dates = Object.keys(state.days).filter((d) => isNum(state.days[d].weight) && d <= today()).sort();
    const w = E.weekOf(today());
    for (let i = w; i >= -1; i--) {
      const s = E.weekSummary(state, i, today());
      if (s.weightAvg != null) return { value: s.weightAvg, week: i };
      if (w - i > 8) break;
    }
    if (dates.length) return { value: Number(state.days[dates[dates.length - 1]].weight), week: null };
    return { value: 205.5, week: null, start: true };
  }
  function latestWaist() {
    const withWaist = state.checkins.filter((c) => isNum(c.data.waist));
    return withWaist.length ? Number(withWaist[withWaist.length - 1].data.waist) : 93;
  }
  const shortName = (s) => {
    if (s.type === 'lift') return s.title;
    if (s.type === 'cardio') return 'Cardio';
    if (s.type === 'recovery') return s.w === E.TRAVEL_WEEK && s.d === 0 ? 'Travel' : s.title === 'Rest' ? 'Rest' : 'Recover';
    if (s.run && s.run.effort === 'race') return 'Race';
    if (s.run && s.run.effort === 'test') return 'Test';
    if (s.d === 5 && s.run && s.run.kind === 'intervals') return 'Long run';
    if (s.run && s.run.effort === 'long') return 'Long run';
    if (s.run && s.run.effort === 'shakeout') return 'Shakeout';
    if (s.run && s.run.effort === 'tempo') return 'Tempo';
    if (s.run && s.run.effort === 'marathon') return 'Pace run';
    return 'Run';
  };
  const weekLabel = (wk) => {
    if (wk.pre) return 'Before your plan starts';
    const tags = [];
    if (wk.travel) tags.push('Travel');
    else if (wk.finals) tags.push('Finals deload');
    else if (wk.deload) tags.push('Deload');
    if (wk.bare) tags.push('Bare minimum');
    return `${wk.phase.name}${tags.length ? `, ${tags.join(', ').toLowerCase()}` : ''}`;
  };
  function sessionStatus(s) {
    if (state.logs[s.id]) return 'done';
    if (s.date === today()) return 'today';
    if (s.w >= 0 && s.date < today() && E.countsAsPlanned(s)) return 'miss';
    return '';
  }

  /* ---------- Home ---------- */
  function renderHome() {
    const t = today();
    const w = nowWeek();
    const started = t >= E.START;
    const finished = t > E.RACE;
    const wk = weekFor(w);
    const day = state.days[t] || {};
    const ready = E.readiness(state, t);
    const summary = E.weekSummary(state, w, t);
    const toRace = E.diffDays(E.RACE, t);
    const color = ready ? { good: 'var(--good)', mid: 'var(--mid)', low: 'var(--low)' }[ready.band] : 'var(--good)';
    const dateLabel = `${E.DAY_NAMES[E.dayIndex(t)]}, ${E.fmtDate(t)}`;
    let coach;
    const backs = E.backOff(state, t);
    if (!ready) coach = started ? 'Log your morning numbers to get today\'s readiness.' : 'Your plan starts Monday, November 9. Log anything you do before then.';
    else if (ready.band === 'good') coach = 'You\'re good to train as planned.';
    else if (ready.band === 'mid') coach = 'Train as planned and keep the effort honest.';
    else coach = 'Today calls for easy effort.';

    let html = `<div class="top"><div><h1>${esc(dateLabel)}</h1><div class="sub">${toRace > 0 ? `${fmtN(toRace)} days to Detroit` : toRace === 0 ? 'Race day' : 'Marathon complete'}</div></div><button class="icon-btn" data-action="open-settings" aria-label="Settings">${I.gear}</button></div>`;
    html += `<div class="dials">
      ${dial({ value: isNum(day.sleep) ? Number(day.sleep) / 8 : null, color: 'var(--sleep)', main: isNum(day.sleep) ? Number(day.sleep).toFixed(1) : '--', unit: 'hours', label: 'Sleep', action: 'open-morning', aria: 'Sleep, log your morning' })}
      ${dial({ value: ready ? ready.score / 100 : null, color, main: ready ? `${ready.score}%` : 'Log', big: true, label: 'Readiness', action: 'open-morning', aria: 'Readiness, log your morning' })}
      ${dial({ value: wk.pre ? (summary.done ? 1 : 0) : summary.planned ? summary.done / summary.planned : 0, color: 'var(--blue)', main: wk.pre ? String(summary.done) : `${summary.done}/${summary.planned}`, unit: wk.pre ? 'logged' : 'sessions', label: 'This week', action: 'go-schedule', aria: 'This week, open schedule' })}
    </div>`;
    html += `<p class="coach">${esc(coach)}</p>`;

    if (!storageOk) html += notice('crit', 'Your logs are not being saved', 'This browser is blocking storage. Open the app from your Home Screen and check that Private Browsing is off.');

    const due = E.dueCheckin(state, t);
    if (due) html += notice('action', due.overdue ? 'Your weekly check-in is overdue' : 'Your weekly check-in is due', `For the week ending ${E.fmtDate(due.date)}. It takes about 3 minutes.`, 'open-checkin');
    backs.forEach((b) => { html += notice('warn', b.title, b.text); });
    const lastCi = state.checkins.slice().sort((x, y) => y.week - x.week)[0];
    if (lastCi && lastCi.ai && lastCi.ai.headline && !lastCi.ai.stopForCare && E.diffDays(t, lastCi.date) <= 7) html += `<button class="notice aihome" data-action="open-history" data-w="${lastCi.week}"><b>From your latest AI review</b>${esc(lastCi.ai.headline)}</button>`;

    if (!finished) {
      const todayEntry = started ? wk.days[E.dayIndex(t)] : weekFor(0).days[0];
      const session = started && todayEntry.second && state.logs[todayEntry.id] ? todayEntry.second : todayEntry;
      if (session) html += todayCard(session, started, wk);
    } else html += `<div class="block"><b>Postseason: active rest</b><p class="muted small">For up to 4 weeks, keep activity short, low in intensity, and recreational. Your logs stay here, so export a backup from Settings.</p></div>`;

    {
      const logged = isNum(day.sleep) || isNum(day.rhr) || isNum(day.soreness);
      const weigh = started && [0, 2, 4].includes(E.dayIndex(t)) && !wk.travel;
      if (!logged || (weigh && !isNum(day.weight))) {
        html += `<button class="btn alt" data-action="open-morning" style="margin-bottom:12px">${logged ? 'Add today\'s weigh-in' : weigh ? 'Log sleep, heart rate, and weigh-in' : 'Log sleep and resting heart rate'}</button>`;
      }
      if (state.targets.walkMin) html += notice('', `Today's walk: ${state.targets.walkMin} minutes`, 'Your check-in added this. Any easy pace counts.');
    }

    // Key numbers
    const ls = E.liftState(state);
    html += `<h3 class="sec-title">Next session targets</h3><div class="tiles">
      ${['incline', 'hack', 'row', 'ohp'].map((id) => `<button class="tile" data-action="go-train-lift" data-id="${id}"><div class="v">${E.targetFor(ls, id, Math.max(0, w))}<small> lb</small></div><div class="l">${esc(E.STRENGTH_BESTS[id].name)}</div></button>`).join('')}
    </div>`;

    const weight = latestWeight();
    const cp = E.nextCheckpoint(t);
    const stats = wk.stats;
    const macros = E.macros(state.targets);
    const weekMiles = summary.miles;
    const planMiles = E.plannedMiles(state, w, t);
    const nextTest = t <= '2027-02-06' ? '3-mile test Feb 6, goal under 27:00' : t <= '2027-05-02' ? '10-mile long run by May 2' : t <= '2027-09-04' ? 'Half test Sep 4, target 1:55:00' : 'Race day, Oct 17';
    const rows = [];
    rows.push(`<button class="kpi" data-action="go-progress"><span class="kl"><span class="kname">Weight</span><br><span class="ksub">${fmtShort(cp.date)} goal ${cp.weight[0]}-${cp.weight[1]} lb</span></span><span class="kv">${weight.value}<small>lb</small></span></button>`);
    rows.push(`<button class="kpi" data-action="go-progress"><span class="kl"><span class="kname">Waist</span><br><span class="ksub">${cp.waist ? `${fmtShort(cp.date)} goal ${cp.waist[0]}-${cp.waist[1]} cm` : 'Reassess in June'}</span></span><span class="kv">${latestWaist()}<small>cm</small></span></button>`);
    rows.push(`<button class="kpi" data-action="go-train-today"><span class="kl"><span class="kname">Easy pace goal</span><br><span class="ksub">${esc(nextTest)}</span></span><span class="kv">${E.fmtPace(stats.easyLo)}<small>to ${E.fmtPace(stats.easyHi)}</small></span></button>`);
    rows.push(`<button class="kpi" data-action="go-progress"><span class="kl"><span class="kname">Miles this week</span><br><span class="ksub">Longest logged run ${stats.longest || 0} mi</span></span><span class="kv">${weekMiles}${wk.pre ? '' : `<small>of ${planMiles}</small>`}</span></button>`);
    if (state.targets.mode !== 'portions') {
      rows.push(`<button class="kpi" data-action="go-fuel"><span class="kl"><span class="kname">Daily calories</span><br><span class="ksub">Protein ${macros.proLo}-${macros.proHi}, carbs ${macros.carbLo}-${macros.carbHi}, fat ${macros.fatLo}-${macros.fatHi} g</span></span><span class="kv">${fmtN(state.targets.calories)}</span></button>`);
    }
    html += `<h3 class="sec-title">Key numbers</h3><div class="block flat">${rows.join('')}</div>`;
    return html;
  }
  const fmtShort = (d) => E.fmtDate(d);
  function todayCard(s, started, wk) {
    const done = state.logs[s.id];
    const when = started ? (s.time ? E.fmtTime(s.time) : 'Any time') : `Monday, Nov 9 at ${E.fmtTime(s.time)}`;
    const goal = s.type === 'lift'
      ? `${E.sessionExercises(s).length} exercises${wk.deload ? ', 2 sets each' : ''}`
      : s.type === 'run' ? s.goal.detail
      : s.type === 'cardio' ? `Keep your heart rate at ${E.HR.easyLo}-${E.HR.easyHi} bpm.` : (s.subtitle || '');
    const label = done ? 'View your log' : s.type === 'recovery' ? 'Open recovery' : started ? 'Start session' : 'Log a workout now';
    return `<div class="today t-${s.type}">
      <div class="eyebrow">${esc(started ? 'Today' : 'First session')}, ${esc(when)}${s.minutes ? `, ${s.minutes} min` : ''}</div>
      <h2>${esc(s.title)}</h2>
      ${s.second ? `<div class="goal" style="margin-bottom:0">Then ${esc(E.fmtTime(s.second.time))}: ${esc(s.second.title)}</div>` : ''}
      <div class="goal">${s.subtitle && s.type !== 'recovery' ? `${esc(s.subtitle)}. ` : ''}${esc(goal)}</div>
      <button class="btn" data-action="go-train-today">${label}</button>
      ${started ? '' : `<button class="btn alt" data-action="open-session" data-w="0" data-d="0">Preview Monday's session</button>`}
    </div>`;
  }

  /* ---------- Train ---------- */
  function renderTrain() {
    const w = ui.trainWeek;
    const wk = weekFor(w);
    const dayEntry = wk.days[ui.trainDay];
    const s = ui.trainPart === 'b' && dayEntry.second ? dayEntry.second : dayEntry;
    let html = `<div class="weeknav">
      <button class="icon-btn" data-action="train-week" data-d="-1" aria-label="Previous week" ${w <= -1 ? 'disabled style="opacity:.25"' : ''}>${I.left}</button>
      <div class="mid"><b>${wk.pre ? 'This week' : `Week ${w + 1}`}: ${esc(E.fmtDate(wk.start))} to ${esc(E.fmtDate(wk.end))}</b><span>${esc(weekLabel(wk))}</span></div>
      <button class="icon-btn" data-action="train-week" data-d="1" aria-label="Next week" ${w >= E.LAST_WEEK ? 'disabled style="opacity:.25"' : ''}>${I.right}</button>
    </div>`;
    html += `<div class="daytabs" role="tablist">${wk.days.map((d) => {
      let st = sessionStatus(d);
      if (d.second) {
        const other = sessionStatus(d.second);
        st = st === 'done' && other === 'done' ? 'done' : st === 'miss' || other === 'miss' ? 'miss' : st === 'done' ? other : st;
      }
      return `<button class="daytab ${d.d === ui.trainDay ? 'on' : ''}" role="tab" aria-selected="${d.d === ui.trainDay}" data-action="train-day" data-d="${d.d}">
        <span class="d">${E.DAY_SHORT[d.d]}</span><span class="n">${esc(shortName(d))}${d.second ? ` + ${esc(shortName(d.second))}` : ''}</span>${st ? `<i class="st ${st === 'today' ? 'now' : st}"></i>` : ''}</button>`;
    }).join('')}</div>`;
    const when = s.time ? E.fmtTime(s.time) : 'Any time';
    if (dayEntry.second) {
      html += `<div class="chips even" role="group" style="margin-bottom:12px">${[dayEntry, dayEntry.second].map((x, i) => `<button class="chip ${x === s ? 'on' : ''}" data-action="train-part" data-part="${i ? 'b' : 'a'}" aria-pressed="${x === s}">${esc(E.fmtTime(x.time))}: ${esc(shortName(x))}${state.logs[x.id] ? ', done' : ''}</button>`).join('')}</div>`;
    }
    html += `<div class="s-head"><h2>${esc(s.title)}</h2><div class="muted">${E.DAY_NAMES[s.d]}, ${E.fmtDate(s.date)}, ${esc(when)}${s.minutes ? `, ${s.minutes} min` : ''}</div></div>`;
    if (!canLog(s)) html += notice('action', `Opens ${E.DAY_NAMES[E.dayIndex(E.weekStart(s.w))]}, ${E.fmtDate(E.weekStart(s.w))}`, 'You can preview this session now. Tap here to log this week\'s workouts instead.', 'go-train-today');
    if (s.skippedForBare) html += notice('warn', 'Optional this week', 'This is a bare-minimum week, so you can skip this session without it counting as missed.');
    if (s.date === today()) E.backOff(state, s.date).forEach((b) => { html += notice('warn', b.title, b.text); });
    if (sessionStatus(s) === 'miss') html += notice('', 'Missed session', 'Use Sunday at 9:00 am to make up one missed session. Do not make up more than one. You can log it here when it\'s done.');
    html += overrideBanner(s);
    if (canAdjust(s)) html += `<button class="btn alt aibtn" data-action="ai-adjust-open" data-id="${s.id}">${s.date === today() ? 'Adjust today\'s session' : 'Adjust this session'}</button>`;
    if (s.type === 'lift') html += renderLift(s, wk);
    else if (s.type === 'run') html += renderRun(s, wk);
    else if (s.type === 'cardio') html += renderCardio(s);
    else html += renderRecovery(s, wk);
    return html;
  }
  const canLog = (s) => s.w <= E.weekOf(today());
  const canAdjust = (s) => aiReady() && canLog(s) && !s.override && !state.logs[s.id] && s.date >= today() && (s.type === 'lift' || s.type === 'cardio' || (s.type === 'run' && s.run.effort !== 'race'));
  function overrideBanner(s) {
    const o = s.override;
    if (!o) return '';
    const logged = !!state.logs[s.id];
    return `<div class="notice good adj"><b>${s.skippedToday ? 'Skipped for today' : 'Adjusted for today'}</b>${o.reason ? esc(o.reason) : ''}
      ${(o.lines || []).length ? `<ul>${o.lines.map((l) => `<li>${esc(l.name)}: ${esc(l.value)}</li>`).join('')}</ul>` : ''}
      ${logged ? '' : `<button class="link small" data-action="ai-override-undo" data-id="${s.id}">Back to the original session</button>`}</div>`;
  }
  function liftDraft(s) {
    if (!state.drafts[s.id]) {
      const log = state.logs[s.id];
      state.drafts[s.id] = log ? JSON.parse(JSON.stringify({ exercises: log.exercises })) : { exercises: {} };
    }
    return state.drafts[s.id];
  }
  function renderLift(s, wk) {
    const draft = liftDraft(s);
    const ls = E.liftState(state);
    const deload = wk.deload || wk.travel;
    const logged = !!state.logs[s.id];
    let html = '';
    if (wk.pre) html += notice('', 'Before your plan starts', 'Log whatever you lift this week, using your real weights. It goes on your graphs and sets your next target.');
    else if (wk.travel) html += notice('', 'Travel session', 'Use whatever equipment is there and follow the listed reps.');
    else if (wk.deload) html += notice('', wk.finals ? 'Finals unloading week' : 'Unloading week', 'Do 2 sets per exercise and keep the same weights.');
    else if (s.subtitle === 'Light session') html += notice('', 'Light session', 'Keep this short: core lifts only, with the sets and reps below.');
    else html += notice('', `${wk.scheme.label} phase`, `Core lifts: ${wk.scheme.core.sets} sets of ${wk.scheme.core.goal} at ${Math.round(wk.scheme.core.pct * 100)}% of your estimated 1RM, resting ${wk.scheme.core.rest}. Assistance lifts: ${wk.scheme.assist.sets} sets of ${wk.scheme.assist.goal}, resting ${wk.scheme.assist.rest}.`);
    const glog = state.logs[s.id];
    if (glog && glog.source === 'garmin' && !Object.keys(glog.exercises || {}).length) html += notice('good', 'Counted from Garmin', `${glog.minutes ? `${glog.minutes} minutes` : 'Session'}${glog.hr ? `, average ${Math.round(glog.hr)} bpm` : ''}. Garmin doesn't give me reliable sets, so add your weights and reps below to update your targets and graphs.`);
    html += `<p class="tiny" style="margin:0 2px 10px">Warm up with 5 minutes on the bike, then 2 lighter sets of the first exercise. Leave a weight blank to use the one shown.</p>`;
    E.sessionExercises(s).forEach((id) => {
      const ex = E.EX[id];
      const st = ls[id];
      const plan = E.sessionPlan(s, id, deload);
      const nSets = plan.sets;
      const target = logged ? E.targetFor(ls, id, s.w) : E.sessionTarget(ls, s, id);
      const entry = draft.exercises[id] || { sets: [] };
      const unit = ex.kind === 'time' ? null : ex.kind === 'assist' ? 'assist' : 'lb';
      const rangeText = ex.kind === 'time' ? `${nSets} x ${target} sec` : `${nSets} x ${plan.goal}${ex.perLeg ? ' per leg' : ''}${ex.kind === 'power' ? ', as fast as you can' : ''}`;
      const statusCls = logged && st.status === 'up' ? 'up' : logged && st.status === 'down' ? 'down' : '';
      html += `<div class="ex"><div class="ex-top"><div><div class="ex-name">${esc(ex.name)}</div><div class="ex-pres">${rangeText}, rest ${plan.rest}</div>${target == null && ex.kind !== 'power' ? `<div class="ex-pres">Find the weight that gets you about ${plan.goal + 2} reps at most.</div>` : ''}${plan.adjusted ? `<div class="ex-adj">Adjusted today${plan.note ? `: ${esc(plan.note)}` : ''}</div>` : ''}</div>
        <div class="ex-goal ${statusCls}">${esc(E.loadText(ex, target))}<small>${logged ? 'next target' : plan.adjusted ? 'today' : 'target'}</small></div></div>`;
      html += '<div class="sets">';
      for (let i = 0; i < nSets; i++) {
        const set = entry.sets[i] || {};
        let carried = null;
        for (let j = i - 1; j >= 0; j--) {
          if (entry.sets[j] && entry.sets[j].w !== undefined && entry.sets[j].w !== '') { carried = entry.sets[j].w; break; }
        }
        const defaultW = carried != null ? carried : target != null && target !== 0 ? target : '';
        const wVal = set.w !== undefined ? set.w : '';
        html += `<div class="setrow"><span class="i">${i + 1}</span>`;
        if (ex.kind === 'time') html += `<span class="tiny">Hold for</span>`;
        else if (ex.kind === 'power') html += `<span class="tiny">Bodyweight</span>`;
        else html += field(`data-set="w" data-ex="${id}" data-i="${i}" aria-label="${esc(ex.name)} set ${i + 1} weight"`, unit, wVal, defaultW === '' ? (ex.start === 0 ? '0' : '') : String(defaultW), !canLog(s));
        html += field(`data-set="r" data-ex="${id}" data-i="${i}" aria-label="${esc(ex.name)} set ${i + 1} ${ex.kind === 'time' ? 'seconds' : 'reps'}"`, ex.kind === 'time' ? 'sec' : 'reps', set.r, ex.kind === 'time' ? String(target) : String(plan.goal), !canLog(s));
        html += '</div>';
      }
      html += '</div>';
      const hasGraph = E.exerciseHistory(state, id).rows.length > 0;
      if (hasGraph || aiReady()) html += `<div class="ex-links">${hasGraph ? `<button class="link small" data-action="open-lift-chart" data-id="${id}">View progress graph</button>` : ''}${aiReady() ? `<button class="link small" data-action="ai-explain" data-id="${id}">Why and how</button>` : ''}</div>`;
      if (st.last) html += `<div class="ex-last">Last: ${st.last.sets.map((x) => (ex.kind === 'time' ? `${x.r} sec` : x.w != null && x.w !== '' ? `${x.w}x${x.r}` : `${x.r} reps`)).join(', ')}</div>`;
      if (logged && st.reason && st.last && st.last.w === s.w) html += `<div class="ex-why">${esc(st.reason)}</div>`;
      html += '</div>';
    });
    if (ui.error) html += `<p class="err">${esc(ui.error)}</p>`;
    html += canLog(s)
      ? `<button class="btn" data-action="save-lift" data-id="${s.id}">${logged ? 'Update workout' : 'Finish workout'}</button>${logged ? `<button class="btn alt" data-action="delete-log" data-id="${s.id}">Delete this log</button>` : ''}`
      : '';
    return html;
  }

  function runDraft(s) {
    if (!state.drafts[s.id]) {
      const log = state.logs[s.id];
      state.drafts[s.id] = log ? { distance: log.distance, min: Math.floor(log.seconds / 60), sec: log.seconds % 60, hr: log.hr, talk: log.talk, completed: log.completed !== false, hard: !!log.hard } : { distance: '', min: '', sec: '', hr: '', talk: null, completed: true, hard: s.run.effort === 'test' };
    }
    return state.drafts[s.id];
  }
  function renderRun(s, wk) {
    const d = runDraft(s);
    const g = s.goal;
    const run = s.run;
    let html = '';
    if (s.repeated) html += notice('', 'Repeat this block', 'A recent week missed its heart-rate target or was not logged, so you are holding here before moving on.');
    if (wk.shift >= 4 && s.w >= 6) html += notice('warn', `You're ${Math.min(wk.shift, 6)}+ weeks behind the mileage plan`, 'Mileage has slid back to match where you are, and finishing healthy should be the goal for now. Unlogged weeks count too, so if you ran them, log them here.');
    html += `<div class="goalbox"><div class="gl">${run.kind === 'intervals' ? 'Goal time' : run.effort === 'test' ? 'Goal time' : run.effort === 'race' ? 'Distance' : 'Goal time'}</div><div class="gv">${esc(g.headline)}</div>${s.subtitle ? `<div class="muted">${esc(s.subtitle)}</div>` : ''}<p>${esc(g.detail)}</p>${aiReady() ? '<button class="link small" data-action="ai-explain" data-id="">Why this run</button>' : ''}</div>`;
    if (run.kind === 'intervals') {
      html += `<div class="block"><ol class="steps">
        <li><b>Walk 5 minutes</b></li>
        <li><b>Repeat ${run.reps} times</b><span>Run ${run.run} minutes, then walk ${run.walk} minutes.</span></li>
        <li><b>Walk 5 minutes</b></li></ol></div>`;
    }
    const fuel = E.longRunFuel(s);
    if (fuel && state.targets.mode !== 'portions') html += `<p class="tiny" style="margin:0 2px 12px">${esc(fuel)}</p>`;
    if (!canLog(s)) return html;
    const logged = state.logs[s.id];
    if (logged && logged.source === 'garmin') html += notice('good', 'Imported from Garmin', `${logged.hr ? `Average ${Math.round(logged.hr)} bpm. ` : ''}Change anything below if it looks wrong.`);
    html += `<div class="block"><div class="formgrid">
      <div class="wide"><span class="lbl">Distance from your Garmin</span>${field('data-run="distance"', 'mi', d.distance, run.miles ? String(run.miles) : '')}</div>
      <div><span class="lbl">Minutes</span>${field('data-run="min" inputmode="numeric"', 'min', d.min, '')}</div>
      <div><span class="lbl">Seconds</span>${field('data-run="sec" inputmode="numeric"', 'sec', d.sec, '0')}</div>
      <div class="wide"><span class="lbl">Average heart rate (optional)</span>${field('data-run="hr" inputmode="numeric"', 'bpm', d.hr, '')}</div>
      <div class="wide"><span class="lbl">${['tempo', 'interval', 'fartlek', 'test', 'race'].includes(run.effort) ? 'Did you hit the planned effort?' : `Did your heart rate stay at or under ${E.HR.easyHi} bpm?`}</span>${chips('talk', [{ v: 'pass', l: 'Yes' }, { v: 'fail', l: 'No' }], d.talk, 'even')}</div>
      <div class="wide"><span class="lbl">Did you finish the whole session?</span>${chips('completed', [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }], d.completed ? 'yes' : 'no', 'even')}</div>
      <div class="wide"><span class="lbl">Was this a hard, all-out effort?</span>${chips('hard', [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }], d.hard ? 'yes' : 'no', 'even')}<span class="tiny" style="display:block;margin-top:5px">Hard efforts update your race estimates. Easy runs update your easy pace.</span></div>
    </div></div>`;
    if (ui.error) html += `<p class="err">${esc(ui.error)}</p>`;
    html += `<button class="btn" data-action="save-run" data-id="${s.id}">${logged ? 'Update run' : 'Save run'}</button>${logged ? `<button class="btn alt" data-action="delete-log" data-id="${s.id}">Delete this log</button>` : ''}`;
    return html;
  }
  function renderCardio(s) {
    if (!state.drafts[s.id]) {
      const log = state.logs[s.id];
      state.drafts[s.id] = log ? { machine: log.machine, minutes: log.minutes, talk: log.talk } : { machine: s.title === 'Bike' ? 'Bike' : 'Stairmaster', minutes: '', talk: null };
    }
    const d = state.drafts[s.id];
    let html = `<div class="goalbox"><div class="gl">Goal time</div><div class="gv">${s.minutes} min</div><p>Keep your heart rate at ${E.HR.easyLo}-${E.HR.easyHi} bpm on your choice of machine.</p></div>`;
    if (!canLog(s)) return html;
    const logged = state.logs[s.id];
    html += `<div class="block"><div class="q"><span class="lbl">Machine</span>${chips('machine', ['Stairmaster', 'Bike'], d.machine, 'even')}</div>
      <div class="q"><span class="lbl">Minutes</span>${field('data-cardio="minutes" inputmode="numeric"', 'min', d.minutes, String(s.minutes))}</div>
      <div class="q"><span class="lbl">Did your heart rate stay at or under ${E.HR.easyHi} bpm?</span>${chips('talk', [{ v: 'pass', l: 'Yes' }, { v: 'fail', l: 'No' }], d.talk, 'even')}</div>
      <p class="tiny">Optional afterward, and not part of the NSCA program: 10 minutes in the sauna, with water. Leave right away if you feel dizzy.</p></div>`;
    if (ui.error) html += `<p class="err">${esc(ui.error)}</p>`;
    html += `<button class="btn" data-action="save-cardio" data-id="${s.id}">${logged ? 'Update session' : 'Save session'}</button>${logged ? `<button class="btn alt" data-action="delete-log" data-id="${s.id}">Delete this log</button>` : ''}`;
    return html;
  }
  const RECOVERY_ITEMS = [
    ['walk', '20-30 minute walk', 'Easy pace'],
    ['sauna', '10-15 minutes in the sauna', 'Bring water, and leave right away if you feel dizzy'],
    ['hydro', '10-15 minutes in the hydromassage chair', ''],
    ['meal', 'Meal prep', 'Shop and cook from this week\'s updated portions']
  ];
  function renderRecovery(s, wk) {
    const log = state.logs[s.id] || { type: 'recovery', items: {} };
    let html = '';
    if (s.d === 6 && s.w < E.LAST_WEEK) {
      const c = state.checkins.find((x) => x.week === s.w);
      html += c
        ? notice('good', 'Check-in complete', `You finished this week's check-in on ${E.fmtDate(c.date)}.`)
        : s.date <= today() ? notice('action', 'Weekly check-in', `Do this at ${E.fmtTime(state.checkinTime)}, before breakfast.`, 'open-checkin') : notice('', 'Weekly check-in', `Due ${E.fmtDate(s.date)} at ${E.fmtTime(state.checkinTime)}, before breakfast.`);
    }
    if (s.title === 'Rest' || s.minutes === 0) return `${html}<div class="block"><p class="muted">${esc(s.subtitle || 'Take it easy today.')}</p></div>`;
    html += `<div class="block" style="padding-top:3px;padding-bottom:3px">${RECOVERY_ITEMS.map(([id, t, sub]) => checkRow(id, t, sub, log.items && log.items[id], `toggle-recovery:${s.id}`)).join('')}</div>`;
    html += `<details class="more"><summary>Every night and morning</summary><div class="inner"><ul>
      <li>Screens off at 10:30 pm, lights out at 11:00 pm, and sleep device on.</li>
      <li>Wake at 7:00 am, including weekends if you can.</li>
      <li>After runs, walk for 5 minutes, then spend 10 minutes on your calves, hip flexors, glutes, and upper back.</li>
    </ul></div></details>`;
    html += `<details class="more"><summary>When to get help</summary><div class="inner"><ul>
      <li>Sharp pain, or pain that changes how you run: stop running, use the bike if it doesn't hurt.</li>
      <li>Pain lasting more than a few days: see a doctor or physical therapist.</li>
      <li>Chest pain, fainting, or unusual shortness of breath: stop immediately and get medical care before training again.</li>
    </ul></div></details>`;
    return html;
  }

  /* ---------- Schedule ---------- */
  function renderSchedule() {
    const w = ui.schedWeek;
    const wk = weekFor(w);
    const t = today();
    let html = `<div class="weeknav">
      <button class="icon-btn" data-action="sched-week" data-d="-1" aria-label="Previous week" ${w <= 0 ? 'disabled style="opacity:.25"' : ''}>${I.left}</button>
      <div class="mid"><b>Week ${w + 1}: ${esc(E.fmtDate(wk.start))} to ${esc(E.fmtDate(wk.end))}</b><span>${esc(weekLabel(wk))}</span></div>
      <button class="icon-btn" data-action="sched-week" data-d="1" aria-label="Next week" ${w >= E.LAST_WEEK ? 'disabled style="opacity:.25"' : ''}>${I.right}</button>
    </div>`;
    if (wk.bare) html += notice('warn', 'Bare-minimum week', 'Do Lower A, Push, Pull, the Wednesday run, and the Saturday run. That still counts as a win.');
    if (w >= 6 && w <= 7 && t >= '2026-12-20') html += notice('', 'Set your new times', 'Keep this order and change the times to fit your new schedule.', 'open-settings');
    html += '<div class="block flat" style="margin-bottom:12px">';
    E.weekSessions(wk).forEach((s) => {
      const st = sessionStatus(s);
      const right = st === 'done' ? 'Done' : s.minutes ? `${s.minutes} min` : '';
      const rightSub = st === 'miss' ? 'Missed' : s.skippedForBare ? 'Optional' : '';
      if (s.d === 6 && w < E.LAST_WEEK) {
        const done = state.checkins.some((x) => x.week === w);
        html += `<button class="sch ${s.date === t && !done ? 'istoday' : ''}" data-action="scroll-checkin">
          <span class="when"><b>Sun</b><span>${E.fmtTime(state.checkinTime).replace(' ', '')}</span></span>
          <span class="what"><b>Weekly check-in</b><span>Before breakfast. Instructions below.</span></span>
          <span class="right">${done ? 'Done' : '3 min'}<span></span></span></button>`;
      }
      const goalLine = s.type === 'run' ? (s.run.kind === 'intervals' ? s.subtitle : `${s.subtitle}, goal ${s.goal.headline}`) : s.type === 'lift' ? (wk.deload ? 'Deload, 2 sets each' : s.subtitle || `${E.sessionExercises(s).length} exercises`) : s.subtitle;
      html += `<button class="sch ${s.date === t ? 'istoday' : ''} ${s.skippedForBare ? 'skip' : ''}" data-action="open-session" data-w="${s.w}" data-d="${s.d}" data-part="${s.part === 'b' ? 'b' : 'a'}">
        <span class="when"><b>${E.DAY_SHORT[s.d]}</b><span>${s.time ? E.fmtTime(s.time).replace(' ', '') : 'Any time'}</span></span>
        <span class="what"><b>${esc(s.title)}</b><span>${esc(goalLine || '')}</span></span>
        <span class="right">${esc(right)}<span>${esc(rightSub)}</span></span></button>`;
    });
    html += '</div>';

    // Check-in with exact instructions
    const c = state.checkins.find((x) => x.week === w);
    const date = E.checkinDate(w);
    if (w < E.LAST_WEEK) html += `<div class="ci-card" id="checkin-card"><div class="muted small">Weekly check-in, about 3 minutes</div><h3>Sunday, ${E.fmtDate(date)} at ${E.fmtTime(state.checkinTime)}</h3><div class="small">Before breakfast, so your waist and weight are comparable and your new portions are ready for meal prep.</div>`;
    if (w < E.LAST_WEEK) {
    if (wk.travel) html += '<div class="small" style="margin-top:8px">Keep this one short: you\'re traveling, so nothing changes and no waist or weight is needed.</div>';
    html += `<ol class="steps">${E.checkinInstructions(state, w).map((x) => `<li><b>${esc(x.title)}</b><span>${esc(x.text)}</span></li>`).join('')}</ol>`;
    if (c) html += `<button class="btn alt" style="margin-top:14px" data-action="open-history" data-w="${w}">View this check-in</button>`;
    else if (date <= t) html += `<button class="btn" style="margin-top:14px" data-action="open-checkin" data-w="${w}">Start check-in</button>`;
    else html += `<p class="tiny" style="margin-top:12px;color:var(--ink-2)">The check-in opens on ${E.fmtDate(date)}.</p>`;
    html += '</div>';

    } else html += notice('good', 'Race week', 'No check-in this week. Enjoy the race.');

    html += `<details class="more"><summary>If you miss a session</summary><div class="inner"><ul>
      <li>Use Sunday at 9:00 am to make up one missed session of any kind.</li>
      <li>Do not try to make up more than one.</li>
      <li>Bare-minimum week: Lower A, Push, Pull, the Wednesday run, and the Saturday run.</li>
    </ul></div></details>`;
    html += '<button class="btn alt" data-action="export-ics">Add the next 6 weeks to Calendar</button>';
    html += '<button class="btn alt" data-action="open-settings">Change training times</button>';
    return html;
  }

  /* ---------- Fuel ---------- */
  const macroRow = (name, value, lo, hi, color) => {
    const status = E.rangeStatus(value, lo, hi, 'g');
    const mid = (lo + hi) / 2;
    return `<div class="macro"><div class="macro-top"><b>${esc(name)}</b><span>${Math.round(value)} <small>of ${lo}-${hi} g</small></span></div>
      <div class="bar"><i style="width:${Math.min(100, (value / mid) * 100)}%;background:${color}"></i></div>
      <div class="macro-note">${esc(status.text)}</div></div>`;
  };
  function renderFuel() {
    const t = today();
    const date = ui.fuelDate || t;
    const isToday = date === t;
    const tg = state.targets;
    const day = state.food[date] || { meals: {} };
    const plan = E.mealPlan(tg);
    const m = E.macros(tg);
    const totals = E.foodTotals(day, plan);
    const portions = tg.mode === 'portions';
    const track = E.trackingToday(state, t);
    const w = clampWeek(E.weekOf(date));
    const wkDates = Array.from({ length: 7 }, (_, i) => E.dateOf(w, i));
    const flexUsed = wkDates.reduce((acc, d) => acc + Object.keys((state.food[d] && state.food[d].flex) || {}).filter((k) => state.food[d].flex[k]).length, 0);
    const wk = weekFor(nowWeek());
    const session = t >= E.START && t <= E.RACE ? wk.days[E.dayIndex(t)] : null;
    const fuelNote = isToday && session ? E.longRunFuel(session) : null;
    const items = day.items || [];

    let html = `<div class="weeknav">
      <button class="icon-btn" data-action="fuel-date" data-d="-1" aria-label="Previous day">${I.left}</button>
      <div class="mid"><b>${isToday ? 'Today' : esc(E.DAY_NAMES[E.dayIndex(date)])}, ${esc(E.fmtDate(date))}</b><span>${isToday ? esc(track.text) : 'Earlier day'}</span></div>
      <button class="icon-btn" data-action="fuel-date" data-d="1" aria-label="Next day" ${isToday ? 'disabled style="opacity:.25"' : ''}>${I.right}</button>
    </div>`;

    if (!portions) {
      const calStatus = E.rangeStatus(totals.cal, m.calLo, m.calHi, 'cal');
      const left = tg.calories - totals.cal;
      html += `<div class="block fuelhero">
        <div class="fueldial">${dial({ value: totals.cal / tg.calories, color: 'var(--good)', main: fmtN(Math.round(totals.cal)), unit: `of ${fmtN(tg.calories)}`, label: 'Calories', big: true, aria: 'Calories eaten today' })}
          <div class="macro-note center">${esc(calStatus.state === 'under' && left > 0 ? `${fmtN(Math.round(left))} left` : calStatus.text)}</div></div>
        <div class="fuelbars">
          ${macroRow('Protein', totals.pro, m.proLo, m.proHi, 'var(--blue)')}
          ${macroRow('Carbs', totals.carb, m.carbLo, m.carbHi, 'var(--good)')}
          ${macroRow('Fat', totals.fat, m.fatLo, m.fatHi, 'var(--sleep)')}
        </div>
      </div>`;
      html += `<button class="btn" data-action="food-add" style="margin-bottom:12px">Add food</button>`;
      html += `<h3 class="sec-title">Food log</h3>`;
      if (items.length) {
        html += `<div class="block flat">${items.map((x) => `<button class="food" data-action="food-edit" data-id="${esc(x.id)}">
          <span class="food-l"><b>${esc(x.name)}</b><span>${esc(x.amount)} ${esc(x.unit)}, P ${esc(x.p)}, C ${esc(x.c)}, F ${esc(x.f)}</span></span>
          <span class="food-r">${fmtN(Math.round(x.cal))}<span>cal</span></span></button>`).join('')}</div>`;
      } else html += `<div class="block muted small">Nothing logged ${isToday ? 'yet today' : 'for this day'}. Add a food, or check off a planned meal below if you ate it as written.</div>`;
    } else {
      html += notice('', 'Portion guides are on', 'Calories and food logging are hidden. You can turn tracking back on in Settings.');
    }
    if (tg.mealShift) html += notice('', 'Meal timing changed', 'Your check-in moved 1/2 cup of lunch rice to dinner to help with evening cravings.');
    if (fuelNote) html += notice('', 'Long-run fuel', fuelNote);

    html += `<h3 class="sec-title">Planned meals</h3><div class="block" style="padding-top:3px;padding-bottom:3px">`;
    plan.meals.forEach((x) => {
      const on = day.meals && day.meals[x.id];
      html += `<button class="meal ${on ? 'on' : ''}" data-action="toggle-meal" data-id="${x.id}" aria-pressed="${!!on}"><span class="box">${I.check}</span>
        <span><span class="mt">${esc(x.time)}</span><b>${esc(x.name)}</b><span class="mp">${esc(portions ? x.portionsGuide : x.portions)}</span></span>
        ${portions ? '<span></span>' : `<span class="mn">${x.cal}<span>${x.pro}P ${x.carb}C ${x.fat}F</span></span>`}</button>`;
    });
    html += '</div>';
    html += `<p class="tiny" style="margin:-4px 2px 12px">Checking a meal adds its estimated numbers to your totals. If you ate something different, use Add food instead. On Fridays and weekends, keep the same meals and move the times to fit your day.</p>`;

    html += `<h3 class="sec-title">Flexible meals</h3><div class="block"><div class="macro-top"><b>${flexUsed} of 2 used this week</b></div>
      <p class="muted small" style="margin:4px 0 10px">Replace any planned meal with what you want, then go right back to the plan at your next meal. There's nothing to make up.</p>
      <div class="chips" style="gap:6px">${plan.meals.filter((x) => ['burrito', 'lunch', 'dinner'].includes(x.id)).map((x) => {
        const on = day.flex && day.flex[x.id];
        return `<button class="chip ${on ? 'on' : ''}" data-action="toggle-flex" data-id="${x.id}" aria-pressed="${!!on}">${esc(x.name)}</button>`;
      }).join('')}</div></div>`;

    html += `<details class="more"><summary>Cravings and eating out</summary><div class="inner"><ul>
      <li>Don't skip meals or add cardio to compensate. Eating out is part of the plan.</li>
      <li>Your 8:45 dinner and planned dessert are there to head off late-night cravings.</li>
      <li>If you're still truly hungry, have a Ryse shake and note it at check-in.</li>
      <li>If tracking starts causing guilt, skipped meals, or extra exercise, say so at check-in and the app switches you to portion guides.</li>
    </ul></div></details>`;
    html += `<details class="more"><summary>Weekly grocery list</summary><div class="inner"><ul>
      <li><b>Protein:</b> 1 dozen eggs, 2 cartons (32 oz each) egg whites, 1.5 lb 93/7 beef, 3 lb chicken breast, 2.5 lb trout or other frozen fish, Ryse protein as needed</li>
      <li><b>Carbs:</b> ${plan.lunchRice + plan.dinnerRice > 3 ? '3' : '2.5'} lb rice, 3 lb potatoes, 1 pack carb-counter or corn tortillas, 8 bananas, 7 apples</li>
      <li><b>Vegetables and fats:</b> 3 bags frozen vegetables, 2 onions, 5 avocados, almonds as needed</li>
      <li><b>Extras:</b> salsa, Bachan's, almond milk, Outshine bars, creatine as needed</li>
    </ul><p class="tiny" style="margin-top:6px">Target budget: $100 a week. If your receipt runs high, swap some trout for chicken.</p></div></details>`;
    html += `<details class="more"><summary>Fluids and supplements</summary><div class="inner"><ul>
      <li>Fluids: about 3.7 liters a day from all sources, and more on long-run days. Keep sweat loss during training under 2% of body weight.</li>
      <li>Creatine: 3-5 g a day.</li>
      <li>Caffeine: stay at or under 200-300 mg a day, with your last dose by 1:00 pm.</li>
    </ul></div></details>`;
    return html;
  }

  /* ---------- Progress ---------- */
  function lineChart(id, points, opts) {
    const W = 340;
    const H = opts.h || 150;
    const L = 34;
    const R = 8;
    const T = 10;
    const B = 20;
    if (!points.length) return `<p class="muted small">${esc(opts.empty)}</p>`;
    const ys = points.map((p) => p.y).concat(opts.band || []);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (hi - lo < 4) { lo -= 2; hi += 2; }
    const pad = (hi - lo) * 0.1;
    lo -= pad;
    hi += pad;
    const xs = points.map((p) => p.x);
    const x0 = Math.min(...xs, opts.xMin == null ? Infinity : opts.xMin);
    const x1 = Math.max(...xs, opts.xMax == null ? -Infinity : opts.xMax);
    const X = (x) => (x1 === x0 ? L + (W - L - R) / 2 : L + ((x - x0) / (x1 - x0)) * (W - L - R));
    const Y = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    const color = 'var(--chart, #3F90E6)';
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join('');
    const hitW = Math.max(28, (W - L - R) / Math.max(1, points.length));
    return `<div class="readout" id="ro-${id}"><b>${esc(points[points.length - 1].show)}</b>${esc(points[points.length - 1].label)}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria)}">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
      ${opts.band ? `<rect x="${L}" y="${Y(opts.band[1])}" width="${W - L - R}" height="${Math.max(2, Y(opts.band[0]) - Y(opts.band[1]))}" fill="var(--good)" opacity=".13" rx="3"/>` : ''}
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${points.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="${color}" stroke="var(--card)" stroke-width="2"/>`).join('')}
      ${opts.xLabels && points.length > 1 ? `<text x="${L}" y="${H - 5}">${esc(opts.xLabels[0])}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">${esc(opts.xLabels[1])}</text>` : ''}
      ${points.map((p) => `<rect data-action="tip" data-ro="ro-${id}" data-show="${esc(p.show)}" data-label="${esc(p.label)}" x="${X(p.x) - hitW / 2}" y="0" width="${hitW}" height="${H}" fill="transparent"/>`).join('')}
    </svg>${opts.band ? `<div class="legend"><span><i style="background:${color}"></i>${esc(opts.seriesName)}</span><span><i class="band" style="background:var(--good);opacity:.35"></i>${esc(opts.bandName)}</span></div>` : ''}`;
  }
  function milesChart() {
    const t = today();
    const cur = nowWeek();
    const from = Math.max(-1, cur - 11);
    const rows = [];
    for (let w = from; w <= cur; w++) rows.push({ w, miles: E.weekSummary(state, w, t).miles, plan: w < 0 ? 0 : E.plannedMiles(state, w, t) });
    const weekName = (w) => (w < 0 ? 'before your plan' : `week ${w + 1}`);
    const W = 340;
    const H = 150;
    const L = 26;
    const B = 20;
    const T = 8;
    const max = Math.max(5, ...rows.map((r) => Math.max(r.miles, r.plan)));
    const band = (W - L - 4) / Math.max(rows.length, 6);
    const barW = Math.max(6, Math.min(18, band - 6));
    const Y = (v) => T + (1 - v / max) * (H - T - B);
    const last = rows[rows.length - 1];
    return `<div class="readout" id="ro-miles"><b>${last.miles} mi</b>${weekName(last.w)}${last.w < 0 ? '' : `, plan ${last.plan} mi`}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly running miles against plan">
      ${[0, max / 2, max].map((v) => `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${L - 5}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
      ${rows.map((r, i) => {
        const x = L + 2 + i * band + (band - barW) / 2;
        const top = Y(r.miles);
        return `${r.miles > 0 ? `<rect x="${x}" y="${top}" width="${barW}" height="${Y(0) - top}" rx="3" fill="#3F90E6"/>` : ''}
          ${r.w < 0 ? '' : `<line x1="${x - 2}" x2="${x + barW + 2}" y1="${Y(r.plan)}" y2="${Y(r.plan)}" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>`}
          <text x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${r.w < 0 ? 'Pre' : r.w + 1}</text>
          <rect data-action="tip" data-ro="ro-miles" data-show="${r.miles} mi" data-label="${weekName(r.w)}${r.w < 0 ? '' : `, plan ${r.plan} mi`}" x="${L + 2 + i * band}" y="0" width="${band}" height="${H}" fill="transparent"/>`;
      }).join('')}
    </svg>
    <div class="legend"><span><i style="background:#3F90E6;height:9px"></i>Logged miles</span><span><i style="background:var(--ink)"></i>Plan</span><span>Bottom axis: training week</span></div>`;
  }
  function liftSelect() {
    const groups = ['upperA', 'lower', 'upperB'].map((k) => {
      const seen = new Set();
      const opts = E.LIFTS[k].list.filter((id) => {
        const n = E.EX[id].name;
        if (k === 'upperB' && n === 'Lateral raise') return false;
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return `<optgroup label="${esc(E.LIFTS[k].name)}">${opts.map((id) => `<option value="${id}" ${id === ui.liftChart ? 'selected' : ''}>${esc(E.EX[id].name)}</option>`).join('')}</optgroup>`;
    });
    return `<select id="lift-select" class="inp" data-lift-select="1">${groups.join('')}</select>`;
  }
  function liftChartHtml(id, key) {
    const h = E.exerciseHistory(state, id);
    if (!h.rows.length) return `<p class="muted small">${esc(h.name)} has no logged sets yet. Log it on the Train tab and your graph starts here.</p>`;
    const setsText = (r) => r.sets.map((s) => (h.unit === 'sec' ? `${s.r} sec` : s.w ? `${s.w}x${s.r}` : `${s.r} reps`)).join(', ');
    const pts = h.rows.map((r) => ({ x: E.diffDays(r.date, E.START), y: r.value, show: `${r.value} ${h.unit}`, label: `${E.fmtDate(r.date)}: ${setsText(r)}` }));
    const first = h.rows[0];
    const last = h.rows[h.rows.length - 1];
    const change = last.value - first.value;
    return `${lineChart(`lift-${key}`, pts, { aria: `${h.name} ${h.label} over time`, empty: '', xLabels: [E.fmtDate(first.date), E.fmtDate(last.date)] })}
      <div class="tiny" style="margin-top:6px">${esc(h.label)} per session. ${h.rows.length > 1 ? `${change > 0 ? 'Up' : change < 0 ? 'Down' : 'No change'}${change ? ` ${Math.abs(change)} ${h.unit}` : ''} since ${esc(E.fmtDate(first.date))}. ` : ''}Tap a point to see its sets.</div>
      <details class="numbers"><summary>Show every session</summary><table class="tbl"><thead><tr><th>Date</th><th>Sets</th></tr></thead><tbody>${h.rows.slice().reverse().map((r) => `<tr><td>${esc(E.fmtDate(r.date))}</td><td>${esc(setsText(r))}</td></tr>`).join('')}</tbody></table></details>`;
  }
  function renderProgress() {
    const t = today();
    const cis = state.checkins.slice().sort((a, b) => a.week - b.week);
    const cp = E.nextCheckpoint(t);
    const weightPts = [];
    for (let i = -1; i <= nowWeek(); i++) {
      const ci = cis.find((c) => c.week === i && isNum(c.data.weightAvg));
      const avg = ci ? Number(ci.data.weightAvg) : E.weekSummary(state, i, t).weightAvg;
      if (avg != null) weightPts.push({ x: i, y: avg, show: `${avg} lb`, label: `average, week ending ${E.fmtDate(E.dateOf(i, 6))}` });
    }
    const waistPts = cis.filter((c) => isNum(c.data.waist)).map((c) => ({ x: c.week, y: Number(c.data.waist), show: `${c.data.waist} cm`, label: `week ${c.week + 1}, ${E.fmtDate(E.checkinDate(c.week))}` }));
    const ls = E.liftState(state);
    const stats = E.runStats(state, t);
    let html = `<div class="top"><div><h1>Progress</h1><div class="sub">Next checkpoint ${E.fmtDate(cp.date)}</div></div></div>`;

    html += `<div class="block">${E.CHECKPOINTS.map((c) => `<div class="goalrow"><b>${E.fmtDate(c.date)}</b><div><p>${c.weight[0]}-${c.weight[1]} lb${c.waist ? `, waist ${c.waist[0]}-${c.waist[1]} cm` : ''}</p><p>${esc(c.run)}</p><p>${esc(c.strength)}</p></div></div>`).join('')}</div>`;

    html += `<h3 class="sec-title">Weekly average weight</h3><div class="block">${lineChart('w', weightPts, { aria: 'Weekly average weight', empty: 'Log a morning weight from Home and your first point appears here. You started at 205.5 lb.', band: cp.weight, seriesName: 'Weekly average', bandName: `${E.fmtDate(cp.date)} goal` })}</div>`;
    html += `<h3 class="sec-title">Waist</h3><div class="block">${lineChart('wa', waistPts, { aria: 'Waist measurement', empty: 'You measure this every other Sunday. You started at 93 cm.', h: 120, band: cp.waist || undefined, seriesName: 'Waist', bandName: `${E.fmtDate(cp.date)} goal` })}</div>`;

    html += `<h3 class="sec-title">Running</h3><div class="block">${milesChart()}</div>`;
    const baseline = E.garminBaseline(state);
    if (baseline) html += `<div class="block flat"><div class="kpi"><span class="kl"><span class="kname">Your running before the plan</span><br><span class="ksub">Last 8 weeks: ${baseline.count} run${baseline.count === 1 ? '' : 's'}, longest ${Math.round(baseline.longest * 10) / 10} mi, average pace ${E.fmtPace(baseline.avgPace)}</span></span><span class="kv">${baseline.weeklyMiles}<small>mi/wk</small></span></div></div>`;
    html += `<div style="margin-bottom:12px">${garminUpload()}</div>`;
    const pred = stats.prediction;
    html += `<div class="block flat">
      <div class="kpi"><span class="kl"><span class="kname">Easy pace goal</span><br><span class="ksub">${stats.logged ? 'Learned from your last 3 easy runs' : 'Starts from your 10:00 test mile'}</span></span><span class="kv">${E.fmtPace(stats.easyLo)}<small>to ${E.fmtPace(stats.easyHi)}</small></span></div>
      ${pred ? `<div class="kpi"><span class="kl"><span class="kname">3-mile estimate</span><br><span class="ksub">Stretch goal 27:00</span></span><span class="kv">${E.fmtDur(pred.threeMile)}</span></div>
      <div class="kpi"><span class="kl"><span class="kname">Half estimate</span><br><span class="ksub">Target 1:55:00</span></span><span class="kv">${E.fmtDur(pred.half)}</span></div>
      <div class="kpi"><span class="kl"><span class="kname">Marathon estimate</span><br><span class="ksub">Assumes the long runs are done</span></span><span class="kv">${E.fmtDur(pred.marathon)}</span></div>` : `<div class="kpi"><span class="kl"><span class="kname">Race estimates</span><br><span class="ksub">These appear after your first hard effort. Your 3-mile test is February 6.</span></span></div>`}
    </div>`;

    html += `<h3 class="sec-title">Lifting progress</h3><div class="block"><label class="lbl" for="lift-select">Exercise</label>${liftSelect()}<div style="margin-top:12px">${liftChartHtml(ui.liftChart, 'p')}</div></div>`;
    html += `<h3 class="sec-title">Strength goals</h3><div class="block">${Object.keys(E.STRENGTH_GOALS).map((id) => {
      const best = E.STRENGTH_BESTS[id];
      const goal = E.STRENGTH_GOALS[id];
      let bestE = E.e1rm(best.w, best.r);
      E.exerciseHistory(state, id).rows.forEach((row) => row.sets.forEach((s) => {
        bestE = Math.max(bestE, E.e1rm(Number(s.w) || 0, s.r));
      }));
      const startE = E.e1rm(best.w, best.r);
      const febE = E.e1rm(goal.feb.w, goal.feb.r);
      const goalE = E.e1rm(goal.jun.w, goal.jun.r);
      const pct = Math.max(0, Math.min(100, ((bestE - startE) / (goalE - startE)) * 100));
      return `<div class="macro"><div class="macro-top"><b>${esc(best.name)}</b><span>${Math.round(bestE)} <small>lb est. 1RM</small></span></div>
        <div class="bar"><i style="width:${pct}%;background:var(--good)"></i></div>
        <div class="macro-note">Feb 7 goal ${Math.round(febE)} lb, Jun 13 goal ${Math.round(goalE)} lb, then maintain through race day</div></div>`;
    }).join('')}<p class="tiny" style="margin-top:12px">Estimates use the NSCA %1RM table. The bar shows your progress toward June.</p></div>`;

    html += `<h3 class="sec-title">Check-ins</h3>`;
    if (!cis.length) html += `<div class="block muted small">Your first check-in is Sunday, November 15 at ${E.fmtTime(state.checkinTime)}.</div>`;
    else html += `<div class="block flat">${cis.slice().reverse().map((c) => `<button class="kpi" data-action="open-history" data-w="${c.week}"><span class="kl"><span class="kname">Week ${c.week + 1}, ${E.fmtDate(E.checkinDate(c.week))}</span><br><span class="ksub">${c.changes.length ? esc(c.changes.map((x) => x.title).join('; ')) : 'No changes'}</span></span><span class="kv">${isNum(c.data.weightAvg) ? `${c.data.weightAvg}<small>lb</small>` : ''}</span></button>`).join('')}</div>`;
    return html;
  }

  /* ---------- Sheets ---------- */
  const sheetShell = (title, inner, closeAction) => `<div class="sheet" role="dialog" aria-label="${esc(title)}"><div class="sheet-in"><div class="sheet-top"><h2>${esc(title)}</h2><button class="icon-btn" data-action="${closeAction || 'close-sheet'}" aria-label="Close">${I.close}</button></div>${inner}</div></div>`;

  function sheetMorning() {
    const d = ui.logDate;
    const day = state.days[d] || {};
    const isToday = d === today();
    const canNext = d < today();
    const weigh = [0, 2, 4].includes(E.dayIndex(d));
    const inner = `<div class="weeknav"><button class="icon-btn" data-action="log-date" data-d="-1" aria-label="Previous day">${I.left}</button>
      <div class="mid"><b>${E.DAY_NAMES[E.dayIndex(d)]}, ${E.fmtDate(d)}</b><span>${isToday ? 'Today' : 'Earlier day'}</span></div>
      <button class="icon-btn" data-action="log-date" data-d="1" aria-label="Next day" ${canNext ? '' : 'disabled style="opacity:.25"'}>${I.right}</button></div>
      <div class="block"><div class="formgrid">
        <div><span class="lbl">Sleep</span>${field('data-day="sleep"', 'hours', day.sleep, '8')}</div>
        <div><span class="lbl">Resting heart rate</span>${field('data-day="rhr" inputmode="numeric"', 'bpm', day.rhr, '')}</div>
        <div class="wide"><span class="lbl">Sleep device on last night?</span>${chips('apap', [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }], day.apap === true ? 'yes' : day.apap === false ? 'no' : '', 'even')}</div>
        <div class="wide"><span class="lbl">Soreness, 1 to 10</span>${chips('soreness', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], day.soreness, 'grid10')}</div>
        <div class="wide"><span class="lbl">Morning weight${weigh ? ', a weigh-in day' : ' (optional today)'}</span>${field('data-day="weight"', 'lb', day.weight, '')}<span class="tiny" style="display:block;margin-top:5px">Only your weekly average drives changes, so one number never matters much.</span></div>
      </div></div>
      <button class="btn" data-action="close-sheet">Done</button>`;
    return sheetShell('Morning log', inner);
  }

  function ciStart(week) {
    const t = today();
    const s = E.weekSummary(state, week, t);
    ui.ci = { stage: 'form', error: null, data: { week, weightAvg: s.weightAvg == null ? '' : s.weightAvg, waist: '', sleepAvg: s.sleepAvg == null ? '' : s.sleepAvg, apapNights: s.apapNights == null ? '' : s.apapNights, energy: null, soreness: null, cravings: null, food: week === E.TRAVEL_WEEK ? 'mostly' : null, pain: null, symptoms: null, trackingBackfired: false, notes: '' } };
  }
  function sheetCheckin() {
    const c = ui.ci;
    const week = c.data.week;
    const s = E.weekSummary(state, week, today());
    if (c.stage === 'review') return sheetCheckinReview();
    const travel = week === E.TRAVEL_WEEK;
    const inner = `
      <p class="muted" style="margin:-4px 2px 12px">Week ${week + 1}, ending ${E.fmtDate(E.checkinDate(week))}</p>
      ${travel ? notice('', 'Travel week', 'Nothing changes this week. A quick check on how you feel is all this needs.') : ''}
      ${garminUpload()}
      <p class="tiny" style="margin:6px 2px 0">Optional. Do this first, because anything you've typed below will reset when the import finishes.</p>
      <h3 class="sec-title">What the app counted</h3>
      <div class="block"><div class="autostat">
        <div><b>${s.done}/${s.planned}</b><span>Sessions</span></div>
        <div><b>${s.miles}</b><span>Miles</span></div>
        <div><b>${s.longest}</b><span>Longest run</span></div>
      </div><p class="tiny" style="margin-top:8px">${s.talkLogged ? `Heart-rate target met on ${s.talkLogged - s.talkFails} of ${s.talkLogged} logged runs.` : 'No heart-rate results logged this week.'} Fix anything from the Train tab.</p></div>
      ${travel ? '' : `<h3 class="sec-title">Body</h3><div class="block"><div class="formgrid">
        <div class="wide"><span class="lbl">Average weight${s.weightCount ? `, from ${s.weightCount} weigh-in${s.weightCount === 1 ? '' : 's'}` : ''}</span>${field('data-ci="weightAvg"', 'lb', c.data.weightAvg, '')}</div>
        <div class="wide"><span class="lbl">Waist${E.waistDue(week) ? ', due this week' : ' (optional, due next week)'}</span>${field('data-ci="waist"', 'cm', c.data.waist, '')}</div>
      </div></div>`}
      <h3 class="sec-title">Recovery</h3><div class="block"><div class="formgrid">
        <div><span class="lbl">Average sleep</span>${field('data-ci="sleepAvg"', 'hours', c.data.sleepAvg, '')}</div>
        <div><span class="lbl">Sleep-device nights</span>${field('data-ci="apapNights" inputmode="numeric"', 'of 7', c.data.apapNights, '')}</div>
        <div class="wide"><span class="lbl">Energy, 1 to 10</span>${chips('ci-energy', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], c.data.energy, 'grid10')}</div>
        <div class="wide"><span class="lbl">Soreness, 1 to 10</span>${chips('ci-soreness', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], c.data.soreness, 'grid10')}</div>
        <div class="wide"><span class="lbl">Cravings, 1 to 10</span>${chips('ci-cravings', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], c.data.cravings, 'grid10')}</div>
      </div></div>
      ${travel ? '' : `<h3 class="sec-title">Nutrition</h3><div class="block">
        <div class="q"><span class="lbl">How closely did you follow the meal plan?</span>${chips('ci-food', [{ v: 'mostly', l: 'Mostly' }, { v: 'some', l: 'Some' }, { v: 'little', l: 'A little' }], c.data.food, 'even')}</div>
        <div class="q"><span class="lbl">Did tracking cause guilt, skipped meals, or extra exercise?</span>${chips('ci-backfire', [{ v: 'no', l: 'No' }, { v: 'yes', l: 'Yes' }], c.data.trackingBackfired ? 'yes' : 'no', 'even')}</div>
      </div>`}
      <h3 class="sec-title">Pain and health</h3><div class="block">
        <div class="q"><span class="lbl">Any pain that lingered or changed how you moved?</span>${chips('ci-pain', [{ v: 'no', l: 'No' }, { v: 'yes', l: 'Yes' }], c.data.pain === null ? '' : c.data.pain ? 'yes' : 'no', 'even')}</div>
        <div class="q"><span class="lbl">Any chest pain, fainting, or unusual shortness of breath?</span>${chips('ci-symptoms', [{ v: 'no', l: 'No' }, { v: 'yes', l: 'Yes' }], c.data.symptoms === null ? '' : c.data.symptoms ? 'yes' : 'no', 'even')}</div>
        <div class="q"><span class="lbl">Anything that made this week hard? (optional)</span><textarea data-ci="notes" aria-label="Notes">${esc(c.data.notes)}</textarea></div>
      </div>
      ${c.error ? `<p class="err">${esc(c.error)}</p>` : ''}
      <button class="btn" data-action="ci-review">Review changes</button>`;
    return sheetShell('Weekly check-in', inner);
  }
  function changesBlock(rec) {
    let html = '';
    rec.alerts.forEach((a) => { html += notice(a.level === 'critical' ? 'crit' : 'warn', a.title, a.text); });
    if (rec.changes.length) html += `<div class="block">${rec.changes.map((c) => `<div class="change"><b>${esc(c.title)}</b><span>${esc(c.detail)}</span></div>`).join('')}</div>`;
    rec.notes.forEach((n) => { html += notice('', rec.changes.length ? 'Also' : 'Targets', n); });
    if (rec.liftChanges && rec.liftChanges.length) {
      html += `<h3 class="sec-title">Lift targets changed this week</h3><div class="block">${rec.liftChanges.map((l) => `<div class="bump"><span>${esc(l.name)}</span><b class="${l.up ? 'up' : 'down'}">${esc(l.from)} to ${esc(l.to)}</b></div>`).join('')}</div>`;
    }
    if (rec.easyPace) html += `<div class="block flat"><div class="kpi"><span class="kname">Easy pace goal</span><span class="kv">${esc(rec.easyPace)}</span></div></div>`;
    return html;
  }
  function aiReviewBlock(rec, live) {
    const flagged = rec.data.symptoms || E.detectRedFlags(rec.data.notes);
    if (flagged && !rec.ai) return E.detectRedFlags(rec.data.notes) && !rec.data.symptoms ? notice('crit', 'Stop training and get checked', CARE_TEXT) : '';
    const r = rec.ai;
    if (!r) {
      if (!aiReady()) return '';
      const st = ui.ciAi || {};
      return `<h3 class="sec-title">AI review</h3>${st.error ? `<p class="err">${esc(st.error)}</p>` : ''}<button class="btn alt aibtn" data-action="ci-ai-review" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Reading your week...' : 'Get an AI review of this week'}</button><div style="height:12px"></div>`;
    }
    const list = (title, items) => (items.length ? `<div class="ai-sec"><b>${title}</b><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    let html = '<h3 class="sec-title">AI review</h3>';
    if (r.stopForCare) html += notice('crit', 'Please check in with someone first', `${r.headline || ''} No changes were proposed.`.trim());
    else html += `<div class="block ai"><p class="ai-head">${esc(r.headline)}</p>${list('What went well', r.went)}${list('Watch for', r.watch)}${list('Try this', r.suggestions)}</div>`;
    if (E.aiHasProposal(r) && !rec.aiApplied && !rec.aiDeclined) {
      html += `<div class="block ai"><div class="ai-sec"><b>Proposed changes</b><ul>
        ${r.calorie ? `<li>Daily calories: ${fmtN(r.calorie.to - r.calorie.delta)} to ${fmtN(r.calorie.to)}</li>` : ''}
        ${r.deload ? '<li>Make next week a deload</li>' : ''}
        ${r.lifts.map((l) => `<li>${esc(l.name)}: ${esc(l.fromText)} to ${esc(l.toText)}${l.reason ? `. ${esc(l.reason)}` : ''}</li>`).join('')}
      </ul>${r.reason ? `<p class="muted small" style="margin-top:6px">${esc(r.reason)}</p>` : ''}</div>
      <button class="btn" data-action="ci-ai-apply" data-live="${live ? 1 : 0}">Approve these changes</button>
      <button class="btn alt" data-action="ci-ai-decline" data-live="${live ? 1 : 0}">Keep the plan as it is</button></div>`;
    } else if (rec.aiApplied) html += notice('good', 'Changes approved', 'They\'re included in your check-in. Undo your check-in in Settings to reverse them.');
    if (r.rejected.length && !r.stopForCare) html += `<p class="tiny" style="margin:0 2px 12px">The app blocked ${r.rejected.length === 1 ? 'one idea' : `${r.rejected.length} ideas`} that went past your plan's limits: ${esc(r.rejected.map((x) => `${x.what} (${x.why})`).join(' '))}</p>`;
    return html;
  }
  function sheetCheckinReview() {
    const rec = ui.ci.rec;
    const m = E.macros(rec.after);
    const portions = rec.after.mode === 'portions';
    const week = rec.week;
    const inner = `${changesBlock(rec)}
      ${aiReviewBlock(rec, true)}
      ${portions ? '' : `<h3 class="sec-title">Your targets next week</h3><div class="block"><div class="autostat">
        <div><b>${fmtN(rec.after.calories)}</b><span>Calories</span></div>
        <div><b>${m.proLo}-${m.proHi}</b><span>Protein, g</span></div>
        <div><b>${m.carbLo}-${m.carbHi}</b><span>Carbs, g</span></div>
      </div></div>`}
      <button class="btn" data-action="ci-apply">Apply and finish</button>
      <button class="btn alt" data-action="ci-back">Go back and edit</button>
      <p class="tiny" style="margin-top:10px">Week ${week + 1}. You can undo your latest check-in in Settings.</p>`;
    return sheetShell('Your check-in result', inner);
  }
  function sheetHistory() {
    const c = state.checkins.find((x) => x.week === ui.historyWeek);
    if (!c) return '';
    const d = c.data;
    const isLatest = state.checkins.every((x) => x.week <= c.week);
    const inner = `<p class="muted" style="margin:-4px 2px 12px">Week ${c.week + 1}, completed ${E.fmtDate(c.date)}</p>
      ${changesBlock(c)}
      ${c.ai || isLatest ? aiReviewBlock(c, false) : ''}
      <div class="block flat">
        <div class="kpi"><span class="kname">Average weight</span><span class="kv">${isNum(d.weightAvg) ? `${d.weightAvg}<small>lb</small>` : '--'}</span></div>
        <div class="kpi"><span class="kname">Waist</span><span class="kv">${isNum(d.waist) ? `${d.waist}<small>cm</small>` : '--'}</span></div>
        <div class="kpi"><span class="kname">Sessions</span><span class="kv">${c.summary.done}/${c.summary.planned}</span></div>
        <div class="kpi"><span class="kname">Miles</span><span class="kv">${c.summary.miles}</span></div>
        <div class="kpi"><span class="kname">Average sleep</span><span class="kv">${isNum(d.sleepAvg) ? `${d.sleepAvg}<small>h</small>` : '--'}</span></div>
        <div class="kpi"><span class="kname">Energy, soreness, cravings</span><span class="kv">${d.energy}, ${d.soreness}, ${d.cravings}</span></div>
      </div>
      ${d.notes ? `<div class="block small">${esc(d.notes)}</div>` : ''}
      <button class="btn alt" data-action="copy-checkin" data-w="${c.week}">Copy summary to send Claude</button>`;
    return sheetShell('Check-in', inner);
  }
  function sheetSummary() {
    const s = ui.summary;
    const inner = `${s.lines.length ? `<div class="block">${s.lines.map((l) => `<div class="bump"><span>${esc(l.name)}</span><b class="${l.cls || ''}">${esc(l.value)}</b></div>`).join('')}</div>` : ''}
      ${s.note ? `<p class="muted" style="margin:0 2px 14px">${esc(s.note)}</p>` : ''}
      <button class="btn" data-action="close-sheet">Done</button>`;
    return sheetShell(s.title, inner);
  }
  const FOOD_UNITS = ['g', 'oz', 'cup', 'tbsp', 'serving'];
  function sheetFood() {
    const d = ui.foodDraft;
    const saved = Object.keys(state.foods).map((k) => Object.assign({ key: k }, state.foods[k])).sort((x, y) => (x.used < y.used ? 1 : x.used > y.used ? -1 : x.name.localeCompare(y.name)));
    const showList = saved.length && !d.base && !d.id;
    const inner = `<div class="block"><span class="lbl">Food</span><input class="inp" type="text" data-food="name" autocomplete="off" aria-label="Food name" placeholder="Chicken breast" value="${esc(d.name)}">
        ${showList ? `<div class="savedfoods"><span class="tiny">Your foods</span>${saved.slice(0, 40).map((f) => `<button class="savedfood" data-action="food-pick" data-id="${esc(f.key)}" data-name="${esc(f.name.toLowerCase())}"><span>${esc(f.name)}</span><span class="muted">${esc(f.amount)} ${esc(f.unit)}, ${fmtN(Math.round(f.cal))} cal</span></button>`).join('')}</div>` : ''}
      </div>
      <div class="block"><div class="q"><span class="lbl">Amount</span>${field('data-food="amount"', d.unit, d.amount, '')}</div>
        <div class="q">${chips('food-unit', FOOD_UNITS, d.unit, 'even')}</div>
        ${d.base ? `<p class="tiny">Saved as ${esc(d.base.amount)} ${esc(d.base.unit)}. Change the amount and the numbers below update.</p>` : ''}</div>
      <div class="block"><div class="formgrid">
        <div class="wide"><span class="lbl">Calories</span>${field('data-food="cal" inputmode="numeric"', 'cal', d.cal, 'Figured from macros if blank')}</div>
        <div><span class="lbl">Protein</span>${field('data-food="p"', 'g', d.p, '0')}</div>
        <div><span class="lbl">Carbs</span>${field('data-food="c"', 'g', d.c, '0')}</div>
        <div><span class="lbl">Fat</span>${field('data-food="f"', 'g', d.f, '0')}</div>
      </div></div>
      ${d.error ? `<p class="err">${esc(d.error)}</p>` : ''}
      <button class="btn" data-action="food-save">${d.id ? 'Update food' : 'Add to log'}</button>
      ${d.id ? '<button class="btn alt" data-action="food-delete">Remove from log</button>' : ''}`;
    return sheetShell(d.id ? 'Edit food' : 'Add food', inner);
  }
  function sheetLiftChart() {
    return sheetShell(E.EX[ui.chartId].name, `<div class="block">${liftChartHtml(ui.chartId, 's')}</div><button class="btn" data-action="close-sheet">Done</button>`);
  }
  function foodDay(date) {
    state.food[date] = state.food[date] || { meals: {} };
    state.food[date].meals = state.food[date].meals || {};
    state.food[date].items = state.food[date].items || [];
    return state.food[date];
  }
  function saveFood() {
    const d = ui.foodDraft;
    const name = String(d.name || '').trim();
    const nums = ['amount', 'cal', 'p', 'c', 'f'];
    if (!name) { d.error = 'Enter a food name.'; return renderSheet(); }
    if (!isNum(d.amount) || Number(d.amount) <= 0) { d.error = 'Enter how much you ate.'; return renderSheet(); }
    for (const k of nums) {
      if (d[k] !== '' && d[k] != null && (!isNum(d[k]) || Number(d[k]) < 0)) { d.error = 'Calories and macros must be numbers.'; return renderSheet(); }
    }
    const hasMacros = [d.p, d.c, d.f].some((v) => isNum(v) && Number(v) > 0);
    if (!isNum(d.cal) && !hasMacros) { d.error = 'Enter calories or at least one macro.'; return renderSheet(); }
    const item = {
      id: d.id || `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      name,
      amount: Number(d.amount),
      unit: d.unit,
      cal: isNum(d.cal) ? Number(d.cal) : E.caloriesFromMacros(d.p, d.c, d.f),
      p: isNum(d.p) ? Number(d.p) : 0,
      c: isNum(d.c) ? Number(d.c) : 0,
      f: isNum(d.f) ? Number(d.f) : 0
    };
    const day = foodDay(ui.fuelDate);
    const at = day.items.findIndex((x) => x.id === item.id);
    if (at >= 0) day.items[at] = item;
    else day.items.push(item);
    state.foods[name.toLowerCase()] = { name, amount: item.amount, unit: item.unit, cal: item.cal, p: item.p, c: item.c, f: item.f, used: today() };
    save();
    ui.foodDraft = null;
    ui.sheet = null;
    toast(`${name} logged`);
    render();
  }

  function loadGarminFile(file) {
    file.text().then((txt) => {
      const parsed = E.parseGarminCsv(txt);
      if (parsed.error) {
        ui.garmin = { error: parsed.error, columns: parsed.columns };
      } else {
        ui.garmin = { parsed, unit: parsed.unit, items: E.planGarminImport(state, parsed.activities, parsed.unit, today()), error: null, applyError: null };
      }
      ui.sheet = 'garmin';
      renderSheet();
      const sheet = $('.sheet');
      if (sheet) sheet.scrollTop = 0;
    }).catch(() => {
      ui.garmin = { error: 'That file couldn\'t be read. Choose the CSV you exported from Garmin Connect.' };
      ui.sheet = 'garmin';
      renderSheet();
    });
  }
  function sheetGarmin() {
    const g = ui.garmin;
    if (g.error) {
      return sheetShell('Garmin import', `${notice('crit', 'That file didn\'t import', g.error)}
        <div class="block small muted">On the Garmin Connect website, open Activities, scroll until the dates you want are loaded, then click Export CSV. Nothing in the app changed.</div>
        ${g.columns ? `<details class="more"><summary>Columns in your file</summary><div class="inner small muted">${esc(g.columns.join(', '))}</div></details>` : ''}
        ${garminUpload()}<button class="btn alt" style="margin-top:9px" data-action="close-sheet">Close</button>`);
    }
    const items = g.items;
    const count = (st) => items.filter((x) => x.status === st).length;
    const matched = count('match');
    const extras = count('extra');
    const baseline = items.filter((x) => x.status === 'baseline');
    const dups = count('dup');
    const manual = count('manual');
    const walks = count('walk');
    const addons = count('addon');
    const other = count('other');
    const usable = matched + extras + baseline.length + walks + addons;
    const nameDay = (d) => `${E.DAY_SHORT[E.dayIndex(d)]}, ${E.fmtDate(d)}`;
    const detail = (x) => {
      const a = x.activity;
      const parts = [];
      if (x.distance) parts.push(`${x.distance} mi`);
      parts.push(E.fmtDur(a.seconds));
      if (a.hr) parts.push(`${Math.round(a.hr)} bpm`);
      return parts.join(', ');
    };
    const cards = items.map((x, i) => {
      if (x.status !== 'match' && x.status !== 'extra') return '';
      const a = x.activity;
      const moved = x.sessionDate && x.sessionDate !== a.date;
      let html = `<div class="gi"><div class="gi-top"><div><b>${esc(nameDay(a.date))}: ${esc(a.typeRaw || a.name)}</b><span>${esc(detail(x))}</span></div></div>
        <div class="gi-to">${x.status === 'extra' ? 'Counts toward your miles as an extra run' : `Fills ${esc(x.title)}${moved ? `, planned for ${esc(nameDay(x.sessionDate))}` : ''}`}</div>`;
      if (a.kind !== 'lift') {
        const pre = E.weekOf(a.date) < 0;
        const facts = [x.talk === 'pass' ? 'Heart-rate target met' : x.talk === 'fail' ? 'Heart-rate target missed' : 'Heart-rate answer needed'];
        if (a.kind === 'run' && x.status === 'match' && !pre) facts.push(x.completed ? 'finished' : 'not finished');
        if (a.kind === 'run' && x.hard) facts.push('hard effort');
        const attention = x.open || !x.talk || (!pre && (x.talk === 'fail' || (a.kind === 'run' && x.status === 'match' && !x.completed)));
        html += `<div class="gi-facts">${esc(facts.join(', '))}${a.hr ? `, from ${Math.round(a.hr)} bpm` : ''}</div>`;
        html += `<details class="numbers" ${attention ? 'open' : ''}><summary>${attention ? 'Check this' : 'Change'}</summary>`;
        html += `<div class="q"><span class="lbl">Did you stay on your heart-rate target?</span>${chips(`gi:${i}:talk`, [{ v: 'pass', l: 'Yes' }, { v: 'fail', l: 'No' }], x.talk || '', 'even')}</div>`;
        if (a.kind === 'run' && x.status === 'match' && !pre) html += `<div class="q"><span class="lbl">Did you finish the session?</span>${chips(`gi:${i}:completed`, [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }], x.completed ? 'yes' : 'no', 'even')}</div>`;
        if (a.kind === 'run') html += `<div class="q" style="margin-bottom:0"><span class="lbl">Was this a hard, all-out effort?</span>${chips(`gi:${i}:hard`, [{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }], x.hard ? 'yes' : 'no', 'even')}</div>`;
        html += '</details>';
      }
      return `${html}</div>`;
    }).join('');
    const baseMiles = baseline.reduce((acc, x) => acc + x.distance, 0);
    const inner = `<div class="block"><div class="autostat">
        <div><b>${matched}</b><span>Sessions to fill</span></div>
        <div><b>${extras + baseline.length}</b><span>Extra or past runs</span></div>
        <div><b>${dups + manual}</b><span>Already logged</span></div>
      </div>
      <div class="q" style="margin:12px 0 0"><span class="lbl">Distance in this file is in</span>${chips('gi-unit', [{ v: 'mi', l: 'Miles' }, { v: 'km', l: 'Kilometers' }], g.unit, 'even')}</div></div>
      ${baseline.length ? notice('', 'Your running history', `${baseline.length} runs and ${Math.round(baseMiles)} miles from before this week. These set your starting pace and your baseline.`) : ''}
      ${g.parsed.unreadable ? notice('warn', `${g.parsed.unreadable} row${g.parsed.unreadable === 1 ? '' : 's'} couldn't be read`, 'Those rows will be skipped. Everything else below is fine.') : ''}
      ${cards}
      ${addons ? `<p class="tiny" style="margin:0 2px 10px">${addons} afternoon cardio session${addons === 1 ? '' : 's'} will be checked off.</p>` : ''}
      ${walks ? `<p class="tiny" style="margin:0 2px 10px">${walks} Sunday walk${walks === 1 ? '' : 's'} will be checked off.</p>` : ''}
      ${other ? `<p class="tiny" style="margin:0 2px 10px">${other} other activit${other === 1 ? 'y' : 'ies'}, like golf or older gym sessions, won't change your plan.</p>` : ''}
      ${g.applyError ? `<p class="err">${esc(g.applyError)}</p>` : ''}
      ${usable ? `<button class="btn" data-action="garmin-apply">Import ${usable} activit${usable === 1 ? 'y' : 'ies'}</button>` : notice('', 'Nothing new to import', 'Everything in this file is already in the app or doesn\'t affect your plan.')}
      <button class="btn alt" style="margin-top:9px" data-action="close-sheet">${usable ? 'Cancel' : 'Close'}</button>`;
    return sheetShell('Review your import', inner);
  }

  function aiSession(id) {
    const m = /^w(-?\d+)d(\d)(b?)$/.exec(id);
    const day = weekFor(Number(m[1])).days[Number(m[2])];
    return m[3] ? day.second : day;
  }
  function sheetAiAdjust() {
    const a = ui.ai;
    const s = aiSession(a.id);
    let inner = '';
    if (a.stage === 'care') inner = notice('crit', 'Stop training and get checked', CARE_TEXT);
    else if (a.stage === 'result') {
      const c = a.checked;
      if (c.stopForCare) inner = notice('crit', 'Stop here for today', `${c.advice || c.reason || 'Please get checked before you train again.'} Nothing in your plan changed.`);
      else {
        inner = `<div class="block ai"><p class="ai-head">${esc(c.advice)}</p>${c.reason ? `<p class="muted small">${esc(c.reason)}</p>` : ''}</div>`;
        if (c.lines.length) inner += `<h3 class="sec-title">Proposed for this session</h3><div class="block">${c.lines.map((l) => `<div class="bump"><span>${esc(l.name)}${l.note ? `<small>${esc(l.note)}</small>` : ''}</span><b>${esc(l.value)}</b></div>`).join('')}</div>`;
        if (c.rejected.length) inner += `<p class="tiny" style="margin:0 2px 12px">The app blocked ${c.rejected.length === 1 ? 'one idea' : `${c.rejected.length} ideas`} that went past your plan's limits: ${esc(c.rejected.map((x) => `${x.what} (${x.why})`).join(' '))}</p>`;
        if (c.lines.length) inner += '<button class="btn" data-action="ai-adjust-apply">Use these changes</button><button class="btn alt" data-action="close-sheet">Keep the original session</button><p class="tiny" style="margin-top:10px">Your long-term targets and 2-for-2 streak stay put for anything you change today.</p>';
        else inner += '<button class="btn" data-action="close-sheet">Keep the session as planned</button>';
        inner += '<button class="link small" style="margin-top:6px" data-action="ai-adjust-edit">Change my note and ask again</button>';
      }
    } else {
      inner = `<p class="muted" style="margin:-4px 2px 12px">${esc(s.title)}, ${esc(E.fmtDate(s.date))}</p>
        <div class="block">
          <div class="q"><span class="lbl">How long do you have?</span>${chips('ai-min', [{ v: 'full', l: 'Full' }, { v: 60, l: '60' }, { v: 45, l: '45' }, { v: 30, l: '30' }], a.minutes, 'even')}</div>
          <div class="q"><span class="lbl">Energy</span>${chips('ai-energy', ['Low', 'OK', 'Great'], a.energy, 'even')}</div>
          <div class="q"><span class="lbl">Soreness</span>${chips('ai-sore', ['None', 'Some', 'A lot'], a.soreness, 'even')}</div>
          <div class="q" style="margin-bottom:0"><span class="lbl">Anything else?</span><textarea data-ai="message" maxlength="600" placeholder="For example: my right shoulder is sore, or the leg press is taken" aria-label="Anything else about today">${esc(a.message)}</textarea></div>
        </div>
        ${a.error ? `<p class="err">${esc(a.error)}</p>` : ''}
        <button class="btn" data-action="ai-adjust-send" ${a.stage === 'loading' ? 'disabled' : ''}>${a.stage === 'loading' ? 'Reading your session...' : 'Ask for changes'}</button>
        <p class="tiny" style="margin-top:10px">You'll see any changes before they apply. This sends today's session, your recent results for it, this morning's numbers, and your note to your AI server and Claude.</p>`;
    }
    return sheetShell('Adjust this session', inner);
  }
  function sheetAiExplain() {
    const x = ui.aiExp;
    const d = state.aiExplanations[x.key];
    let inner = '';
    if (x.loading) inner = '<div class="block"><p class="muted">Writing your explanation...</p></div>';
    if (x.error) inner += `<p class="err">${esc(x.error)}</p>`;
    if (d) {
      const list = (title, items, tag) => (items.length ? `<h3 class="sec-title">${title}</h3><div class="block ai"><${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}></div>` : '');
      inner += `<h3 class="sec-title">Why it's in your plan</h3><div class="block ai"><p>${esc(d.data.why_in_plan)}</p></div>
        ${list('Set up', d.data.setup, 'ol')}${list('Focus on', d.data.cues, 'ul')}${list('Avoid', d.data.common_mistakes, 'ul')}
        ${d.data.feel ? `<h3 class="sec-title">What you should feel</h3><div class="block ai"><p>${esc(d.data.feel)}</p></div>` : ''}
        <p class="tiny" style="margin:0 2px">General coaching, not medical advice. Stop if something hurts.</p>
        <button class="link small" data-action="ai-explain-refresh" ${x.loading ? 'disabled' : ''}>Write a fresh explanation</button>`;
    }
    return sheetShell(x.title, inner);
  }
  async function aiExplainFetch() {
    const x = ui.aiExp;
    const s = aiSession(x.sessionId);
    const wk = weekFor(s.w);
    const req = ++aiRequest;
    x.loading = true;
    x.error = null;
    renderSheet();
    try {
      const out = await aiCall('explain', E.aiExplainContext(state, s, x.exId || null, wk.deload || wk.travel));
      if (req !== aiRequest || ui.aiExp !== x) return;
      const data = E.validateAiExplanation(out.result);
      if (!data) throw new Error('bad_reply');
      state.aiExplanations[x.key] = { at: today(), data };
      save();
    } catch (err) {
      if (req !== aiRequest || ui.aiExp !== x) return;
      x.error = aiErrorText(err.message);
    }
    x.loading = false;
    renderSheet();
  }
  async function aiAdjustSend() {
    const a = ui.ai;
    const s = aiSession(a.id);
    const wk = weekFor(s.w);
    if (E.detectRedFlags(a.message)) { a.stage = 'care'; renderSheet(); return; }
    const deload = wk.deload || wk.travel;
    const req = ++aiRequest;
    a.stage = 'loading';
    a.error = null;
    renderSheet();
    const input = { minutes: a.minutes === 'full' ? null : Number(a.minutes), energy: a.energy, soreness: a.soreness };
    try {
      const out = await aiCall('adjust', E.aiAdjustContext(state, s, today(), input, deload), a.message);
      if (req !== aiRequest || ui.ai !== a) return;
      const checked = E.validateAiAdjustment(state, s, out.result, deload);
      if (!checked.ok) throw new Error('bad_reply');
      a.checked = checked;
      a.stage = 'result';
    } catch (err) {
      if (req !== aiRequest || ui.ai !== a) return;
      a.stage = 'form';
      a.error = aiErrorText(err.message);
    }
    renderSheet();
    const sh = $('.sheet');
    if (sh) sh.scrollTop = 0;
  }
  async function ciAiReview(rec) {
    const st = { loading: true, error: null };
    ui.ciAi = st;
    const req = ++aiRequest;
    renderSheet();
    try {
      const out = await aiCall('checkin', E.aiCheckinContext(state, rec, today()), rec.data.notes || '');
      if (req !== aiRequest || ui.ciAi !== st) return;
      const review = E.validateAiCheckin(state, rec, out.result);
      if (!review.ok) throw new Error('bad_reply');
      rec.ai = review;
      ui.ciAi = null;
      save();
    } catch (err) {
      if (req !== aiRequest || ui.ciAi !== st) return;
      st.loading = false;
      st.error = aiErrorText(err.message);
    }
    renderSheet();
  }
  function aiCode() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function aiSettingsBlock() {
    const on = aiCfg.enabled;
    const t = ui.aiTest;
    return `<h3 class="sec-title">AI coach</h3><div class="block">
      <p class="muted small" style="margin-bottom:12px">It explains exercises, proposes day-of changes, and reviews your check-ins, only when you tap. Each request sends what that question needs, such as the session, recent results, check-in answers, and your note, through your server to Claude. Your full logs stay on this phone. Anything that changes your plan needs your approval.</p>
      <div class="q"><span class="lbl">AI coach</span>${chips('ai-on', [{ v: 'off', l: 'Off' }, { v: 'on', l: 'On' }], on ? 'on' : 'off', 'even')}</div>
      ${on ? `<div class="q"><span class="lbl">Server address</span><input class="inp" data-aicfg="url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://your-worker.workers.dev" value="${esc(aiCfg.url)}" aria-label="Server address"></div>
      <div class="q"><span class="lbl">Access code</span><input class="inp" data-aicfg="token" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(aiCfg.token)}" aria-label="Access code">
        <div class="chips even" style="margin-top:8px"><button class="chip" data-action="ai-code">Create a code</button><button class="chip" data-action="ai-copy" ${aiCfg.token ? '' : 'disabled'}>Copy code</button></div></div>
      <button class="btn alt" data-action="ai-test" ${t && t.loading ? 'disabled' : ''}>${t && t.loading ? 'Testing...' : 'Test connection'}</button>
      ${t && t.ok ? '<p class="ok-msg">Connected. Your server and access code are working.</p>' : ''}${t && t.error ? `<p class="err">${esc(t.error)}</p>` : ''}` : ''}
    </div>`;
  }

  function sheetSettings() {
    const tg = state.targets;
    const timeRow = (i, label) => `<div class="kpi" style="padding:9px 0"><span class="kname">${label}</span><input class="inp" style="width:136px" type="time" data-time="${i}" value="${state.times[i] || ''}" aria-label="${label} time"></div>`;
    const last = state.checkins.slice().sort((a, b) => b.week - a.week)[0];
    const inner = `<h3 class="sec-title">Training times</h3><div class="block" style="padding-top:5px;padding-bottom:5px">
        ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => timeRow(i, d)).join('')}
        <div class="kpi" style="padding:9px 0"><span class="kname">Afternoon session</span><input class="inp" style="width:136px" type="time" data-time="pm" value="${state.pmTime || '16:00'}" aria-label="Afternoon session time"></div>
        <div class="kpi" style="padding:9px 0"><span class="kname">Sunday check-in</span><input class="inp" style="width:136px" type="time" data-time="checkin" value="${state.checkinTime}" aria-label="Check-in time"></div>
      </div>
      <h3 class="sec-title">Nutrition</h3><div class="block">
        <div class="q"><span class="lbl">How you follow the plan</span>${chips('mode', [{ v: 'track', l: 'Track and weigh' }, { v: 'portions', l: 'Portion guides' }], tg.mode, 'even')}</div>
        <div class="q"><span class="lbl">Daily calories, if you want to set them yourself</span>${field('data-target="calories" inputmode="numeric"', 'cal', tg.calories, '')}<span class="tiny" style="display:block;margin-top:5px">Your next check-in starts from this number. The app won't go below ${fmtN(E.CALORIE_FLOOR)} on its own.</span></div>
        <div class="q"><span class="lbl">Extra daily walk</span>${chips('walk', [{ v: 0, l: 'None' }, { v: 20, l: '20 minutes' }], tg.walkMin, 'even')}</div>
      </div>
      ${aiSettingsBlock()}
      <h3 class="sec-title">Your data</h3><div class="block">
        <p class="muted small" style="margin-bottom:12px">Your logs stay on this phone, not on GitHub. Export a backup every few weeks so you can restore them if you ever reinstall.</p>
        <button class="btn alt" data-action="export-backup">Export backup</button>
        <label class="btn alt" style="margin-top:9px">Restore from backup<input type="file" accept="application/json,.json" class="vh" data-action-change="import-backup"></label>
        <div style="margin-top:9px">${garminUpload()}</div>
        ${state.lastImport ? `<button class="btn ${ui.confirmUndoGarmin ? 'danger' : 'alt'}" style="margin-top:9px" data-action="undo-garmin">${ui.confirmUndoGarmin ? 'Tap again to undo the import' : 'Undo last Garmin import'}</button>` : ''}
        ${ui.importError ? `<p class="err">${esc(ui.importError)}</p>` : ''}
      </div>
      ${last ? `<h3 class="sec-title">Latest check-in</h3><div class="block"><p class="muted small" style="margin-bottom:10px">Week ${last.week + 1}. Undoing restores the targets you had before it. Lift goals and pace are not affected.</p><button class="btn ${ui.confirmUndo ? 'danger' : 'alt'}" data-action="undo-checkin">${ui.confirmUndo ? 'Tap again to undo' : 'Undo this check-in'}</button></div>` : ''}
      <h3 class="sec-title">Start over</h3><div class="block"><button class="btn danger" data-action="reset">${ui.confirmReset ? 'Tap again to erase everything' : 'Erase all my data'}</button></div>
      <p class="tiny" style="margin:10px 2px">Readiness is your own estimate from sleep, resting heart rate, and soreness. It isn't medical advice.</p>`;
    return sheetShell('Settings', inner);
  }

  /* ---------- Render ---------- */
  const NAV = [
    ['home', 'Home', I.home], ['train', 'Train', I.train], ['schedule', 'Schedule', I.sched], ['fuel', 'Fuel', I.fuel], ['progress', 'Progress', I.prog]
  ];
  let lastTab = null;
  function render() {
    const view = $('#view');
    const scroll = window.scrollY;
    const tabChanged = lastTab !== ui.tab;
    lastTab = ui.tab;
    const r = { home: renderHome, train: renderTrain, schedule: renderSchedule, fuel: renderFuel, progress: renderProgress }[ui.tab];
    view.innerHTML = r();
    $('#nav').innerHTML = NAV.map(([k, l, icon]) => `<button class="${k === ui.tab ? 'on' : ''}" data-action="tab" data-tab="${k}" aria-current="${k === ui.tab ? 'page' : 'false'}">${icon}<span>${l}</span></button>`).join('');
    renderSheet();
    if (tabChanged) window.scrollTo(0, 0);
    else window.scrollTo(0, scroll);
    const on = $('.daytab.on');
    if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
    if (tabChanged) window.scrollTo(0, 0);
  }
  function renderSheet() {
    const host = $('#sheet');
    const old = $('.sheet', host);
    const top = old ? old.scrollTop : 0;
    const name = ui.sheet;
    const had = host.dataset.name;
    let html = '';
    if (name === 'morning') html = sheetMorning();
    else if (name === 'checkin') html = sheetCheckin();
    else if (name === 'settings') html = sheetSettings();
    else if (name === 'history') html = sheetHistory();
    else if (name === 'summary') html = sheetSummary();
    else if (name === 'food') html = sheetFood();
    else if (name === 'garmin') html = sheetGarmin();
    else if (name === 'liftchart') html = sheetLiftChart();
    else if (name === 'aiadjust') html = sheetAiAdjust();
    else if (name === 'aiexplain') html = sheetAiExplain();
    host.innerHTML = html;
    host.dataset.name = name || '';
    document.body.style.overflow = name ? 'hidden' : '';
    const fresh = $('.sheet', host);
    if (fresh && had === name) {
      fresh.style.animation = 'none';
      fresh.scrollTop = top;
    }
  }
  let toastTimer;
  function toast(msg) {
    $('#toast').innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').innerHTML = ''; }, 2600);
  }

  /* ---------- Actions ---------- */
  function setDay(field2, value) {
    state.days[ui.logDate] = state.days[ui.logDate] || {};
    state.days[ui.logDate][field2] = value;
    save();
  }
  function saveLift(id) {
    const m = /^w(-?\d+)d(\d)$/.exec(id);
    const w = Number(m[1]);
    const d = Number(m[2]);
    const wk = weekFor(w);
    const s = wk.days[d];
    const draft = state.drafts[id] || { exercises: {} };
    const before = E.liftState(state);
    const exercises = {};
    let any = false;
    E.sessionExercises(s).forEach((ex) => {
      const spec = E.EX[ex];
      const entry = draft.exercises[ex];
      if (!entry) return;
      let carry = E.sessionTarget(before, s, ex);
      const changed = E.exerciseOverride(s, ex);
      const raw = changed ? (entry.sets || []).slice(0, E.sessionPlan(s, ex, wk.deload || wk.travel).sets) : (entry.sets || []);
      const sets = raw.map((set) => {
        if (set.w !== undefined && set.w !== '') carry = set.w;
        return { w: spec.kind === 'time' || spec.kind === 'power' ? null : carry, r: set.r };
      }).filter((set) => isNum(set.r));
      if (!sets.length) return;
      any = true;
      exercises[ex] = changed ? { sets, adjusted: true } : { sets };
    });
    if (!any) {
      ui.error = 'Enter your reps for at least one set, then finish the workout.';
      render();
      return;
    }
    ui.error = null;
    state.logs[id] = { type: 'lift', date: today(), exercises };
    delete state.drafts[id];
    save();
    const after = E.liftState(state);
    const lines = [];
    Object.keys(exercises).forEach((ex) => {
      const spec = E.EX[ex];
      const from = E.targetFor(before, ex, w);
      const to = E.targetFor(after, ex, w);
      if (from !== to) lines.push({ name: spec.name, value: `${E.loadText(spec, from)} to ${E.loadText(spec, to)}`, cls: after[ex].status === 'up' ? 'up' : '' });
    });
    ui.summary = { title: 'Workout saved', lines, note: lines.length ? 'Your next targets updated from this workout.' : 'No target changes yet. Under the 2-for-2 rule, you add weight when your last set beats the rep goal by 2 or more in 2 sessions in a row.' };
    ui.sheet = 'summary';
    render();
  }
  function saveRun(id) {
    const d = state.drafts[id];
    const min = Number(d.min || 0);
    const sec = Number(d.sec || 0);
    const seconds = min * 60 + sec;
    if (!isNum(d.distance) || Number(d.distance) <= 0) return fail('Enter your distance in miles.');
    if (seconds <= 0) return fail('Enter how long the session took.');
    if (!d.talk) return fail('Answer the heart-rate question.');
    const m = /^w(-?\d+)d(\d)b?$/.exec(id);
    const w = Number(m[1]);
    const before = E.runStats(state, today());
    state.logs[id] = { type: 'run', date: today(), distance: Number(d.distance), seconds, hr: isNum(d.hr) ? Number(d.hr) : null, talk: d.talk, completed: d.completed !== false, hard: !!d.hard };
    delete state.drafts[id];
    ui.error = null;
    save();
    const after = E.runStats(state, today());
    const lines = [{ name: 'Your pace', value: `${E.fmtPace(seconds / Number(d.distance))} per mile` }];
    if (Math.round(before.center) !== Math.round(after.center)) lines.push({ name: 'New easy pace goal', value: `${E.fmtPace(after.easyLo)} to ${E.fmtPace(after.easyHi)}`, cls: after.center < before.center ? 'up' : '' });
    if (after.prediction && d.hard) {
      lines.push({ name: 'Half estimate', value: E.fmtDur(after.prediction.half) });
      lines.push({ name: 'Marathon estimate', value: E.fmtDur(after.prediction.marathon) });
    }
    const note = w < 0 ? 'Saved to your running log.' : d.talk === 'fail' || d.completed === false
      ? (w < 5 ? 'That\'s useful information. You\'ll repeat this block next week before moving on, so slow down until your heart rate stays on target.' : 'That\'s useful information. Next week\'s mileage holds steady, and your easy pace goal slows down a little.')
      : 'Your run goals updated.';
    ui.summary = { title: 'Run saved', lines, note };
    ui.sheet = 'summary';
    render();
  }
  function saveCardio(id) {
    const d = state.drafts[id];
    if (!isNum(d.minutes) || Number(d.minutes) <= 0) return fail('Enter how many minutes you did.');
    if (!d.talk) return fail('Answer the heart-rate question.');
    state.logs[id] = { type: 'cardio', date: today(), machine: d.machine, minutes: Number(d.minutes), talk: d.talk };
    delete state.drafts[id];
    ui.error = null;
    save();
    toast('Session saved');
    render();
  }
  function fail(msg) {
    ui.error = msg;
    render();
  }
  function shareFile(name, type, text) {
    const file = new File([text], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function ciValidate(d) {
    const travel = d.week === E.TRAVEL_WEEK;
    const missing = [];
    if (d.energy == null) missing.push('energy');
    if (d.soreness == null) missing.push('soreness');
    if (d.cravings == null) missing.push('cravings');
    if (!travel && !d.food) missing.push('meal plan');
    if (d.pain === null) missing.push('pain');
    if (d.symptoms === null) missing.push('chest pain or fainting');
    return missing;
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (el.disabled) return;
    if (a === 'tab') {
      ui.tab = el.dataset.tab;
      ui.error = null;
      if (ui.tab === 'train') { ui.trainWeek = nowWeek(); ui.trainDay = nowDay(); ui.trainPart = openPart(ui.trainWeek, ui.trainDay); }
      if (ui.tab === 'schedule') ui.schedWeek = schedWeekNow();
      if (ui.tab === 'fuel') ui.fuelDate = today();
      render();
    } else if (a === 'go-schedule') { ui.tab = 'schedule'; ui.schedWeek = schedWeekNow(); render(); }
    else if (a === 'go-progress') { ui.tab = 'progress'; render(); }
    else if (a === 'go-fuel') { ui.tab = 'fuel'; ui.fuelDate = today(); render(); }
    else if (a === 'go-train-today') { ui.tab = 'train'; ui.trainWeek = nowWeek(); ui.trainDay = nowDay(); ui.trainPart = openPart(ui.trainWeek, ui.trainDay); ui.error = null; render(); }
    else if (a === 'go-train-lift') {
      const id = el.dataset.id;
      const wk = weekFor(nowWeek());
      const hit = wk.days.find((s) => s.type === 'lift' && E.sessionExercises(s).includes(id)) || wk.days[0];
      ui.tab = 'train';
      ui.trainWeek = nowWeek();
      ui.trainDay = hit.d;
      ui.trainPart = 'a';
      render();
    } else if (a === 'train-week') { ui.trainWeek = clampWeek(ui.trainWeek + Number(el.dataset.d)); ui.trainPart = openPart(ui.trainWeek, ui.trainDay); ui.error = null; render(); }
    else if (a === 'train-part') { ui.trainPart = el.dataset.part; ui.error = null; render(); }
    else if (a === 'train-day') { ui.trainDay = Number(el.dataset.d); ui.trainPart = openPart(ui.trainWeek, ui.trainDay); ui.error = null; const tabs = $('.daytabs'); const left = tabs ? tabs.scrollLeft : 0; render(); const n = $('.daytabs'); if (n) n.scrollLeft = left; }
    else if (a === 'sched-week') { ui.schedWeek = Math.max(0, clampWeek(ui.schedWeek + Number(el.dataset.d))); render(); }
    else if (a === 'scroll-checkin') { const c = $('#checkin-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (a === 'open-session') { ui.tab = 'train'; ui.trainWeek = Number(el.dataset.w); ui.trainDay = Number(el.dataset.d); ui.trainPart = el.dataset.part || 'a'; ui.error = null; render(); }
    else if (a === 'open-settings') { ui.sheet = 'settings'; ui.confirmReset = false; ui.confirmUndo = false; ui.confirmUndoGarmin = false; ui.importError = null; renderSheet(); }
    else if (a === 'open-morning') { ui.sheet = 'morning'; ui.logDate = today(); renderSheet(); }
    else if (a === 'log-date') {
      const n = E.addDays(ui.logDate, Number(el.dataset.d));
      if (n <= today()) { ui.logDate = n; renderSheet(); }
    } else if (a === 'close-sheet') { aiRequest++; ui.sheet = null; ui.summary = null; ui.ai = null; ui.aiExp = null; render(); }
    else if (a === 'ai-adjust-open') {
      ui.ai = { id: el.dataset.id, minutes: 'full', energy: 'OK', soreness: 'None', message: '', stage: 'form', error: null, checked: null };
      ui.sheet = 'aiadjust';
      renderSheet();
    } else if (a === 'ai-adjust-send') aiAdjustSend();
    else if (a === 'ai-adjust-edit') { ui.ai.stage = 'form'; ui.ai.checked = null; renderSheet(); }
    else if (a === 'ai-adjust-apply') {
      state.sessionOverrides[ui.ai.id] = E.buildOverride(ui.ai.checked, today());
      save();
      ui.ai = null;
      ui.sheet = null;
      toast('Session adjusted');
      render();
    } else if (a === 'ai-override-undo') {
      delete state.sessionOverrides[el.dataset.id];
      save();
      toast('Back to the original session');
      render();
    } else if (a === 'ai-explain') {
      const s = currentTrainSession();
      const id = el.dataset.id;
      const key = id || `run:${s.run.effort || s.run.kind}`;
      ui.aiExp = { key, exId: id, sessionId: s.id, title: id ? E.EX[id].name : s.title, loading: false, error: null };
      ui.sheet = 'aiexplain';
      if (state.aiExplanations[key]) renderSheet();
      else aiExplainFetch();
    } else if (a === 'ai-explain-refresh') aiExplainFetch();
    else if (a === 'ci-ai-review') {
      const rec = ui.sheet === 'history' ? state.checkins.find((x) => x.week === ui.historyWeek) : ui.ci.rec;
      ciAiReview(rec);
    } else if (a === 'ci-ai-apply' || a === 'ci-ai-decline') {
      const live = el.dataset.live === '1';
      const rec = live ? ui.ci.rec : state.checkins.find((x) => x.week === ui.historyWeek);
      if (a === 'ci-ai-decline') rec.aiDeclined = true;
      else {
        E.applyAiCheckin(rec, rec.ai);
        if (!live) {
          state.targets = rec.after;
          state.loadEdits = (state.loadEdits || []).filter((x) => x.week !== rec.week).concat(rec.loadEdits || []);
        }
        toast('Changes approved');
      }
      save();
      renderSheet();
    } else if (a === 'ai-code') {
      aiCfg.token = aiCode();
      saveAi();
      ui.aiTest = null;
      renderSheet();
    } else if (a === 'ai-copy') {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(aiCfg.token).then(() => toast('Access code copied'), () => toast('Copy was blocked. Select the code and copy it instead.'));
      else toast('Select the code and copy it.');
    } else if (a === 'ai-test') {
      const t = { loading: true };
      ui.aiTest = t;
      renderSheet();
      if (!aiUrlOk(aiCfg.url)) { t.loading = false; t.error = 'Enter your server address, starting with https://.'; renderSheet(); return; }
      if (!aiCfg.token) { t.loading = false; t.error = 'Create an access code first.'; renderSheet(); return; }
      aiCall('ping', {}).then((out) => {
        t.loading = false;
        if (out.ok && !out.hasKey) t.error = AI_ERRORS.no_api_key;
        else if (out.ok) t.ok = true;
        else t.error = AI_ERRORS.bad_reply;
      }).catch((err) => {
        t.loading = false;
        t.error = AI_ERRORS[err.message] || 'The test failed.';
      }).then(() => { if (ui.aiTest === t && ui.sheet === 'settings') renderSheet(); });
    }
    else if (a === 'open-checkin') {
      const due = E.dueCheckin(state, today());
      const week = el.dataset.w != null ? Number(el.dataset.w) : due ? due.week : E.nextCheckinWeek(state, today());
      ciStart(week);
      ui.sheet = 'checkin';
      renderSheet();
    } else if (a === 'ci-review') {
      const missing = ciValidate(ui.ci.data);
      if (missing.length) {
        ui.ci.error = `Answer these before reviewing: ${missing.join(', ')}.`;
        renderSheet();
        const sheet = $('.sheet');
        if (sheet) sheet.scrollTop = sheet.scrollHeight;
        return;
      }
      ui.ci.error = null;
      ui.ciAi = null;
      aiRequest++;
      ui.ci.rec = E.buildCheckinRecord(state, ui.ci.data, today());
      ui.ci.stage = 'review';
      renderSheet();
      const sheet = $('.sheet');
      if (sheet) sheet.scrollTop = 0;
    } else if (a === 'ci-back') { ui.ci.stage = 'form'; renderSheet(); }
    else if (a === 'ci-apply') {
      const rec = ui.ci.rec;
      state.targets = rec.after;
      state.checkins = state.checkins.filter((c) => c.week !== rec.week).concat([rec]);
      state.loadEdits = (state.loadEdits || []).filter((x) => x.week !== rec.week).concat(rec.loadEdits || []);
      save();
      ui.ci = null;
      ui.ciAi = null;
      ui.historyWeek = rec.week;
      ui.sheet = 'history';
      toast(rec.changes.length ? 'Your plan is updated' : 'Check-in saved');
      render();
    } else if (a === 'open-history') { ui.historyWeek = Number(el.dataset.w); ui.sheet = 'history'; renderSheet(); }
    else if (a === 'copy-checkin') {
      const c = state.checkins.find((x) => x.week === Number(el.dataset.w));
      const txt = E.checkinSummaryText(c);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('Summary copied'), () => toast('Copy was blocked. Try again from the Home Screen app.'));
      else toast('Copy is not available here.');
    } else if (a === 'chip') { handleChip(el.dataset.group, el.dataset.v); }
    else if (a.startsWith('toggle-recovery:')) {
      const id = a.split(':')[1];
      const log = state.logs[id] || { type: 'recovery', items: {} };
      log.items = log.items || {};
      log.items[el.dataset.id] = !log.items[el.dataset.id];
      state.logs[id] = log;
      save();
      render();
    } else if (a === 'toggle-meal') {
      const t = ui.fuelDate;
      foodDay(t);
      state.food[t].meals[el.dataset.id] = !state.food[t].meals[el.dataset.id];
      save();
      render();
    } else if (a === 'toggle-flex') {
      const t = ui.fuelDate;
      foodDay(t);
      state.food[t].flex = state.food[t].flex || {};
      state.food[t].flex[el.dataset.id] = !state.food[t].flex[el.dataset.id];
      save();
      render();
    } else if (a === 'fuel-date') {
      const n = E.addDays(ui.fuelDate, Number(el.dataset.d));
      if (n <= today()) { ui.fuelDate = n; render(); }
    } else if (a === 'food-add') {
      ui.foodDraft = { name: '', amount: '', unit: 'g', cal: '', p: '', c: '', f: '', base: null, id: null, error: null };
      ui.sheet = 'food';
      renderSheet();
    } else if (a === 'food-edit') {
      const x = (foodDay(ui.fuelDate).items).find((i) => i.id === el.dataset.id);
      if (x) {
        ui.foodDraft = { name: x.name, amount: x.amount, unit: x.unit, cal: x.cal, p: x.p, c: x.c, f: x.f, base: { amount: x.amount, unit: x.unit, cal: x.cal, p: x.p, c: x.c, f: x.f }, id: x.id, error: null };
        ui.sheet = 'food';
        renderSheet();
      }
    } else if (a === 'food-pick') {
      const f = state.foods[el.dataset.id];
      if (f) {
        ui.foodDraft = { name: f.name, amount: f.amount, unit: f.unit, cal: f.cal, p: f.p, c: f.c, f: f.f, base: { amount: f.amount, unit: f.unit, cal: f.cal, p: f.p, c: f.c, f: f.f }, id: null, error: null };
        renderSheet();
      }
    } else if (a === 'garmin-apply') {
      const unanswered = ui.garmin.items.findIndex((x) => (x.status === 'match' || x.status === 'extra') && x.activity.kind !== 'lift' && !x.talk);
      if (unanswered >= 0) {
        ui.garmin.applyError = 'Some sessions have no heart rate. Answer their heart-rate question first.';
        renderSheet();
        return;
      }
      const result = E.applyGarminImport(state, ui.garmin.items, today());
      save();
      const lines = [];
      if (result.runs) lines.push({ name: 'Runs filled', value: String(result.runs) });
      if (result.cardio) lines.push({ name: 'Cardio filled', value: String(result.cardio) });
      if (result.lifts) lines.push({ name: 'Lift sessions counted', value: String(result.lifts) });
      if (result.extras) lines.push({ name: 'Extra runs added', value: String(result.extras) });
      if (result.baseline) lines.push({ name: 'Past runs added', value: String(result.baseline) });
      const nowPace = `${E.fmtPace(result.paceAfter.easyLo)} to ${E.fmtPace(result.paceAfter.easyHi)}`;
      lines.push({ name: 'Easy pace goal', value: nowPace, cls: result.paceAfter.center < result.paceBefore.center ? 'up' : '' });
      if (result.paceAfter.prediction) lines.push({ name: 'Marathon estimate', value: E.fmtDur(result.paceAfter.prediction.marathon) });
      const sum = E.weekSummary(state, nowWeek(), today());
      lines.push({ name: 'Miles this week', value: `${sum.miles}` });
      const noteParts = result.notes.slice();
      if (result.lifts) noteParts.push("Garmin doesn't give me reliable sets, so add your weights and reps on the Train tab to update your lift targets and graphs.");
      ui.summary = { title: 'Garmin import finished', lines, note: noteParts.join(' ') || 'Your run goals and weekly totals are updated.' };
      ui.garmin = null;
      ui.ci = null;
      ui.ciAi = null;
      ui.sheet = 'summary';
      render();
    } else if (a === 'undo-garmin') {
      if (!ui.confirmUndoGarmin) { ui.confirmUndoGarmin = true; renderSheet(); return; }
      E.undoGarminImport(state);
      save();
      ui.confirmUndoGarmin = false;
      toast('Import undone');
      render();
    } else if (a === 'food-save') saveFood();
    else if (a === 'food-delete') {
      const day = foodDay(ui.fuelDate);
      day.items = day.items.filter((x) => x.id !== ui.foodDraft.id);
      save();
      ui.foodDraft = null;
      ui.sheet = null;
      toast('Food removed');
      render();
    } else if (a === 'open-lift-chart') {
      ui.chartId = el.dataset.id;
      ui.sheet = 'liftchart';
      renderSheet();
    } else if (a === 'save-lift') saveLift(el.dataset.id);
    else if (a === 'save-run') saveRun(el.dataset.id);
    else if (a === 'save-cardio') saveCardio(el.dataset.id);
    else if (a === 'delete-log') { delete state.logs[el.dataset.id]; delete state.drafts[el.dataset.id]; save(); toast('Log deleted'); render(); }
    else if (a === 'tip') {
      const ro = document.getElementById(el.dataset.ro);
      if (ro) ro.innerHTML = `<b>${esc(el.dataset.show)}</b>${esc(el.dataset.label)}`;
    } else if (a === 'export-ics') {
      shareFile('detroit-26-2-schedule.ics', 'text/calendar', E.buildIcs(state, Math.max(ui.schedWeek, schedWeekNow()), 6, today()));
    } else if (a === 'export-backup') {
      shareFile(`detroit-26-2-backup-${today()}.json`, 'application/json', JSON.stringify(state, null, 1));
    } else if (a === 'undo-checkin') {
      if (!ui.confirmUndo) { ui.confirmUndo = true; renderSheet(); return; }
      const last = state.checkins.slice().sort((x, y) => y.week - x.week)[0];
      if (last) {
        state.targets = last.before;
        state.checkins = state.checkins.filter((c) => c !== last);
        state.loadEdits = (state.loadEdits || []).filter((x) => x.week !== last.week);
        save();
        toast('Check-in undone');
      }
      ui.confirmUndo = false;
      render();
    } else if (a === 'reset') {
      if (!ui.confirmReset) { ui.confirmReset = true; renderSheet(); return; }
      state = E.initialState();
      save();
      aiCfg = { enabled: false, url: '', token: '' };
      saveAi();
      ui.confirmReset = false;
      ui.sheet = null;
      ui.tab = 'home';
      toast('Everything was erased');
      render();
    }
  });

  function handleChip(group, v) {
    if (ui.sheet === 'aiadjust' && group.startsWith('ai-')) {
      if (group === 'ai-min') ui.ai.minutes = v;
      if (group === 'ai-energy') ui.ai.energy = v;
      if (group === 'ai-sore') ui.ai.soreness = v;
      renderSheet();
      return;
    }
    if (group === 'ai-on') {
      aiCfg.enabled = v === 'on';
      saveAi();
      ui.aiTest = null;
      renderSheet();
      return;
    }
    if (group === 'gi-unit') {
      ui.garmin.unit = v;
      ui.garmin.items = E.planGarminImport(state, ui.garmin.parsed.activities, v, today());
      renderSheet();
      return;
    }
    if (group.startsWith('gi:')) {
      const [, idx, field2] = group.split(':');
      const item = ui.garmin.items[Number(idx)];
      item.open = true;
      if (field2 === 'talk') item.talk = v;
      if (field2 === 'completed') item.completed = v === 'yes';
      if (field2 === 'hard') item.hard = v === 'yes';
      ui.garmin.applyError = null;
      renderSheet();
      return;
    }
    if (ui.sheet === 'morning') {
      if (group === 'apap') setDay('apap', v === 'yes');
      if (group === 'soreness') setDay('soreness', Number(v));
      renderSheet();
      return;
    }
    if (ui.sheet === 'checkin') {
      const d = ui.ci.data;
      if (group === 'ci-energy') d.energy = Number(v);
      if (group === 'ci-soreness') d.soreness = Number(v);
      if (group === 'ci-cravings') d.cravings = Number(v);
      if (group === 'ci-food') d.food = v;
      if (group === 'ci-backfire') d.trackingBackfired = v === 'yes';
      if (group === 'ci-pain') d.pain = v === 'yes';
      if (group === 'ci-symptoms') d.symptoms = v === 'yes';
      renderSheet();
      return;
    }
    if (ui.sheet === 'food') {
      if (group === 'food-unit') {
        ui.foodDraft.unit = v;
        ui.foodDraft.base = null;
      }
      renderSheet();
      return;
    }
    if (ui.sheet === 'settings') {
      if (group === 'mode') state.targets.mode = v;
      if (group === 'walk') state.targets.walkMin = Number(v);
      save();
      renderSheet();
      return;
    }
    const s = currentTrainSession();
    const d = state.drafts[s.id];
    if (!d) return;
    if (group === 'talk') d.talk = v;
    if (group === 'completed') d.completed = v === 'yes';
    if (group === 'hard') d.hard = v === 'yes';
    if (group === 'machine') d.machine = v;
    save();
    render();
  }
  const currentTrainSession = () => {
    const day = weekFor(ui.trainWeek).days[ui.trainDay];
    return ui.trainPart === 'b' && day.second ? day.second : day;
  };
  /* Open a day on whichever of its sessions is still to do. */
  const openPart = (w, d) => {
    const day = weekFor(w).days[d];
    return day.second && state.logs[day.id] && !state.logs[day.second.id] ? 'b' : 'a';
  };

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    const ds = el.dataset;
    const val = el.value.trim();
    if (ds.set) {
      const s = currentTrainSession();
      const d = liftDraft(s);
      d.exercises[ds.ex] = d.exercises[ds.ex] || { sets: [] };
      const sets = d.exercises[ds.ex].sets;
      const i = Number(ds.i);
      while (sets.length <= i) sets.push({});
      sets[i][ds.set] = val;
      // A weight typed on one set carries to the empty sets below it.
      if (ds.set === 'w') {
        const n = el.closest('.sets').querySelectorAll('input[data-set="w"]');
        n.forEach((other) => {
          const j = Number(other.dataset.i);
          if (j > i && !other.value) other.placeholder = val || other.placeholder;
        });
      }
      save();
    } else if (ds.run) {
      const s = currentTrainSession();
      state.drafts[s.id][ds.run] = val;
      save();
    } else if (ds.cardio) {
      const s = currentTrainSession();
      state.drafts[s.id][ds.cardio] = val;
      save();
    } else if (ds.day) {
      setDay(ds.day, isNum(val) ? Number(val) : null);
    } else if (ds.food) {
      const d = ui.foodDraft;
      d[ds.food] = ds.food === 'name' ? el.value : val;
      if (d.error) {
        d.error = null;
        const shown = document.querySelector('.sheet .err');
        if (shown) shown.remove();
      }
      if (ds.food === 'name') {
        const q = val.toLowerCase();
        document.querySelectorAll('.savedfood').forEach((b) => { b.classList.toggle('hide', !!q && !b.dataset.name.includes(q)); });
      }
      if (ds.food === 'amount' && d.base && d.unit === d.base.unit && isNum(val) && Number(val) > 0) {
        const scaled = E.scaleFood(d.base, val);
        Object.keys(scaled).forEach((k) => {
          d[k] = scaled[k];
          const input = document.querySelector(`[data-food="${k}"]`);
          if (input) input.value = scaled[k];
        });
      }
    } else if (ds.ai) {
      ui.ai.message = el.value;
    } else if (ds.aicfg) {
      aiCfg[ds.aicfg] = val;
      saveAi();
      ui.aiTest = null;
    } else if (ds.ci) {
      ui.ci.data[ds.ci] = ds.ci === 'notes' ? el.value : val;
    } else if (ds.target === 'calories' && isNum(val)) {
      const n = Number(val);
      if (n >= 1500 && n <= 5000) { state.targets.calories = Math.round(n); save(); }
    } else if (ds.time) {
      if (ds.time === 'checkin') state.checkinTime = el.value || '09:00';
      else if (ds.time === 'pm') state.pmTime = el.value || '16:00';
      else state.times[Number(ds.time)] = el.value || state.times[Number(ds.time)];
      save();
    }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.liftSelect) { ui.liftChart = el.value; render(); return; }
    if (el.dataset.actionChange === 'garmin-csv' && el.files && el.files[0]) {
      loadGarminFile(el.files[0]);
      return;
    }
    if (el.dataset.actionChange === 'import-backup' && el.files && el.files[0]) {
      el.files[0].text().then((txt) => {
        const parsed = JSON.parse(txt);
        if (!parsed || parsed.version !== 1 || !parsed.targets || !parsed.logs) throw new Error('bad');
        const init = E.initialState();
        state = Object.assign(init, parsed, { targets: Object.assign(init.targets, parsed.targets) });
        save();
        ui.importError = null;
        ui.sheet = null;
        toast('Backup restored');
        render();
      }).catch(() => {
        ui.importError = 'That file isn\'t a Detroit 26.2 backup. Choose the .json file you exported.';
        renderSheet();
      });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ui.sheet) render();
  });

  /* ---------- Start ---------- */
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
