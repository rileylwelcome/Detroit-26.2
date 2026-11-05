/* Training engine: the plan, the schedule, and every rule that updates a goal.
   No browser APIs here, so the same file runs in the app and in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Dates ---------- */
  const DAY_MS = 864e5;
  const toUtc = (s) => Date.parse(s + 'T00:00:00Z');
  const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (s, n) => toIso(toUtc(s) + n * DAY_MS);
  const diffDays = (a, b) => Math.round((toUtc(a) - toUtc(b)) / DAY_MS);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const fmtDate = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8))}`;
  const dayIndex = (s) => (new Date(toUtc(s)).getUTCDay() + 6) % 7; // Monday = 0

  const START = '2026-11-09';
  const RACE = '2027-10-17';
  const HALF = '2027-04-25';
  const LAST_WEEK = 48;
  const weekOf = (s) => Math.floor(diffDays(s, START) / 7);
  const weekStart = (w) => addDays(START, w * 7);
  const dateOf = (w, d) => addDays(START, w * 7 + d);

  /* ---------- Formatting ---------- */
  const round5 = (n) => Math.round(n / 5) * 5;
  const roundHalf = (n) => Math.round(n * 2) / 2;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const fmtPace = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`.replace(/(\d+):60/, (_, m) => `${Number(m) + 1}:00`);
  function fmtDur(sec) {
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtTime(t) {
    if (!t) return 'Any time';
    let [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ap}`;
  }

  /* ---------- Lifting plan ---------- */
  const EX = {
    incline: { name: 'Incline barbell bench', kind: 'weight', group: 'upper', sets: 3, min: 6, max: 8, start: 190, big: true },
    row: { name: 'Barbell row', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10, start: 165, big: true },
    ohp: { name: 'Overhead press', kind: 'weight', group: 'upper', sets: 3, min: 6, max: 8, start: 110, big: true },
    pulldown: { name: 'Lat pulldown', kind: 'weight', group: 'upper', sets: 3, min: 10, max: 12 },
    fly: { name: 'Cable fly', kind: 'weight', group: 'upper', sets: 2, min: 12, max: 15 },
    lateralA: { name: 'Lateral raise', kind: 'weight', group: 'upper', sets: 2, min: 12, max: 15 },
    curl: { name: 'Cable curl', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    pushdown: { name: 'Triceps pushdown', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    hack: { name: 'Hack squat', kind: 'weight', group: 'lower', sets: 3, min: 6, max: 8, start: 210, big: true },
    rdl: { name: 'Romanian deadlift', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 10, start: 135, big: true },
    lunge: { name: 'Walking lunge', kind: 'weight', group: 'lower', sets: 2, min: 10, max: 10, start: 0, inc: 5, perLeg: true },
    legcurl: { name: 'Seated leg curl', kind: 'weight', group: 'lower', sets: 3, min: 10, max: 12 },
    calf: { name: 'Standing calf raise', kind: 'weight', group: 'lower', sets: 3, min: 12, max: 15 },
    plank: { name: 'Plank', kind: 'time', group: 'lower', sets: 3, min: 30, max: 45, start: 30 },
    csrow: { name: 'Chest-supported row', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10 },
    dbpress: { name: 'Flat dumbbell press', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10 },
    pullup: { name: 'Pull-up or assisted pull-up', kind: 'assist', group: 'upper', sets: 3, min: 6, max: 10 },
    machpress: { name: 'Machine shoulder press', kind: 'weight', group: 'upper', sets: 2, min: 8, max: 10 },
    cablerow: { name: 'Seated cable row', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    lateralB: { name: 'Lateral raise', kind: 'weight', group: 'upper', sets: 3, min: 12, max: 15 },
    reardelt: { name: 'Rear-delt fly', kind: 'weight', group: 'upper', sets: 2, min: 12, max: 15 },
    hammer: { name: 'Hammer curl', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    overheadext: { name: 'Overhead triceps extension', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    goblet: { name: 'Goblet squat', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 12 },
    pushup: { name: 'Push-up', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 15, start: 0 },
    dbrow: { name: 'One-arm dumbbell row', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 12 },
    dbrdl: { name: 'Dumbbell Romanian deadlift', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 12 }
  };
  const LIFTS = {
    upperA: { name: 'Upper A', list: ['incline', 'row', 'ohp', 'pulldown', 'fly', 'lateralA', 'curl', 'pushdown'] },
    lower: { name: 'Lower', list: ['hack', 'rdl', 'lunge', 'legcurl', 'calf', 'plank'] },
    upperB: { name: 'Upper B', list: ['csrow', 'dbpress', 'pullup', 'machpress', 'cablerow', 'lateralB', 'reardelt', 'hammer', 'overheadext'] },
    travel: { name: 'Full body', list: ['goblet', 'pushup', 'dbrow', 'dbrdl', 'plank'] }
  };
  const increment = (ex) => ex.inc || (ex.group === 'upper' ? 5 : 10);
  const STRENGTH_BESTS = {
    incline: { name: 'Incline bench', w: 205, r: 7 },
    hack: { name: 'Hack squat', w: 225, r: 8 },
    row: { name: 'Barbell row', w: 185, r: 7.5 },
    ohp: { name: 'Overhead press', w: 115, r: 8 }
  };
  const STRENGTH_GOALS = {
    incline: { feb: { w: 205, r: 8 }, jun: { w: 215, r: 8 } },
    hack: { feb: { w: 235, r: 8 }, jun: { w: 245, r: 8 } },
    row: { feb: { w: 185, r: 8 }, jun: { w: 195, r: 8 } },
    ohp: { feb: { w: 120, r: 8 }, jun: { w: 125, r: 8 } }
  };
  const e1rm = (w, r, left = 0) => w * (1 + (r + left) / 30);

  /* ---------- Starting state ---------- */
  function initialState() {
    return {
      version: 1,
      times: ['08:00', '08:00', '08:00', '08:00', '09:00', '09:00', null],
      checkinTime: '09:00',
      targets: {
        calories: 2400,
        protein: 175,
        fat: 70,
        walkMin: 0,
        mealShift: false,
        mode: 'track',
        maintenance: false,
        deloadWeeks: [],
        bareWeeks: []
      },
      logs: {},
      days: {},
      food: {},
      foods: {},
      extras: [],
      garminSeen: {},
      lastImport: null,
      checkins: [],
      checklist: {},
      drafts: {}
    };
  }

  /* ---------- Phases ---------- */
  const PHASES = [
    { key: 'foundation', name: 'Foundation', from: 0, to: 5 },
    { key: 'base', name: 'Base', from: 6, to: 17 },
    { key: 'speed', name: 'Speed and strength', from: 18, to: 30 },
    { key: 'block', name: 'Marathon block', from: 31, to: 45 },
    { key: 'taper', name: 'Taper', from: 46, to: 48 }
  ];
  const phaseOf = (w) => PHASES.find((p) => w >= p.from && w <= p.to) || (w < 0 ? PHASES[0] : PHASES[4]);
  const TRAVEL_WEEK = 8; // Jan 4-11
  const FINALS_WEEK = 5; // Dec 14-17
  const isScheduledDeload = (w) => w >= 0 && (w + 1) % 6 === 0;

  const FOUNDATION = [
    { tue: [6, 3, 2], fri: 30, sat: [7, 3, 2] },
    { tue: [5, 4, 2], fri: 35, sat: [7, 4, 2] },
    { tue: [5, 5, 2], fri: 35, sat: [6, 5, 2] },
    { tue: [4, 7, 2], fri: 40, sat: [4, 10, 2] },
    { tue: [3, 10, 2], fri: 40, sat: [2, 20, 2] }
  ];
  const FINALS = { tue: [3, 6, 2], fri: 25, satMinutes: 30 };

  /* ---------- Running progress ----------
     A week that fails the talk test, comes in incomplete, or has no logged runs
     is repeated: every later week's mileage slides back one step. */
  function runDaysOf(w) {
    if (w < 6) return [1, 5];
    if (w < 31) return [1, 4, 5];
    return [1, 2, 4, 5];
  }
  function runShift(state, w, today) {
    let shift = 0;
    for (let i = 0; i < w; i++) {
      if (i === FINALS_WEEK || i === TRAVEL_WEEK) continue;
      if (today && dateOf(i, 6) >= today) continue;
      const logs = runDaysOf(i).map((d) => state.logs[`w${i}d${d}`]).filter(Boolean);
      const failed = logs.some((l) => l.talk === 'fail' || l.completed === false);
      if (failed || (today && !logs.length)) shift++;
    }
    return shift;
  }
  function milesFor(e) {
    const seg = (a, x0, x1, y0, y1) => lerp(y0, y1, (a - x0) / (x1 - x0));
    if (e < 6) return { week: 10, long: 4 };
    if (e <= 17) return { week: seg(e, 6, 17, 12, 20), long: seg(e, 6, 17, 5, 8) };
    if (e <= 30) return { week: seg(e, 18, 30, 20, 30), long: seg(e, 18, 30, 8, 12) };
    if (e <= 45) return { week: seg(e, 31, 45, 30, 50), long: seg(e, 31, 45, 12, 20) };
    return { week: 50, long: 20 };
  }

  /* ---------- Pace stats ---------- */
  const EASY_START = 735; // 12:15 per mile, from a 10:00 mile run too hard
  function runPaceFromLog(session, log) {
    if (!log || !log.distance || !log.seconds) return null;
    const run = session && session.run;
    if (run && run.kind === 'intervals') {
      const runMin = run.reps * run.run;
      const walkMin = run.reps * run.walk + (run.warm || 0) + (run.cool || 0);
      const runDist = log.distance - walkMin / 20;
      if (runDist <= 0.2) return null;
      return (runMin * 60) / runDist;
    }
    return log.seconds / log.distance;
  }
  function runLogs(state) {
    const out = [];
    Object.keys(state.logs).forEach((id) => {
      const log = state.logs[id];
      if (log.type !== 'run') return;
      const m = /^w(-?\d+)d(\d)$/.exec(id);
      if (!m) return;
      out.push({ id, w: Number(m[1]), d: Number(m[2]), log });
    });
    (state.extras || []).forEach((x) => {
      if (x.kind !== 'run') return;
      out.push({ id: x.key, w: weekOf(x.date), d: dayIndex(x.date), extra: true, log: { type: 'run', date: x.date, distance: x.distance, seconds: x.seconds, hr: x.hr, talk: x.talk, hard: x.hard } });
    });
    return out.sort((a, b) => a.w * 7 + a.d - (b.w * 7 + b.d));
  }
  function runStats(state, today) {
    const logs = runLogs(state);
    const easy = [];
    let lastTalk = null;
    let longest = 0;
    logs.forEach(({ w, d, log, extra }) => {
      const session = extra ? { run: { kind: 'distance' } } : sessionFromLog(state, w, d, today);
      const pace = runPaceFromLog(session, log);
      if (log.distance > longest) longest = log.distance;
      if (log.hard) return;
      if (extra && today && diffDays(today, log.date) > 90) return;
      if (pace && log.talk === 'pass') easy.push(pace);
      if (log.talk) lastTalk = log.talk;
    });
    let center = median(easy.slice(-3)) || EASY_START;
    if (lastTalk === 'fail') center += 15;
    center = clamp(center, 480, 900);
    return {
      easyLo: center - 10,
      easyHi: center + 20,
      center,
      logged: logs.length,
      longest,
      prediction: predict(state, today)
    };
  }
  /* Riegel estimate from the most recent hard effort. */
  function riegel(sec, dist, target) {
    return sec * Math.pow(target / dist, 1.06);
  }
  function predict(state, today) {
    const hard = runLogs(state)
      .filter(({ w, d, log }) => log.hard && log.distance >= 1 && log.seconds > 0 && (!today || diffDays(today, dateOf(w, d)) <= 120))
      .slice(-1)[0];
    if (!hard) return null;
    const { log } = hard;
    return {
      fromMiles: log.distance,
      fromSeconds: log.seconds,
      threeMile: riegel(log.seconds, log.distance, 3),
      half: riegel(log.seconds, log.distance, 13.1),
      marathon: riegel(log.seconds, log.distance, 26.2)
    };
  }
  const MARATHON_TIERS = [
    { label: 'Finish healthy', sec: null },
    { label: 'Under 4:00', sec: 4 * 3600 },
    { label: '3:30 stretch', sec: 3.5 * 3600 }
  ];
  function marathonGoalPace(stats) {
    if (stats.prediction) {
      const p = stats.prediction.marathon / 26.2;
      return clamp(p, 480, 660); // never quicker than the 3:30 stretch goal
    }
    return 549; // 9:09, the pace of a 4:00 marathon
  }

  function runGoal(run, stats) {
    const lo = stats.easyLo;
    const hi = stats.easyHi;
    if (run.kind === 'intervals') {
      const runMin = run.reps * run.run;
      const walkMin = run.reps * run.walk + (run.warm || 0) + (run.cool || 0);
      const dLo = (runMin * 60) / hi + walkMin / 20;
      const dHi = (runMin * 60) / lo + walkMin / 20;
      return {
        headline: `${runMin + walkMin} min`,
        detail: `Goal: finish every interval and pass the talk test. Running pace ${fmtPace(lo)} to ${fmtPace(hi)} per mile, about ${dLo.toFixed(1)} to ${dHi.toFixed(1)} miles in total.`,
        lo: null, hi: null
      };
    }
    if (run.effort === 'test') {
      const g = run.goalSeconds;
      const stretch = run.miles === 3 ? `Run all 3 miles without stopping. The stretch goal is under ${fmtDur(g)}, or 9:00 per mile.` : `Run this hard but controlled. The target is ${fmtDur(g)} or close to it, your signal for the 3:30 stretch goal.`;
      return { headline: fmtDur(g), detail: stretch, lo: g, hi: g };
    }
    if (run.effort === 'race') {
      const label = run.miles > 20 ? 'Finish healthy first, then under 4:00, with 3:30 as the stretch goal.' : 'Keep this at an easy effort. It is a long training run with a medal, not a test.';
      const projected = stats.prediction ? ` Current estimate: ${fmtDur(run.miles > 20 ? stats.prediction.marathon : stats.prediction.half)}.` : '';
      return { headline: `${run.miles} mi`, detail: label + projected, lo: null, hi: null };
    }
    let pLo = lo;
    let pHi = hi;
    let note = '';
    if (run.effort === 'long') {
      pLo = lo + 10;
      pHi = hi + 15;
      note = 'Keep the talk test honest. Slow down before you walk.';
    } else if (run.effort === 'tempo') {
      note = `Easy pace, except ${run.tempoMin} minutes in the middle at ${fmtPace(clamp(stats.center - 75, 420, 780))} per mile.`;
    } else if (run.effort === 'marathon') {
      note = `Easy pace, except ${run.mpMiles} miles in the middle at ${fmtPace(marathonGoalPace(stats))} per mile.`;
    } else if (run.effort === 'shakeout') {
      pLo = lo + 15;
      pHi = hi + 30;
      note = 'Short and relaxed, just enough to loosen up.';
    } else {
      note = 'You should be able to speak in full sentences the whole way.';
    }
    return {
      headline: `${fmtDur(run.miles * pLo)} to ${fmtDur(run.miles * pHi)}`,
      detail: `${note} Easy pace target ${fmtPace(pLo)} to ${fmtPace(pHi)} per mile.`,
      lo: run.miles * pLo,
      hi: run.miles * pHi
    };
  }

  /* ---------- Week builder ---------- */
  function liftSession(w, d, key, opts) {
    const lift = LIFTS[key];
    return Object.assign({ id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'lift', lift: key, title: lift.name, minutes: 75, required: key === 'upperA' || key === 'lower' }, opts || {});
  }
  function intervalsSession(w, d, spec, opts) {
    const [reps, run, walk] = spec;
    const minutes = reps * (run + walk) + 10;
    return Object.assign({
      id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'run', title: d === 5 ? 'Long run/walk' : 'Run/walk', minutes, required: true,
      run: { kind: 'intervals', reps, run, walk, warm: 5, cool: 5 },
      subtitle: `${reps} x (${run} run, ${walk} walk)`
    }, opts || {});
  }
  function milesSession(w, d, miles, effort, title, extras, center) {
    const m = effort === 'race' || effort === 'test' ? miles : roundHalf(miles);
    return Object.assign({
      id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'run', title, required: d === 5 || d === 1,
      minutes: round5((m * center) / 60) + 10,
      run: Object.assign({ kind: 'distance', miles: m, effort, warm: 0, cool: 0 }, extras || {}),
      subtitle: `${m} miles`
    });
  }
  function cardioSession(w, d, minutes, machine) {
    return { id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'cardio', title: machine === 'bike' ? 'Bike' : 'Stairmaster or bike', minutes, required: false, subtitle: `${minutes} min easy` };
  }
  function restSession(w, d) {
    return {
      id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'recovery', title: 'Rest and recover', minutes: 60, required: false,
      subtitle: 'Walk, sauna, hydromassage, meal prep'
    };
  }

  function buildWeek(state, w, today) {
    const targets = state.targets;
    const travel = w === TRAVEL_WEEK;
    const finals = w === FINALS_WEEK;
    const deload = !travel && (isScheduledDeload(w) || targets.deloadWeeks.includes(w));
    const bare = targets.bareWeeks.includes(w);
    const phase = phaseOf(w);
    const shift = runShift(state, w, today);
    const stats = runStats(state, today);
    const center = stats.center;
    const days = [];

    if (w < 0) {
      // The days before the plan starts: log anything, nothing here is required.
      days.push(liftSession(w, 0, 'upperA'));
      days.push(milesSession(w, 1, 3, 'easy', 'Easy run', null, center));
      days.push(liftSession(w, 2, 'lower'));
      days.push(liftSession(w, 3, 'upperB', { required: false }));
      days.push(cardioSession(w, 4, 30, 'stairs'));
      days.push(milesSession(w, 5, 3, 'easy', 'Easy run', null, center));
      days.push(restSession(w, 6));
    } else if (travel) {
      days.push({ id: `w${w}d0`, w, d: 0, date: dateOf(w, 0), type: 'recovery', title: 'Travel day', minutes: 0, required: false, subtitle: 'Walk when you can' });
      days.push(milesSession(w, 1, 3, 'easy', 'Easy run', null, center));
      days.push(liftSession(w, 2, 'travel', { minutes: 40, subtitle: "Use what's available", required: true }));
      days.push(milesSession(w, 3, 3, 'easy', 'Easy run', null, center));
      days.push(liftSession(w, 4, 'travel', { minutes: 40, subtitle: "Use what's available", required: true }));
      days.push(milesSession(w, 5, 4, 'easy', 'Easy run', null, center));
      days.push(restSession(w, 6));
    } else if (w < 6) {
      const step = finals ? null : FOUNDATION[clamp(w - shift, 0, 4)];
      const repeated = !finals && w > 0 && shift > runShift(state, w - 1, today);
      days.push(liftSession(w, 0, 'upperA'));
      days.push(intervalsSession(w, 1, finals ? FINALS.tue : step.tue, repeated ? { repeated: true } : {}));
      days.push(liftSession(w, 2, 'lower'));
      days.push(liftSession(w, 3, 'upperB', { required: false }));
      days.push(cardioSession(w, 4, finals ? FINALS.fri : step.fri, finals ? 'bike' : 'stairs'));
      days.push(finals
        ? { id: `w${w}d5`, w, d: 5, date: dateOf(w, 5), type: 'run', title: 'Easy run', minutes: 30, required: true, run: { kind: 'minutes', minutes: 30, effort: 'easy' }, subtitle: '30 min easy, walk if needed' }
        : intervalsSession(w, 5, step.sat, repeated ? { repeated: true } : {}));
      days.push(restSession(w, 6));
    } else {
      const e = w - shift;
      let { week: miles, long } = milesFor(e);
      if (phase.key === 'taper') {
        const peak = milesFor(45 - shift);
        miles = Math.min(peak.week, [40, 30, 20][w - 46]);
        long = Math.min(peak.long, [12, 10, 8][w - 46]);
      } else if (deload) {
        miles *= 0.75;
        long *= 0.75;
      }
      const raceWeek = w === LAST_WEEK;
      const isHalfWeek = dateOf(w, 6) === HALF;
      if (phase.key === 'base' || phase.key === 'speed') {
        const mid = (miles - long) / 2;
        days.push(liftSession(w, 0, 'upperA'));
        if (phase.key === 'speed' && !deload) {
          const tempoMin = Math.round(lerp(15, 30, (w - 18) / 12));
          if (mid >= 4) days.push(milesSession(w, 1, mid, 'tempo', 'Tempo run', { tempoMin }, center));
          else days.push(milesSession(w, 1, mid, 'easy', 'Easy run', null, center));
        } else days.push(milesSession(w, 1, mid, 'easy', 'Easy run', null, center));
        days.push(liftSession(w, 2, 'lower'));
        days.push(liftSession(w, 3, 'upperB', { required: false }));
        days.push(milesSession(w, 4, mid, 'easy', 'Easy run', null, center));
      } else if (raceWeek) {
        days.push(liftSession(w, 0, 'upperA', { minutes: 40, subtitle: 'Light session' }));
        days.push(milesSession(w, 1, 8, 'easy', 'Easy run', null, center));
        days.push(milesSession(w, 2, 5, 'easy', 'Easy run', null, center));
        days.push({ id: `w${w}d3`, w, d: 3, date: dateOf(w, 3), type: 'recovery', title: 'Rest', minutes: 0, required: false, subtitle: 'Pack your passport or travel document' });
        days.push(milesSession(w, 4, 4, 'easy', 'Easy run', null, center));
      } else {
        const mid = (miles - long) / 3;
        days.push(liftSession(w, 0, 'lower', phase.key === 'taper' ? { minutes: 45, subtitle: 'Light session' } : {}));
        days.push(milesSession(w, 1, mid, 'easy', 'Easy run', null, center));
        if (deload) days.push(milesSession(w, 2, mid, 'easy', 'Easy run', null, center));
        else {
          const mpMiles = Math.round(lerp(3, 10, clamp((w - 31) / 14, 0, 1)));
          const paced = Math.min(mpMiles, Math.floor(mid) - 2);
          if (paced >= 1) days.push(milesSession(w, 2, mid, 'marathon', 'Marathon-pace run', { mpMiles: paced }, center));
          else days.push(milesSession(w, 2, mid, 'easy', 'Easy run', null, center));
        }
        days.push(liftSession(w, 3, 'upperA', phase.key === 'taper' ? { minutes: 45, subtitle: 'Light session' } : {}));
        days.push(milesSession(w, 4, mid, 'easy', 'Easy run', null, center));
      }
      // Saturday
      const test3 = dateOf(w, 5) === '2027-02-06';
      const testHalf = dateOf(w, 5) === '2027-09-04';
      if (raceWeek) days.push(milesSession(w, 5, 3, 'shakeout', 'Shakeout', null, center));
      else if (isHalfWeek) days.push(milesSession(w, 5, 2, 'shakeout', 'Shakeout', null, center));
      else if (test3) days.push(milesSession(w, 5, 3, 'test', '3-mile test', { goalSeconds: 27 * 60 }, 540));
      else if (testHalf) days.push(milesSession(w, 5, 13.1, 'test', 'Half-marathon test', { goalSeconds: 100 * 60 }, 458));
      else days.push(milesSession(w, 5, long, 'long', 'Long run', null, center + 15));
      // Sunday
      if (raceWeek) {
        const s = milesSession(w, 6, 26.2, 'race', 'Detroit Free Press Marathon', null, 549);
        s.time = '07:00';
        s.required = true;
        days.push(s);
      } else if (isHalfWeek) {
        const s = milesSession(w, 6, 13.1, 'race', 'Motor City Half', null, center);
        s.required = true;
        days.push(s);
      } else days.push(restSession(w, 6));
    }

    days.forEach((s) => {
      if (s.time === undefined) s.time = s.type === 'recovery' ? state.times[6] : state.times[s.d];
      if (bare && !s.required && s.type !== 'recovery') {
        s.skippedForBare = true;
      }
      if (s.type === 'run') s.goal = s.run.kind === 'minutes'
        ? { headline: '30 min', detail: `Easy effort throughout. Target ${fmtPace(stats.easyLo)} to ${fmtPace(stats.easyHi)} per mile, walking when you need to.`, lo: null, hi: null }
        : runGoal(s.run, stats);
    });

    return { w, pre: w < 0, start: weekStart(w), end: dateOf(w, 6), phase, deload, bare, travel, finals, shift, days, stats };
  }

  function sessionFromLog(state, w, d, today) {
    // Light rebuild used while reading paces, so it cannot call runStats again.
    if (w >= 0 && w < 6 && w !== FINALS_WEEK && (d === 1 || d === 5)) {
      const shift = runShift(state, w, today);
      const step = FOUNDATION[clamp(w - shift, 0, 4)];
      const spec = d === 1 ? step.tue : step.sat;
      return { run: { kind: 'intervals', reps: spec[0], run: spec[1], walk: spec[2], warm: 5, cool: 5 } };
    }
    if (w === FINALS_WEEK && d === 1) {
      return { run: { kind: 'intervals', reps: 3, run: 6, walk: 2, warm: 5, cool: 5 } };
    }
    return { run: { kind: 'distance' } };
  }

  const countsAsPlanned = (s) => s.type !== 'recovery' && !s.skippedForBare && s.minutes > 0;

  /* ---------- Lifting logic: replay every log, oldest first ---------- */
  function liftState(state, maxWeek) {
    const out = {};
    Object.keys(EX).forEach((id) => {
      const ex = EX[id];
      out[id] = { load: ex.start === undefined ? null : ex.start, status: 'start', failStreak: 0, last: null, reason: null, history: [] };
    });
    const logs = Object.keys(state.logs)
      .filter((id) => state.logs[id].type === 'lift')
      .map((id) => {
        const m = /^w(-?\d+)d(\d)$/.exec(id);
        return { id, w: Number(m[1]), d: Number(m[2]), log: state.logs[id] };
      })
      .filter((x) => maxWeek === undefined || x.w <= maxWeek)
      .sort((a, b) => a.w * 7 + a.d - (b.w * 7 + b.d));
    logs.forEach(({ w, d, log }) => {
      const deload = isScheduledDeload(w) || state.targets.deloadWeeks.includes(w) || w === TRAVEL_WEEK;
      Object.keys(log.exercises || {}).forEach((id) => {
        const ex = EX[id];
        const entry = log.exercises[id];
        const st = out[id];
        if (!ex || !st) return;
        const sets = (entry.sets || []).filter((s) => s.r !== '' && s.r != null && Number(s.r) >= 0);
        if (!sets.length) return;
        const reps = sets.map((s) => Number(s.r));
        const weights = sets.map((s) => (s.w === '' || s.w == null ? null : Number(s.w)));
        const top = weights.reduce((m, x) => (x != null && (m == null || x > m) ? x : m), null);
        const left = entry.left == null ? 2 : Number(entry.left);
        const need = deload ? 2 : ex.sets;
        st.last = { date: dateOf(w, d), sets: sets.map((s) => ({ w: s.w === '' ? null : s.w, r: Number(s.r) })), left, w };
        if (ex.kind !== 'time' && top != null) {
          const bestE = Math.max(...sets.map((s) => e1rm(Number(s.w) || 0, Number(s.r), left)));
          st.history.push({ date: dateOf(w, d), w, e1rm: bestE, top });
        }

        if (ex.kind === 'time') {
          const goal = st.load;
          if (w < 2 || deload) { st.status = 'hold'; st.reason = deload ? 'Deload, so the target holds.' : 'Automatic increases start in week 3.'; return; }
          if (reps.length >= need && reps.every((r) => r >= goal)) {
            st.load = Math.min(60, goal + 5);
            st.status = st.load > goal ? 'up' : 'hold';
            st.reason = st.load > goal ? `Every set reached ${goal} seconds.` : 'You reached the 60-second cap.';
          } else { st.status = 'hold'; st.reason = `Hold ${goal} seconds until every set reaches it.`; }
          return;
        }

        const base = top == null ? st.load : top;
        const known = st.load != null;
        if (w < 2) {
          // Before week 3 the next target follows what you lifted, with no automatic increase.
          if (base != null) st.load = base;
          else if (!known) st.load = base;
          st.status = 'hold';
          st.reason = 'Your next target matches what you lifted. Automatic increases start in week 3.';
          return;
        }
        if (deload) {
          st.status = 'hold';
          st.reason = 'Deload, so the target holds.';
          return;
        }
        st.load = base;
        const hitTop = reps.length >= need && reps.every((r) => r >= ex.max);
        const allBelow = reps.length >= need && reps.every((r) => r < ex.min);
        if (hitTop && left >= 2) {
          const inc = increment(ex);
          if (ex.kind === 'assist') st.load = Math.max(0, (base || 0) - 10);
          else st.load = (base || 0) + inc;
          st.status = 'up';
          st.failStreak = 0;
          st.reason = `All sets reached ${ex.max} reps with ${left} left.`;
        } else if (allBelow) {
          st.failStreak += 1;
          if (st.failStreak >= 2) {
            st.load = ex.kind === 'assist' ? (base || 0) + 10 : Math.max(0, round5((base || 0) * 0.9));
            st.status = 'down';
            st.failStreak = 0;
            st.reason = `Two sessions in a row under ${ex.min} reps, so the weight comes down about 10%.`;
          } else {
            st.status = 'hold';
            st.reason = `Under ${ex.min} reps today. Try the same weight once more.`;
          }
        } else {
          st.failStreak = 0;
          st.status = 'hold';
          st.reason = `Keep this weight until every set reaches ${ex.max} reps with about 2 left.`;
        }
      });
    });
    return out;
  }

  function loadText(ex, load) {
    if (ex.kind === 'time') return `${load} sec`;
    if (load == null) return 'Set it';
    if (ex.kind === 'assist') return load === 0 ? 'No assist' : `${load} lb`;
    if (load === 0) return 'Bodyweight';
    return `${load} lb`;
  }
  function liftChanges(state, week) {
    const before = liftState(state, week - 1);
    const after = liftState(state, week);
    const out = [];
    Object.keys(EX).forEach((id) => {
      const a = before[id].load;
      const b = after[id].load;
      if (a != null && b != null && a !== b) out.push({ name: EX[id].name, from: loadText(EX[id], a), to: loadText(EX[id], b), up: EX[id].kind === 'assist' ? b < a : b > a });
    });
    return out;
  }

  function liftsDown(ls, today) {
    let down = 0;
    Object.keys(STRENGTH_BESTS).forEach((id) => {
      const h = ((ls[id] && ls[id].history) || []).filter((x) => x.w >= 2);
      const recent = h.filter((x) => diffDays(today, x.date) <= 14);
      const older = h.filter((x) => diffDays(today, x.date) > 14);
      if (!recent.length || !older.length) return;
      const peak = Math.max(...older.map((x) => x.e1rm));
      const now = Math.max(...recent.map((x) => x.e1rm));
      if (now < peak * 0.9) down++;
    });
    return down >= 2;
  }

  /* ---------- Nutrition ---------- */
  function macros(t) {
    const carbsCenter = (t.calories - t.protein * 4 - t.fat * 9) / 4;
    const floor5 = (n) => Math.floor(n / 5) * 5;
    const ceil5 = (n) => Math.ceil(n / 5) * 5;
    return {
      calLo: t.calories - 50,
      calHi: t.calories + 50,
      proLo: t.protein - 5,
      proHi: t.protein + 5,
      carbLo: floor5(carbsCenter - 15),
      carbHi: ceil5(carbsCenter + 15),
      fatLo: t.fat - 5,
      fatHi: t.fat + 5
    };
  }
  const RICE_CUP = 205;
  const RICE_CARB = RICE_CUP / 4; // keeps a meal's macros adding up to its calories as portions change
  const ALMOND_OZ = 165;
  function fractionText(x) {
    const whole = Math.floor(x + 1e-6);
    const q = Math.round((x - whole) * 4);
    const frac = ['', '1/4', '1/2', '3/4'][q];
    if (!whole) return frac || '0';
    return frac ? `${whole} ${frac}` : String(whole);
  }
  function mealPlan(t) {
    const delta = t.calories - 2375; // the listed meals total 2,375 of the 2,400 target
    let lunchRice = 1.5;
    let dinnerRice = 1;
    let almonds = 1;
    const quarter = RICE_CUP / 4;
    if (delta >= 0) {
      const q = Math.round(delta / quarter);
      lunchRice += Math.floor(q / 2) / 4;
      dinnerRice += Math.ceil(q / 2) / 4;
    } else {
      let remaining = -delta;
      let cut = 0;
      while (remaining >= quarter / 2 && cut < 4) {
        if (cut % 2 === 0) dinnerRice -= 0.25;
        else lunchRice -= 0.25;
        remaining -= quarter;
        cut++;
      }
      if (remaining >= ALMOND_OZ / 4) almonds = 0.5;
    }
    if (t.mealShift) {
      const move = Math.min(0.5, lunchRice - 0.5);
      lunchRice -= move;
      dinnerRice += move;
    }
    const riceCal = (cups) => Math.round((cups - 0) * RICE_CUP);
    const meals = [
      { id: 'pre', time: '7:15 am', name: 'Pre-training', portions: '1 banana, coffee', portionsGuide: '1 banana, coffee', cal: 105, pro: 1, carb: 27, fat: 0 },
      { id: 'burrito', time: '9:30 am', name: 'Breakfast burrito', portions: '1 egg, 1 cup egg whites, 3 oz raw 93/7 beef, 150 g potatoes, onions, salsa, 1 carb-counter tortilla', portionsGuide: 'Palm of beef, 1 egg and a good pour of egg whites, a fist of potatoes, onions, salsa, 1 tortilla', cal: 510, pro: 58, carb: 38, fat: 14 },
      { id: 'lunch', time: '12:30 pm', name: 'Chicken bowl', portions: `6 oz raw chicken breast, ${fractionText(lunchRice)} cup${lunchRice === 1 ? '' : 's'} cooked rice, 1 cup vegetables, 1/2 avocado, 1 tbsp Bachan's`, portionsGuide: `Large palm of chicken, ${lunchRice >= 1.5 ? '2 fists' : '1 fist'} of rice, a fist of vegetables, 1/2 avocado, a drizzle of Bachan's`, cal: 680 - riceCal(1.5) + riceCal(lunchRice), pro: 46, carb: Math.round(79 + (lunchRice - 1.5) * RICE_CARB), fat: 20 },
      { id: 'snack', time: '4:30 pm', name: 'Portable snack', portions: `Ryse protein with almond milk, 1 apple, ${almonds === 1 ? '1 oz' : '1/2 oz'} almonds`, portionsGuide: `Ryse protein with almond milk, 1 apple, ${almonds === 1 ? 'a small handful' : 'half a handful'} of almonds`, cal: 420 - (almonds === 1 ? 0 : 82), pro: 31, carb: 34 - (almonds === 1 ? 0 : 3), fat: 18 - (almonds === 1 ? 0 : 7) },
      { id: 'dinner', time: '8:45 pm', name: 'Dinner', portions: `6 oz raw trout or chicken, ${fractionText(dinnerRice)} cup${dinnerRice === 1 ? '' : 's'} cooked rice, 1 cup vegetables, 1/4 avocado, 1 tbsp Bachan's`, portionsGuide: `Large palm of trout or chicken, ${dinnerRice >= 1.25 ? '1 big fist' : '1 fist'} of rice, a fist of vegetables, 1/4 avocado, a drizzle of Bachan's`, cal: 610 - riceCal(1) + riceCal(dinnerRice), pro: 39, carb: Math.round(68 + (dinnerRice - 1) * RICE_CARB), fat: 20 },
      { id: 'dessert', time: '9:45 pm', name: 'Planned dessert', portions: '1 no-sugar-added strawberry Outshine bar', portionsGuide: '1 no-sugar-added strawberry Outshine bar', cal: 50, pro: 0, carb: 11, fat: 0 }
    ];
    return { meals, total: meals.reduce((a, m) => a + m.cal, 0), protein: meals.reduce((a, m) => a + m.pro, 0), lunchRice, dinnerRice, almonds };
  }
  /* What's been eaten today: logged foods plus any planned meals checked off. */
  function foodTotals(day, plan) {
    const out = { cal: 0, pro: 0, carb: 0, fat: 0 };
    if (!day) return out;
    (day.items || []).forEach((x) => {
      out.cal += Number(x.cal) || 0;
      out.pro += Number(x.p) || 0;
      out.carb += Number(x.c) || 0;
      out.fat += Number(x.f) || 0;
    });
    (plan ? plan.meals : []).forEach((m) => {
      if (!day.meals || !day.meals[m.id]) return;
      out.cal += m.cal;
      out.pro += m.pro;
      out.carb += m.carb;
      out.fat += m.fat;
    });
    Object.keys(out).forEach((k) => { out[k] = Math.round(out[k] * 10) / 10; });
    return out;
  }
  /* Where one number stands against its daily range. */
  function rangeStatus(value, lo, hi, unit) {
    const u = unit ? ` ${unit}` : '';
    const n = (v) => Math.round(v).toLocaleString('en-US');
    if (value > hi) return { state: 'over', text: `${n(value - hi)}${u} over your range` };
    if (value >= lo) return { state: 'in', text: 'In your range' };
    return { state: 'under', text: `${n(lo - value)}${u} to reach your range` };
  }
  function scaleFood(base, amount) {
    const f = Number(amount) / Number(base.amount);
    const one = (v) => Math.round(Number(v) * f * 10) / 10;
    return { cal: Math.round(Number(base.cal) * f), p: one(base.p), c: one(base.c), f: one(base.f) };
  }
  const caloriesFromMacros = (p, c, f) => Math.round((Number(p) || 0) * 4 + (Number(c) || 0) * 4 + (Number(f) || 0) * 9);

  /* Every logged session of one exercise, oldest first, for its graph. */
  function exerciseHistory(state, exId) {
    const ex = EX[exId];
    const ids = Object.keys(EX).filter((k) => EX[k].name === ex.name);
    const rows = [];
    Object.keys(state.logs).forEach((key) => {
      const log = state.logs[key];
      if (log.type !== 'lift' || !log.exercises) return;
      const m = /^w(-?\d+)d(\d)$/.exec(key);
      ids.forEach((id) => {
        const entry = log.exercises[id];
        if (!entry) return;
        const sets = (entry.sets || []).filter((s) => s.r !== '' && s.r != null && Number.isFinite(Number(s.r)));
        if (!sets.length) return;
        const weights = sets.map((s) => (s.w === '' || s.w == null ? 0 : Number(s.w)));
        const top = Math.max(...weights);
        rows.push({
          date: log.date || dateOf(Number(m[1]), Number(m[2])),
          order: Number(m[1]) * 7 + Number(m[2]),
          top,
          bestReps: Math.max(...sets.map((s) => Number(s.r))),
          sets: sets.map((s) => ({ w: s.w === '' || s.w == null ? null : Number(s.w), r: Number(s.r) }))
        });
      });
    });
    rows.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
    const usesWeight = rows.some((r) => r.top > 0);
    const unit = ex.kind === 'time' ? 'sec' : usesWeight ? 'lb' : 'reps';
    const label = ex.kind === 'time' ? 'Longest hold' : usesWeight ? (ex.kind === 'assist' ? 'Assistance' : 'Top weight') : 'Most reps';
    rows.forEach((r) => { r.value = unit === 'lb' ? r.top : r.bestReps; });
    return { rows, unit, label, name: ex.name };
  }

  function trackingToday(state, date) {
    const w = weekOf(date);
    if (state.targets.mode === 'portions') return { kind: 'portions', text: 'Portion guides are on, so nothing needs weighing.' };
    if (w === TRAVEL_WEEK || date === '2027-01-11') return { kind: 'off', text: 'Skip food tracking this week. Aim for protein at each meal.' };
    if (w < 0) return { kind: 'off', text: 'Your plan starts Monday, November 9. You can log food now.' };
    if (w < 2) return { kind: 'weigh', text: 'Weigh everything for your first two weeks.' };
    if (dayIndex(date) === 2) return { kind: 'weigh', text: 'Wednesday spot-check: weigh everything today.' };
    return { kind: 'relaxed', text: 'No weighing today. Your next spot-check is Wednesday.' };
  }
  function longRunFuel(session) {
    if (!session || session.type !== 'run') return null;
    if (session.d === 5 || session.run.effort === 'long') {
      const m = session.run.miles;
      if (m && m >= 10) return 'Add 1 banana or 1/2 cup cooked rice afterward, and take 30 to 60 g of carbs per hour during the run.';
      return 'Add 1 banana or 1/2 cup cooked rice after your long run.';
    }
    return null;
  }

  /* ---------- Daily readiness ---------- */
  function restingBaseline(state, date) {
    const prior = Object.keys(state.days)
      .filter((d) => d < date && state.days[d].rhr)
      .sort()
      .slice(-14)
      .map((d) => Number(state.days[d].rhr));
    return prior.length >= 3 ? median(prior) : null;
  }
  function readiness(state, date) {
    const log = state.days[date];
    if (!log || (log.sleep == null && log.rhr == null && log.soreness == null)) return null;
    const baseline = restingBaseline(state, date);
    const parts = [];
    if (log.sleep != null) parts.push([0.45, clamp(Number(log.sleep) / 8, 0, 1)]);
    if (log.rhr != null && baseline != null) parts.push([0.3, clamp(1 - Math.max(0, Number(log.rhr) - baseline) / 10, 0, 1)]);
    if (log.soreness != null) parts.push([0.25, clamp(1 - (Number(log.soreness) - 1) / 9, 0, 1)]);
    if (!parts.length) return null;
    const weight = parts.reduce((a, p) => a + p[0], 0);
    const score = Math.round((parts.reduce((a, p) => a + p[0] * p[1], 0) / weight) * 100);
    return { score, band: score >= 67 ? 'good' : score >= 34 ? 'mid' : 'low', baseline };
  }
  function backOff(state, date) {
    const out = [];
    const log = state.days[date];
    if (!log) return out;
    if (log.sleep != null && Number(log.sleep) < 6) out.push({ kind: 'sleep', title: 'Under 6 hours of sleep', text: 'Do today\'s session at easy effort, or swap it for a walk.' });
    if (log.soreness != null && Number(log.soreness) >= 7) out.push({ kind: 'soreness', title: `Soreness at ${log.soreness} out of 10`, text: 'Skip the hard work and do a 20-minute walk or easy bike ride.' });
    const baseline = restingBaseline(state, date);
    if (baseline != null && log.rhr != null) {
      const y = state.days[addDays(date, -1)];
      if (Number(log.rhr) - baseline >= 7 && y && y.rhr != null && Number(y.rhr) - baseline >= 7) {
        out.push({ kind: 'rhr', title: 'Resting heart rate high for 2 mornings', text: 'Keep today easy, and rest tomorrow if it stays high.' });
      }
    }
    return out;
  }

  /* ---------- Weekly summary ---------- */
  function weekSummary(state, w, today) {
    const week = buildWeek(state, w, today);
    const planned = week.days.filter(countsAsPlanned);
    const done = planned.filter((s) => state.logs[s.id]);
    let miles = 0;
    let longest = 0;
    let talkFails = 0;
    let talkLogged = 0;
    week.days.forEach((s) => {
      const log = state.logs[s.id];
      if (!log || log.type !== 'run') return;
      const dist = Number(log.distance) || 0;
      miles += dist;
      if (dist > longest) longest = dist;
      if (log.talk) talkLogged++;
      if (log.talk === 'fail') talkFails++;
    });
    (state.extras || []).forEach((x) => {
      if (x.kind !== 'run' || weekOf(x.date) !== w) return;
      miles += x.distance;
      if (x.distance > longest) longest = x.distance;
    });
    const dates = Array.from({ length: 7 }, (_, i) => dateOf(w, i));
    const weights = dates.map((d) => state.days[d] && state.days[d].weight).filter((x) => x != null && x !== '').map(Number);
    const sleeps = dates.map((d) => state.days[d] && state.days[d].sleep).filter((x) => x != null && x !== '').map(Number);
    const apapLogged = dates.filter((d) => state.days[d] && state.days[d].apap != null);
    const apap = apapLogged.filter((d) => state.days[d].apap).length;
    return {
      w,
      planned: planned.length,
      done: done.length,
      missed: Math.max(0, planned.length - done.length),
      miles: Math.round(miles * 10) / 10,
      longest,
      talkFails,
      talkLogged,
      weightAvg: weights.length ? Math.round(mean(weights) * 10) / 10 : null,
      weightCount: weights.length,
      sleepAvg: sleeps.length ? Math.round(mean(sleeps) * 10) / 10 : null,
      apapNights: apapLogged.length ? apap : null,
      apapLogged: apapLogged.length
    };
  }
  function plannedMiles(state, w, today) {
    const week = buildWeek(state, w, today);
    let total = 0;
    week.days.forEach((s) => {
      if (s.type !== 'run' || s.skippedForBare) return;
      if (s.run.kind === 'distance' && s.run.effort !== 'race') total += s.run.miles;
      else if (s.run.kind === 'intervals') total += (s.run.reps * s.run.run * 60) / week.stats.center + (s.run.reps * s.run.walk + 10) / 20;
      else if (s.run.kind === 'minutes') total += (s.run.minutes * 60) / week.stats.center;
    });
    return Math.round(total * 10) / 10;
  }

  /* ---------- Garmin activities CSV ---------- */
  function parseCsv(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell);
        cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const CSV_COLUMNS = {
    type: ['activity type', 'type', 'sport'],
    date: ['date', 'start time', 'begin timestamp', 'start date'],
    title: ['title', 'activity name', 'name'],
    distance: ['distance', 'distance (mi)', 'distance (miles)', 'distance (km)'],
    time: ['time', 'duration', 'elapsed time', 'moving time', 'total time'],
    hr: ['avg hr', 'average heart rate', 'avg heart rate', 'average hr', 'avg hr (bpm)']
  };
  function parseCsvDate(raw) {
    const s = String(raw || '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
    const pad = (n) => String(n).padStart(2, '0');
    if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, clock: m[4] ? `${pad(m[4])}:${m[5]}` : '' };
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?/i.exec(s);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      let hour = m[4] ? Number(m[4]) : null;
      if (hour != null && m[6]) hour = (hour % 12) + (/p/i.test(m[6]) ? 12 : 0);
      return { date: `${year}-${pad(m[1])}-${pad(m[2])}`, clock: hour == null ? '' : `${pad(hour)}:${m[5]}` };
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, clock: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  function parseCsvDuration(raw) {
    const s = String(raw || '').trim();
    if (!/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return null;
    const parts = s.split(':').map(Number);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return Math.round(secs);
  }
  function parseCsvNumber(raw) {
    const s = String(raw == null ? '' : raw).replace(/,/g, '').trim();
    if (!s || s === '--') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function classifyActivity(typeRaw) {
    const t = String(typeRaw || '').toLowerCase();
    if (/run/.test(t)) return { kind: 'run' };
    if (/strength|weight|gym/.test(t)) return { kind: 'lift' };
    if (/stair|floor climb/.test(t)) return { kind: 'cardio', machine: 'Stairmaster' };
    if (/cycl|bike|biking|spin/.test(t)) return { kind: 'cardio', machine: 'Bike' };
    if (/walk|hik/.test(t)) return { kind: 'walk' };
    return { kind: 'other' };
  }
  function parseGarminCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 1) return { error: 'That file is empty.' };
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = {};
    Object.keys(CSV_COLUMNS).forEach((k) => {
      col[k] = CSV_COLUMNS[k].map((name) => header.indexOf(name)).find((i) => i >= 0);
    });
    const missing = [];
    if (col.date === undefined) missing.push('Date');
    if (col.type === undefined) missing.push('Activity Type');
    if (col.time === undefined) missing.push('Time');
    if (missing.length) return { error: `This doesn't look like a Garmin activities export. It's missing the ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}.`, columns: rows[0] };
    const headerKm = col.distance !== undefined && /km/.test(header[col.distance]);
    const activities = [];
    let unreadable = 0;
    rows.slice(1).forEach((r) => {
      const when = parseCsvDate(r[col.date]);
      const seconds = parseCsvDuration(r[col.time]);
      if (!when || seconds == null) { unreadable++; return; }
      const typeRaw = String(r[col.type] || '').trim();
      const cls = classifyActivity(typeRaw);
      const dist = col.distance === undefined ? null : parseCsvNumber(r[col.distance]);
      activities.push({
        key: `${when.date}|${when.clock}|${cls.kind}|${seconds}`,
        date: when.date,
        clock: when.clock,
        typeRaw,
        kind: cls.kind,
        machine: cls.machine,
        name: col.title === undefined ? typeRaw : String(r[col.title] || typeRaw).trim(),
        distanceRaw: dist,
        seconds,
        hr: col.hr === undefined ? null : parseCsvNumber(r[col.hr])
      });
    });
    activities.sort((a, b) => (a.date + a.clock < b.date + b.clock ? -1 : 1));
    return { activities, unreadable, unit: headerKm ? 'km' : 'mi', total: rows.length - 1 };
  }
  /* Easy days usually stay under about 150 bpm for you. It's only a starting answer,
     and you can change it on the review screen. */
  const talkFromHr = (hr) => (hr == null ? null : hr <= 150 ? 'pass' : 'fail');
  function finishedPlan(session, a, distance) {
    const run = session.run;
    if (!run) return true;
    if (run.kind === 'distance') return distance >= run.miles * 0.85;
    if (run.kind === 'minutes') return a.seconds >= run.minutes * 60 * 0.85;
    return a.seconds >= session.minutes * 60 * 0.85;
  }
  function planGarminImport(state, activities, unit, today) {
    const used = new Set();
    const factor = unit === 'km' ? 0.621371 : 1;
    const items = activities.map((a) => {
      const distance = a.distanceRaw == null ? 0 : Math.round(a.distanceRaw * factor * 100) / 100;
      const item = { activity: a, distance, status: 'other', sessionId: null, title: '', talk: null, completed: true, hard: false };
      if (state.garminSeen && state.garminSeen[a.key]) { item.status = 'dup'; return item; }
      if (a.date > today) { item.status = 'other'; return item; }
      const w = weekOf(a.date);
      if (w < -1) {
        item.status = a.kind === 'run' && distance > 0 ? 'baseline' : 'other';
        item.talk = talkFromHr(a.hr);
        return item;
      }
      if (w > LAST_WEEK) return item;
      const week = buildWeek(state, w, today);
      if (a.kind === 'walk') {
        const sunday = week.days[6];
        if (w >= 0 && a.date === sunday.date && sunday.type === 'recovery' && a.seconds >= 600) {
          item.status = 'walk';
          item.sessionId = sunday.id;
          item.title = 'Sunday walk';
        }
        return item;
      }
      if (a.kind === 'other') return item;
      const sameDay = week.days.find((s) => s.date === a.date && s.type === a.kind);
      if (sameDay && state.logs[sameDay.id] && state.logs[sameDay.id].source !== 'garmin') {
        item.status = 'manual';
        item.sessionId = sameDay.id;
        item.title = sameDay.title;
        return item;
      }
      const open = week.days
        .filter((s) => s.type === a.kind && !state.logs[s.id] && !used.has(s.id))
        .sort((x, y) => Math.abs(diffDays(x.date, a.date)) - Math.abs(diffDays(y.date, a.date)) || (x.date < y.date ? -1 : 1));
      if (!open.length) {
        if (a.kind === 'run' && distance > 0) {
          item.status = 'extra';
          item.title = 'Extra run';
          item.talk = talkFromHr(a.hr);
        }
        return item;
      }
      const s = open[0];
      used.add(s.id);
      item.status = 'match';
      item.sessionId = s.id;
      item.title = s.title;
      item.sessionDate = s.date;
      if (a.kind !== 'lift') item.talk = talkFromHr(a.hr);
      if (a.kind === 'run') {
        item.completed = finishedPlan(s, a, distance);
        item.hard = s.run.effort === 'test' || (s.run.effort === 'race' && s.run.miles > 20);
      }
      return item;
    });
    return items;
  }
  function applyGarminImport(state, items, today) {
    const paceBefore = runStats(state, today);
    const undo = { logIds: [], walkIds: [], extraKeys: [], seenKeys: [] };
    const out = { runs: 0, cardio: 0, lifts: 0, walks: 0, extras: 0, baseline: 0, skipped: 0 };
    const touchedWeeks = new Set();
    state.extras = state.extras || [];
    state.garminSeen = state.garminSeen || {};
    items.forEach((it) => {
      const a = it.activity;
      if (it.status === 'dup') { out.skipped++; return; }
      if (it.status === 'manual') { out.skipped++; }
      state.garminSeen[a.key] = true;
      undo.seenKeys.push(a.key);
      if (it.status === 'match') {
        touchedWeeks.add(weekOf(a.date));
        undo.logIds.push(it.sessionId);
        delete state.drafts[it.sessionId];
        if (a.kind === 'run') {
          state.logs[it.sessionId] = { type: 'run', date: a.date, distance: it.distance, seconds: a.seconds, hr: a.hr, talk: it.talk, completed: it.completed, hard: !!it.hard, source: 'garmin' };
          out.runs++;
        } else if (a.kind === 'cardio') {
          state.logs[it.sessionId] = { type: 'cardio', date: a.date, machine: a.machine, minutes: Math.round(a.seconds / 60), talk: it.talk, hr: a.hr, source: 'garmin' };
          out.cardio++;
        } else {
          state.logs[it.sessionId] = { type: 'lift', date: a.date, exercises: {}, minutes: Math.round(a.seconds / 60), hr: a.hr, source: 'garmin' };
          out.lifts++;
        }
      } else if (it.status === 'walk') {
        const log = state.logs[it.sessionId] || { type: 'recovery', items: {} };
        log.items = log.items || {};
        if (!log.items.walk) { log.items.walk = true; undo.walkIds.push(it.sessionId); }
        state.logs[it.sessionId] = log;
        out.walks++;
      } else if (it.status === 'extra' || it.status === 'baseline') {
        state.extras.push({ key: a.key, date: a.date, kind: 'run', name: a.name, distance: it.distance, seconds: a.seconds, hr: a.hr, talk: it.talk, hard: !!it.hard });
        undo.extraKeys.push(a.key);
        if (it.status === 'extra') { out.extras++; touchedWeeks.add(weekOf(a.date)); }
        else out.baseline++;
      }
    });
    state.lastImport = undo;
    const paceAfter = runStats(state, today);
    const notes = [];
    const holds = items.some((it) => {
      if (it.status !== 'match' || it.activity.kind !== 'run') return false;
      const w = weekOf(it.activity.date);
      return w >= 0 && w !== FINALS_WEEK && w !== TRAVEL_WEEK && (it.talk === 'fail' || it.completed === false);
    });
    if (holds) notes.push('A run came in unfinished or above the talk test, so your running holds at this step before moving on. If that\'s wrong, open the run on the Train tab and change your answer.');
    touchedWeeks.forEach((w) => {
      if (w < 0) return;
      const s = weekSummary(state, w, today);
      const plan = plannedMiles(state, w, today);
      if (s.miles > plan * 1.25 && s.miles - plan >= 2) notes.push(`Week ${w + 1} came in at ${s.miles} miles against ${plan} planned. Your mileage plan stays the same, so try not to stack extra miles on top of it.`);
    });
    out.paceBefore = paceBefore;
    out.paceAfter = paceAfter;
    out.notes = notes;
    return out;
  }
  function undoGarminImport(state) {
    const u = state.lastImport;
    if (!u) return false;
    u.logIds.forEach((id) => { delete state.logs[id]; });
    u.walkIds.forEach((id) => { if (state.logs[id] && state.logs[id].items) state.logs[id].items.walk = false; });
    state.extras = (state.extras || []).filter((x) => !u.extraKeys.includes(x.key));
    u.seenKeys.forEach((k) => { delete state.garminSeen[k]; });
    state.lastImport = null;
    return true;
  }
  /* Running history from before the plan, summed over the last 8 weeks before it starts. */
  function garminBaseline(state) {
    const from = addDays(START, -56);
    const runs = (state.extras || []).filter((x) => x.kind === 'run' && x.date < START && x.date >= from);
    runLogs(state).forEach(({ log, extra, w }) => { if (!extra && w < 0 && log.distance) runs.push({ distance: log.distance, seconds: log.seconds, date: log.date }); });
    if (!runs.length) return null;
    const miles = runs.reduce((acc, r) => acc + r.distance, 0);
    const seconds = runs.reduce((acc, r) => acc + r.seconds, 0);
    return {
      count: runs.length,
      weeklyMiles: Math.round((miles / 8) * 10) / 10,
      longest: Math.max(...runs.map((r) => r.distance)),
      avgPace: seconds / miles
    };
  }

  /* ---------- Check-in timing ---------- */
  const checkinDate = (w) => dateOf(w, 6);
  const waistDue = (w) => w % 2 === 0;
  function dueCheckin(state, today) {
    const w = weekOf(today);
    if (w < 0) return null;
    const candidate = dayIndex(today) === 6 ? w : w - 1;
    if (candidate < 0 || candidate > LAST_WEEK) return null;
    if (state.checkins.some((c) => c.week === candidate)) return null;
    return { week: candidate, date: checkinDate(candidate), overdue: candidate < w };
  }
  function nextCheckinWeek(state, today) {
    const due = dueCheckin(state, today);
    if (due) return due.week;
    const w = Math.max(0, weekOf(today));
    return state.checkins.some((c) => c.week === w) ? w + 1 : w;
  }
  function checkinInstructions(state, w) {
    const steps = [
      { title: 'Import your Garmin activities', text: 'Export your activities CSV from the Garmin Connect website, then tap Import Garmin CSV at the top of the check-in. This fills in your runs and cardio.' },
      { title: 'Check your average weight', text: 'The app averages your Monday, Wednesday, and Friday morning weigh-ins. Fix anything that looks off.' }
    ];
    if (waistDue(w)) steps.push({ title: 'Measure your waist', text: 'Before breakfast, in centimeters, at the same spot as last time, after a normal breath out.' });
    steps.push(
      { title: 'Confirm your training', text: 'Check the sessions, mileage, longest run, and talk tests the app counted.' },
      { title: 'Confirm your recovery', text: 'Check average sleep and sleep-device nights, then rate energy, soreness, and cravings from 1 to 10.' },
      { title: 'Note anything that hurt', text: 'Record any pain and anything that made the week hard.' },
      { title: 'Review and apply', text: 'Look over any changes to calories, macros, and training, then shop and meal prep from the updated plan.' }
    );
    return steps;
  }

  /* ---------- The weekly check-in rules ---------- */
  const CALORIE_FLOOR = 2100;
  const FUEL_START_WEEK = 30; // the check-in on Sunday, June 13
  function evaluateCheckin(state, data, today) {
    const w = data.week;
    const before = JSON.parse(JSON.stringify(state.targets));
    const after = JSON.parse(JSON.stringify(state.targets));
    const summary = weekSummary(state, w, today);
    const changes = [];
    const notes = [];
    const alerts = [];

    if (data.symptoms) {
      alerts.push({ level: 'critical', title: 'Stop training and get checked', text: 'You reported chest pain, fainting, or unusual shortness of breath. Get medical care before you train again. No training goals changed.' });
    }
    if (data.pain) {
      alerts.push({ level: 'warning', title: 'Pain noted', text: 'If it is sharp or changes how you run, stop running and use the bike if it does not hurt. See a doctor or physical therapist if it lasts more than a few days.' });
    }

    const travel = w === TRAVEL_WEEK;
    const prior = state.checkins.filter((c) => c.week < w).sort((a, b) => a.week - b.week);
    const history = [...prior.map((c) => ({ week: c.week, weight: c.data.weightAvg, followed: c.followed, energy: c.data.energy, soreness: c.data.soreness, missed: c.summary.missed, travel: c.week === TRAVEL_WEEK, changedCalories: c.after.calories !== c.before.calories }))];
    const weight = data.weightAvg == null || data.weightAvg === '' ? null : Number(data.weightAvg);
    const followed = data.food === 'mostly' && summary.missed <= 1;
    const current = { week: w, weight, followed, energy: Number(data.energy), soreness: Number(data.soreness), missed: summary.missed, travel, changedCalories: false };
    const rows = [...history.filter((h) => !h.travel), ...(travel ? [] : [current])];
    const rates = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.weight == null || b.weight == null) { rates.push(null); continue; }
      rates.push({ week: b.week, loss: (a.weight - b.weight) / Math.max(1, b.week - a.week), followed: b.followed });
    }
    const lastN = (n) => rates.slice(-n);
    const allValid = (arr, n) => arr.length === n && arr.every((r) => r);
    const lossRate = rates.length && rates[rates.length - 1] ? rates[rates.length - 1].loss : null;

    let calorieDelta = 0;
    let calReason = null;
    const addChange = (c) => changes.push(c);

    if (travel) {
      notes.push('Travel week: nothing changes. Enjoy the trip and pick the plan back up when you get home.');
    } else {
      /* Fat-loss to fuel switch */
      if (!after.maintenance && w >= FUEL_START_WEEK) {
        after.maintenance = true;
        calorieDelta += 450;
        calReason = 'Your fat-loss phase ends here. Calories rise to an estimated maintenance level to support the marathon block.';
      }

      /* Lasting fatigue or falling lifts */
      const prev = history.filter((h) => !h.travel).slice(-1)[0];
      const lastingFatigue = prev && ((current.energy <= 3 && prev.energy <= 3) || (current.soreness >= 8 && prev.soreness >= 8));
      const ls = liftState(state);
      const down = liftsDown(ls, today);
      if (lastingFatigue || down) {
        calorieDelta += 200;
        calReason = calReason || (down ? 'Two or more main lifts are down over 10%.' : 'Fatigue has lasted two weeks.');
        if (!after.deloadWeeks.includes(w + 1) && !isScheduledDeload(w + 1)) after.deloadWeeks.push(w + 1);
        addChange({ kind: 'training', title: 'Next week is a deload', detail: 'Lifting drops to 2 sets per exercise with at least 3 reps left, and running drops about 25%.' });
      }

      if (!after.maintenance || w === FUEL_START_WEEK) {
        /* Losing too fast */
        const fast = lastN(2);
        const tooFast = allValid(fast, 2) && fast.every((r) => r.loss > 1.5);
        if (tooFast && calorieDelta < 200 && !after.maintenance) {
          calorieDelta += 200;
          calReason = calReason || 'You have lost over 1.5 lb a week for 2 weeks, which is faster than this plan wants.';
        }
        /* Stalled with the plan followed */
        const slow = lastN(3);
        const recentChange = history.slice(-2).some((h) => h.changedCalories);
        const stalled = allValid(slow, 3) && slow.every((r) => r.loss < 0.25 && r.followed) && !recentChange;
        if (stalled && calorieDelta === 0 && !after.maintenance) {
          if (Number(data.cravings) >= 7) {
            notes.push('Weight has been flat, but cravings are high, so calories stay put while meal timing changes first.');
          } else if (Number(data.energy) < 5 || after.calories - 125 < CALORIE_FLOOR) {
            after.walkMin = 20;
            addChange({ kind: 'nutrition', title: 'Add a 20-minute walk each day', detail: 'Weight has been flat for 3 weeks with the plan followed. Energy or calories leave no room to eat less, so you move a little more instead.' });
          } else {
            calorieDelta -= 125;
            calReason = 'Weight has been flat for 3 weeks with the plan followed.';
          }
        }
      } else {
        /* Maintenance: hold weight steady */
        const pair = lastN(2);
        if (allValid(pair, 2) && pair.every((r) => r.loss > 0.5) && calorieDelta === 0) {
          calorieDelta += 150;
          calReason = 'Weight has kept dropping during marathon training, so you need more fuel.';
        } else if (allValid(pair, 2) && pair.every((r) => r.loss < -0.5) && calorieDelta === 0) {
          calorieDelta -= 100;
          calReason = 'Weight has crept up for 2 weeks during maintenance.';
        }
      }

      /* Missed sessions */
      const prevMissed = prev ? prev.missed : 0;
      if (summary.missed >= 2 && prevMissed >= 2 && !after.bareWeeks.includes(w + 1) && !state.targets.bareWeeks.includes(w)) {
        after.bareWeeks.push(w + 1);
        addChange({ kind: 'training', title: 'Next week is a bare-minimum week', detail: 'Do Upper A, Lower, the Tuesday run, and the Saturday run. That week still counts as a win, and the full plan returns the week after.' });
      }

      /* Cravings */
      if (Number(data.cravings) >= 7 && !after.mealShift) {
        after.mealShift = true;
        addChange({ kind: 'nutrition', title: 'More of your food moves to the evening', detail: 'Strong cravings most nights usually call for timing and portions before willpower. 1/2 cup of lunch rice moves to dinner, with no change in calories.' });
      } else if (Number(data.cravings) >= 7) {
        notes.push('Cravings stayed strong even with more food at dinner. A Ryse shake is still your backup, and it is worth looking at how sleep and stress lined up this week.');
      } else if (after.mealShift && Number(data.cravings) <= 3 && Number(state.checkins.slice(-1)[0] && state.checkins.slice(-1)[0].data.cravings) <= 3) {
        after.mealShift = false;
        addChange({ kind: 'nutrition', title: 'Meal timing returns to normal', detail: 'Cravings have stayed low for 2 weeks, so 1/2 cup of rice moves back to lunch.' });
      }

      /* Tracking that backfires */
      if (data.trackingBackfired && after.mode !== 'portions') {
        after.mode = 'portions';
        addChange({ kind: 'nutrition', title: 'You are switching to portion guides', detail: 'Tracking was causing guilt, skipped meals, or extra exercise, so calories and weighing come off your screens. You can turn tracking back on in Settings.' });
      }
    }

    if (calorieDelta !== 0) {
      const next = Math.max(CALORIE_FLOOR, before.calories + calorieDelta);
      after.calories = next;
      const m0 = macros(before);
      const m1 = macros(after);
      if (after.mode === 'portions') addChange({ kind: 'calories', title: next > before.calories ? 'Your rice portions go up' : 'Your rice portions come down a little', detail: calReason });
      else addChange({
        kind: 'calories',
        title: `Daily calories: ${before.calories.toLocaleString('en-US')} to ${next.toLocaleString('en-US')}`,
        detail: `${calReason} Carbs move from ${m0.carbLo}-${m0.carbHi} g to ${m1.carbLo}-${m1.carbHi} g, and your rice portions update. Protein and fat stay the same.`
      });
    }

    if (!changes.length && !travel && !data.symptoms) {
      if (weight == null) notes.push('No weight this week, so calories and macros stay where they are.');
      else if (rows.length < 2) notes.push('This sets your baseline. Next week the app starts comparing your numbers.');
      else notes.push('Everything is on track, so your targets stay the same.');
    }

    return { before, after, changes, notes, alerts, summary, followed, lossRate };
  }

  function buildCheckinRecord(state, data, today) {
    const r = evaluateCheckin(state, data, today);
    const stats = runStats(state, today);
    return { week: data.week, date: today, data, summary: r.summary, followed: r.followed, lossRate: r.lossRate, before: r.before, after: r.after, changes: r.changes, notes: r.notes, alerts: r.alerts, liftChanges: liftChanges(state, data.week), easyPace: `${fmtPace(stats.easyLo)} to ${fmtPace(stats.easyHi)}` };
  }

  function checkinSummaryText(rec) {
    const d = rec.data;
    const s = rec.summary;
    const lines = [
      `Weekly check-in, week ${rec.week + 1} (${fmtDate(checkinDate(rec.week))})`,
      `Average weight: ${d.weightAvg == null || d.weightAvg === '' ? 'not logged' : d.weightAvg + ' lb'}`,
      `Waist: ${d.waist ? d.waist + ' cm' : 'not measured'}`,
      `Sessions: ${s.done} of ${s.planned}`,
      `Miles: ${s.miles}, longest run ${s.longest} mi, talk-test fails ${s.talkFails}`,
      `Average sleep: ${d.sleepAvg == null || d.sleepAvg === '' ? 'not logged' : d.sleepAvg + ' h'}, sleep-device nights: ${d.apapNights == null || d.apapNights === '' ? 'not logged' : d.apapNights}`,
      `Energy ${d.energy}/10, soreness ${d.soreness}/10, cravings ${d.cravings}/10`,
      `Followed meal plan: ${d.food}`,
      `Pain: ${d.pain ? 'yes' : 'no'}${d.notes ? `. Notes: ${d.notes}` : ''}`,
      `Calories now ${rec.after.calories}`,
      ...rec.changes.map((c) => `Change: ${c.title}`)
    ];
    return lines.join('\n');
  }

  /* ---------- Checkpoints ---------- */
  const CHECKPOINTS = [
    { date: '2027-02-07', weight: [195, 198], waist: [88, 90], run: 'Run 3 miles without stopping. Under 9:00 per mile is the stretch goal.', strength: 'Match or beat your current best sets' },
    { date: '2027-05-02', weight: [186, 191], waist: [84, 87], run: 'Finish the Motor City Half on April 25 at an easy effort.', strength: 'Keep climbing toward your June 13 lift goals' },
    { date: '2027-10-17', weight: [180, 188], waist: null, run: 'Finish healthy first, then under 4:00, with 3:30 as the stretch goal.', strength: 'Hold your June lift numbers within about 5%' }
  ];
  const nextCheckpoint = (today) => CHECKPOINTS.find((c) => c.date >= today) || CHECKPOINTS[CHECKPOINTS.length - 1];

  /* ---------- Calendar file ---------- */
  function buildIcs(state, fromWeek, count, today) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
    const addMin = (date, time, mins) => {
      const [h, m] = time.split(':').map(Number);
      const t = h * 60 + m + mins;
      return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
    };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Detroit 26.2//EN', 'CALSCALE:GREGORIAN'];
    const push = (uid, date, time, mins, title, desc) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}@detroit262`, `DTSTAMP:${date.replace(/-/g, '')}T000000Z`, `DTSTART:${stamp(date, time)}`, `DTEND:${stamp(date, addMin(date, time, mins))}`, `SUMMARY:${title}`, `DESCRIPTION:${desc}`, 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'END:VALARM', 'END:VEVENT');
    };
    for (let w = Math.max(0, fromWeek); w < Math.min(LAST_WEEK + 1, fromWeek + count); w++) {
      const week = buildWeek(state, w, today);
      week.days.forEach((s) => {
        if (!s.time || s.skippedForBare || s.minutes <= 0) return;
        push(s.id, s.date, s.time, s.minutes, s.title, (s.subtitle || '').replace(/,/g, '\\,'));
      });
      push(`checkin${w}`, checkinDate(w), state.checkinTime, 20, 'Weekly check-in', 'Open the Detroit 26.2 app and complete your check-in before breakfast.');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  return {
    START, RACE, HALF, LAST_WEEK, TRAVEL_WEEK, FINALS_WEEK, EX, LIFTS, STRENGTH_BESTS, STRENGTH_GOALS, DAY_NAMES, DAY_SHORT, CHECKPOINTS, CALORIE_FLOOR,
    addDays, diffDays, fmtDate, dayIndex, weekOf, weekStart, dateOf, fmtPace, fmtDur, fmtTime, e1rm, increment,
    initialState, phaseOf, buildWeek, liftState, macros, mealPlan, trackingToday, longRunFuel, readiness, backOff,
    parseCsv, parseGarminCsv, planGarminImport, applyGarminImport, undoGarminImport, garminBaseline, loadText, liftChanges, foodTotals, rangeStatus, scaleFood, caloriesFromMacros, exerciseHistory, weekSummary, plannedMiles, checkinDate, waistDue, dueCheckin, nextCheckinWeek, checkinInstructions, evaluateCheckin,
    buildCheckinRecord, checkinSummaryText, nextCheckpoint, runStats, runShift, countsAsPlanned, buildIcs, isScheduledDeload, MARATHON_TIERS
  };
});
