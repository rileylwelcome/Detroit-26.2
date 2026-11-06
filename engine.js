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
    incline: { name: 'Incline barbell bench', kind: 'weight', group: 'upper', sets: 3, min: 6, max: 8, start: 190, big: true, core: true },
    row: { name: 'Barbell row', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10, start: 165, big: true, core: true },
    ohp: { name: 'Overhead press', kind: 'weight', group: 'upper', sets: 3, min: 6, max: 8, start: 110, big: true, core: true },
    pulldown: { name: 'Lat pulldown', kind: 'weight', group: 'upper', sets: 3, min: 10, max: 12, core: true },
    fly: { name: 'Cable fly', kind: 'weight', group: 'upper', sets: 2, min: 12, max: 15 },
    lateralA: { name: 'Lateral raise', kind: 'weight', group: 'upper', sets: 2, min: 12, max: 15 },
    curl: { name: 'Cable curl', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    pushdown: { name: 'Triceps pushdown', kind: 'weight', group: 'upper', sets: 2, min: 10, max: 12 },
    hack: { name: 'Hack squat', kind: 'weight', group: 'lower', sets: 3, min: 6, max: 8, start: 210, big: true, core: true },
    rdl: { name: 'Romanian deadlift', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 10, start: 135, big: true, core: true },
    lunge: { name: 'Walking lunge', kind: 'weight', group: 'lower', sets: 2, min: 10, max: 10, start: 0, inc: 5, perLeg: true },
    legcurl: { name: 'Seated leg curl', kind: 'weight', group: 'lower', sets: 3, min: 10, max: 12 },
    calf: { name: 'Standing calf raise', kind: 'weight', group: 'lower', sets: 3, min: 12, max: 15 },
    plank: { name: 'Plank', kind: 'time', group: 'lower', sets: 3, min: 30, max: 45, start: 30 },
    csrow: { name: 'Chest-supported row', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10, core: true },
    dbpress: { name: 'Flat dumbbell press', kind: 'weight', group: 'upper', sets: 3, min: 8, max: 10, core: true },
    pullup: { name: 'Pull-up or assisted pull-up', kind: 'assist', group: 'upper', sets: 3, min: 6, max: 10, core: true },
    squatjump: { name: 'Bodyweight squat jump', kind: 'power', group: 'lower', sets: 3, min: 5, max: 5 },
    machpress: { name: 'Machine shoulder press', kind: 'weight', group: 'upper', sets: 2, min: 8, max: 10, core: true },
    legpress: { name: 'Leg press', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 12, core: true },
    hipthrust: { name: 'Hip thrust', kind: 'weight', group: 'lower', sets: 3, min: 8, max: 12, core: true },
    legext: { name: 'Leg extension', kind: 'weight', group: 'lower', sets: 3, min: 10, max: 15 },
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
    lowerA: { name: 'Lower A', list: ['hack', 'rdl', 'lunge', 'legcurl', 'calf', 'plank'] },
    push: { name: 'Push', list: ['incline', 'ohp', 'machpress', 'fly', 'lateralA', 'pushdown'] },
    pull: { name: 'Pull', list: ['row', 'pulldown', 'csrow', 'reardelt', 'curl'] },
    lowerB: { name: 'Lower B', list: ['legpress', 'hipthrust', 'legext', 'legcurl', 'calf'] },
    upper: { name: 'Upper', list: ['dbpress', 'pullup', 'cablerow', 'lateralB', 'overheadext', 'hammer'] },
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
  /* The NSCA %1RM-by-reps table. Between listed rep counts, the value is interpolated. */
  const PCT_BY_REPS = [[1, 1], [2, 0.95], [3, 0.93], [4, 0.9], [5, 0.87], [6, 0.85], [7, 0.83], [8, 0.8], [9, 0.77], [10, 0.75], [11, 0.7], [12, 0.67], [15, 0.65]];
  function pctFromReps(r) {
    const reps = Number(r);
    if (!(reps > 0)) return 1;
    if (reps >= 15) return 0.65;
    for (let i = 1; i < PCT_BY_REPS.length; i++) {
      const [r1, p1] = PCT_BY_REPS[i - 1];
      const [r2, p2] = PCT_BY_REPS[i];
      if (reps <= r2) return p1 + ((reps - r1) / (r2 - r1)) * (p2 - p1);
    }
    return 0.65;
  }
  const e1rm = (w, r) => (Number(w) || 0) / pctFromReps(r);

  /* ---------- Starting state ---------- */
  function initialState() {
    return {
      version: 1,
      times: ['08:00', '08:00', '08:00', '08:00', '09:00', '09:00', null],
      checkinTime: '09:00',
      pmTime: '16:00',
      targets: {
        calories: 2800,
        protein: 165,
        fat: 72,
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
      addons: {},
      extras: [],
      garminSeen: {},
      lastImport: null,
      checkins: [],
      checklist: {},
      drafts: {},
      sessionOverrides: {},
      loadEdits: [],
      aiExplanations: {}
    };
  }

  /* ---------- Phases ---------- */
  const PHASES = [
    { key: 'foundation', name: 'Off-season: hypertrophy, ease in', from: 0, to: 5 },
    { key: 'base', name: 'Off-season: hypertrophy, build', from: 6, to: 17 },
    { key: 'speed', name: 'Off-season: heavier hypertrophy', from: 18, to: 30 },
    { key: 'block', name: 'Preseason: hypertrophy, 4 lifting days', from: 31, to: 45 },
    { key: 'taper', name: 'In-season: taper', from: 46, to: 48 }
  ];
  const phaseOf = (w) => PHASES.find((p) => w >= p.from && w <= p.to) || (w < 0 ? PHASES[0] : PHASES[4]);
  const TRAVEL_WEEK = 8; // Jan 4-11
  const FINALS_WEEK = 5; // Dec 14-17
  const isScheduledDeload = (w) => w >= 0 && (w + 1) % 6 === 0;

  /* Running minutes rise no more than 10% a week: 38, 41, 45, 49, 52. */
  const FOUNDATION = [
    { mid: [6, 3, 2], mon: 30, sat: [5, 4, 2] },
    { mid: [5, 4, 2], mon: 33, sat: [7, 3, 2] },
    { mid: [5, 4, 2], mon: 36, sat: [5, 5, 2] },
    { mid: [4, 6, 2], mon: 39, sat: [5, 5, 2] },
    { mid: [4, 6, 2], mon: 42, sat: [4, 7, 2] }
  ];
  const FINALS = { mid: [3, 6, 2], mon: 25, satMinutes: 24 };

  /* Physique-focused variables, within the NSCA hypertrophy range of 67-85% 1RM, 6-12 reps, 3-6 sets, and 30-90 sec rest. */
  const LIFT_SCHEMES = {
    foundation: { label: 'Hypertrophy, ease in', core: { sets: 3, goal: 8, pct: 0.75, rest: '60-90 sec' }, assist: { sets: 3, goal: 10, rest: '60-90 sec' } },
    base: { label: 'Hypertrophy, build', core: { sets: 4, goal: 8, pct: 0.77, rest: '60-90 sec' }, assist: { sets: 3, goal: 10, rest: '60-90 sec' } },
    speed: { label: 'Heavier hypertrophy', core: { sets: 4, goal: 6, pct: 0.82, rest: '90 sec' }, assist: { sets: 3, goal: 10, rest: '60-90 sec' } },
    block: { label: 'Preseason hypertrophy', core: { sets: 3, goal: 8, pct: 0.77, rest: '60-90 sec' }, assist: { sets: 2, goal: 10, rest: '60-90 sec' } },
    taper: { label: 'Taper', core: { sets: 2, goal: 6, pct: 0.7, rest: '90 sec' }, assist: { sets: 1, goal: 10, rest: '60-90 sec' } }
  };
  function schemeFor(w, id, deload) {
    const ex = EX[id];
    const phase = LIFT_SCHEMES[phaseOf(Math.max(0, w)).key];
    const part = ex.core ? phase.core : phase.assist;
    const sets = deload ? Math.min(2, part.sets) : part.sets;
    return { sets, goal: ex.kind === 'time' ? null : part.goal, pct: part.pct || null, rest: part.rest, label: phase.label, core: !!ex.core };
  }

  /* ---------- Running progress ----------
     A week that misses its heart-rate target, comes in incomplete, or has no logged runs
     is repeated: every later week's mileage slides back one step. */
  function runIdsOf(w) {
    if (w < 6) return [`w${w}d2b`, `w${w}d5`];
    if (w < 31) return [`w${w}d0b`, `w${w}d2b`, `w${w}d5`];
    return [`w${w}d0b`, `w${w}d2b`, `w${w}d3`, `w${w}d5`];
  }
  function runShift(state, w, today) {
    let shift = 0;
    for (let i = 0; i < w; i++) {
      if (i === FINALS_WEEK || i === TRAVEL_WEEK) continue;
      if (today && dateOf(i, 6) >= today) continue;
      const logs = runIdsOf(i).map((id) => state.logs[id]).filter((l) => l && l.type === 'run');
      const failed = logs.some((l) => l.talk === 'fail' || l.completed === false);
      if (failed || (today && !logs.length)) shift++;
    }
    return shift;
  }
  /* Weekly mileage and the long run each rise no more than 10% a week, up to each season's ceiling. */
  const MILEAGE = (() => {
    const curve = (e, x0, x1, y0, y1) => lerp(y0, y1, (e - x0) / (x1 - x0));
    const ceilingWeek = (e) => (e <= 17 ? curve(e, 6, 17, 12, 20) : e <= 30 ? curve(e, 18, 30, 20, 28) : curve(e, 31, 45, 28, 40));
    const ceilingLong = (e) => (e <= 17 ? curve(e, 6, 17, 5, 8) : e <= 30 ? curve(e, 18, 30, 8, 12) : curve(e, 31, 45, 12, 20));
    const table = {};
    let week = 4.7;
    let long = 2.6;
    for (let e = 6; e <= 45; e++) {
      if (e > 6) {
        week = Math.floor(Math.min(ceilingWeek(e), week * 1.1) * 10) / 10;
        long = Math.floor(Math.min(ceilingLong(e), long * 1.1) * 10) / 10;
      }
      table[e] = { week, long };
    }
    return table;
  })();
  function milesFor(e) {
    return MILEAGE[clamp(Math.round(e), 6, 45)];
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
      const m = /^w(-?\d+)d(\d)(b?)$/.exec(id);
      if (!m) return;
      out.push({ id, w: Number(m[1]), d: Number(m[2]), second: m[3] === 'b', log });
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
    logs.forEach(({ w, d, log, extra, second }) => {
      const session = extra ? { run: { kind: 'distance' } } : sessionFromLog(state, w, d, today, second);
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
    { label: 'Under 4:30', sec: 4.5 * 3600 },
    { label: 'Under 4:00 stretch', sec: 4 * 3600 }
  ];
  function marathonGoalPace(stats) {
    if (stats.prediction) {
      const p = stats.prediction.marathon / 26.2;
      return clamp(p, 480, 660); // keeps a marathon-pace estimate within a sensible range
    }
    return 549; // 9:09, the pace of a 4:00 marathon
  }

  /* Age-predicted max of 196 (220 minus 24). Long, slow distance is about 70-80% of that. */
  const HR = { max: 196, easyLo: 137, easyHi: 157, fartlekLo: 167, fartlekHi: 176, intervalLo: 176 };
  const HARD_EFFORTS = ['tempo', 'interval', 'fartlek', 'test'];
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
        detail: `Finish every interval, with your heart rate at ${HR.easyLo}-${HR.easyHi} bpm while running. Expect a running pace of ${fmtPace(lo)} to ${fmtPace(hi)} per mile and about ${dLo.toFixed(1)} to ${dHi.toFixed(1)} miles in total.`,
        lo: null, hi: null
      };
    }
    if (run.effort === 'test') {
      const g = run.goalSeconds;
      const stretch = run.miles === 3 ? `Run all 3 miles without stopping. The stretch goal is under ${fmtDur(g)}, or 9:00 per mile.` : `Run this hard but controlled. The target is ${fmtDur(g)} or close to it, your signal for a sub-4:00 stretch goal.`;
      return { headline: fmtDur(g), detail: stretch, lo: g, hi: g };
    }
    if (run.effort === 'race') {
      const label = 'Finish healthy first, then under 4:30, with under 4:00 as the stretch goal.';
      const projected = stats.prediction ? ` Current estimate: ${fmtDur(run.miles > 20 ? stats.prediction.marathon : stats.prediction.half)}.` : '';
      return { headline: `${run.miles} mi`, detail: label + projected, lo: null, hi: null };
    }
    let pLo = lo;
    let pHi = hi;
    let note = '';
    if (run.effort === 'long') {
      pLo = lo + 10;
      pHi = hi + 15;
      note = `Long, slow distance: keep your heart rate at ${HR.easyLo}-${HR.easyHi} bpm.`;
    } else if (run.effort === 'tempo') {
      note = `Warm up easy, then run ${run.tempoMin} minutes at a steady pace near your lactate threshold, hard but sustained. Finish easy.`;
    } else if (run.effort === 'interval') {
      note = `Warm up easy, then run ${run.reps} x ${run.workMin} minutes near maximal effort, at ${HR.intervalLo}+ bpm, with ${run.workMin} minutes of easy recovery after each. Finish easy.`;
    } else if (run.effort === 'fartlek') {
      note = `Fartlek: for ${run.fartlekMin} minutes, mix easy running with short faster bursts at ${HR.fartlekLo}-${HR.fartlekHi} bpm.`;
    } else if (run.effort === 'shakeout') {
      pLo = lo + 15;
      pHi = hi + 30;
      note = 'Short and relaxed, just enough to loosen up.';
    } else {
      note = `Keep your heart rate at ${HR.easyLo}-${HR.easyHi} bpm.`;
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
    return Object.assign({ id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'lift', lift: key, title: lift.name, minutes: 75, required: ['upperA', 'lower', 'lowerA', 'push', 'pull'].includes(key) }, opts || {});
  }
  function intervalsSession(w, d, spec, opts) {
    const [reps, run, walk] = spec;
    const minutes = reps * (run + walk) + 10;
    return Object.assign({
      id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'run', title: d === 5 ? 'Long run/walk' : 'Run/walk', minutes, required: d === 5,
      run: { kind: 'intervals', reps, run, walk, warm: 5, cool: 5 },
      subtitle: `${reps} x (${run} run, ${walk} walk)`
    }, opts || {});
  }
  function milesSession(w, d, miles, effort, title, extras, center) {
    const m = effort === 'race' || effort === 'test' ? miles : Math.round(miles * 10) / 10;
    return Object.assign({
      id: `w${w}d${d}`, w, d, date: dateOf(w, d), type: 'run', title, required: d === 5,
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
    const deload = !travel && w >= 0 && (isScheduledDeload(w) || targets.deloadWeeks.includes(w));
    const bare = targets.bareWeeks.includes(w);
    const phase = phaseOf(w);
    const shift = runShift(state, w, today);
    const stats = runStats(state, today);
    const center = stats.center;
    const days = [];
    const lift = (d, key, opts) => liftSession(w, d, key, opts);
    const light = { minutes: 40, subtitle: 'Light session' };
    /* An afternoon session on a lifting day, logged on its own. */
    const then = (morning, afternoon, required) => {
      morning.second = Object.assign(afternoon, { id: `w${w}d${morning.d}b`, part: 'b', required: !!required, time: state.pmTime || '16:00' });
      return morning;
    };

    if (w < 0) {
      // The days before the plan starts: log anything, nothing here is required.
      days.push(lift(0, 'upperA'));
      days.push(milesSession(w, 1, 3, 'easy', 'Easy run', null, center));
      days.push(lift(2, 'lower'));
      days.push(lift(3, 'upperB', { required: false }));
      days.push(cardioSession(w, 4, 30, 'stairs'));
      days.push(milesSession(w, 5, 3, 'easy', 'Easy run', null, center));
      days.push(restSession(w, 6));
    } else if (travel) {
      const trip = milesFor(w - Math.min(shift, 6));
      const tripMid = (trip.week - trip.long) / 2;
      days.push({ id: `w${w}d0`, w, d: 0, date: dateOf(w, 0), type: 'recovery', title: 'Travel day', minutes: 0, required: false, subtitle: 'Walk when you can' });
      days.push(milesSession(w, 1, tripMid, 'easy', 'Easy run', null, center));
      days.push(lift(2, 'travel', { minutes: 40, subtitle: "Use what's available", required: true }));
      days.push(milesSession(w, 3, tripMid, 'easy', 'Easy run', null, center));
      days.push(lift(4, 'travel', { minutes: 40, subtitle: "Use what's available", required: true }));
      days.push(milesSession(w, 5, trip.long, 'easy', 'Easy run', null, center));
      days.push(restSession(w, 6));
    } else if (w < 6) {
      const step = finals ? null : FOUNDATION[clamp(w - shift, 0, 4)];
      const repeated = !finals && w > 0 && shift > runShift(state, w - 1, today);
      days.push(then(lift(0, 'lowerA'), cardioSession(w, 0, finals ? FINALS.mon : step.mon, finals ? 'bike' : 'stairs')));
      days.push(lift(1, 'push'));
      days.push(then(lift(2, 'pull'), intervalsSession(w, 2, finals ? FINALS.mid : step.mid, repeated ? { repeated: true } : {}), true));
      days.push(lift(3, 'lowerB', { required: false }));
      days.push(lift(4, 'upper', { required: false }));
      days.push(finals
        ? { id: `w${w}d5`, w, d: 5, date: dateOf(w, 5), type: 'run', title: 'Easy run', minutes: FINALS.satMinutes, required: true, run: { kind: 'minutes', minutes: FINALS.satMinutes, effort: 'easy' }, subtitle: `${FINALS.satMinutes} min easy, walk if needed` }
        : intervalsSession(w, 5, step.sat, repeated ? { repeated: true } : {}));
      days.push(restSession(w, 6));
    } else {
      const heldBack = Math.min(shift, 6); // however long a gap, the plan resumes no more than 6 weeks behind
      let { week: miles, long } = milesFor(w - heldBack);
      if (phase.key === 'taper') {
        const peak = milesFor(45 - heldBack);
        miles = Math.min(peak.week, [32, 24, 16][w - 46]);
        long = Math.min(peak.long, [12, 10, 2][w - 46]);
      } else if (deload) {
        miles *= 0.75;
        long *= 0.75;
      }
      const raceWeek = w === LAST_WEEK;
      if (phase.key === 'base' || phase.key === 'speed') {
        const mondayRun = miles >= 10 || phase.key === 'speed';
        const mid = mondayRun ? (miles - long) / 2 : miles - long;
        const speed = phase.key === 'speed';
        const wedRun = speed && !deload && mid >= 3
          ? milesSession(w, 2, mid, 'fartlek', 'Fartlek run', { fartlekMin: Math.round(clamp((mid * center) / 60 - 10, 20, 60)) }, center)
          : milesSession(w, 2, mid, 'easy', 'Easy run', null, center);
        days.push(then(lift(0, 'lowerA'), mondayRun ? milesSession(w, 0, mid, 'easy', 'Easy run', null, center) : cardioSession(w, 0, 40, 'stairs')));
        days.push(lift(1, 'push'));
        days.push(then(lift(2, 'pull'), wedRun, true));
        days.push(lift(3, 'lowerB', { required: false }));
        days.push(lift(4, 'upper', { required: false }));
      } else if (raceWeek) {
        days.push(lift(0, 'push', { minutes: 30, subtitle: 'Light session', required: true }));
        days.push(milesSession(w, 1, 6, 'easy', 'Easy run', null, center));
        days.push({ id: `w${w}d2`, w, d: 2, date: dateOf(w, 2), type: 'recovery', title: 'Rest', minutes: 0, required: false, subtitle: 'Walk if you want to' });
        days.push(milesSession(w, 3, 5, 'easy', 'Easy run', null, center));
        days.push(milesSession(w, 4, 3, 'easy', 'Easy run', null, center));
      } else {
        const taper = phase.key === 'taper';
        const mid = (miles - long) / 3;
        const opts = taper ? light : {};
        const intervalWeek = (w - 31) % 2 === 1;
        const wedRun = deload || mid < 4 ? milesSession(w, 2, mid, 'easy', 'Easy run', null, center)
          : intervalWeek && !taper ? milesSession(w, 2, mid, 'interval', 'Interval run', { reps: 5, workMin: 4 }, center)
            : milesSession(w, 2, mid, 'tempo', 'Tempo run', { tempoMin: taper ? 20 : Math.round(lerp(20, 30, clamp((w - 31) / 14, 0, 1))) }, center);
        const secondWeek = w === 47;
        if (secondWeek) days.push({ id: `w${w}d0`, w, d: 0, date: dateOf(w, 0), type: 'run', title: 'Easy run', required: false, minutes: round5((mid * center) / 60) + 10, run: { kind: 'distance', miles: Math.round(mid * 10) / 10, effort: 'easy', warm: 0, cool: 0 }, subtitle: `${Math.round(mid * 10) / 10} miles` });
        else days.push(then(lift(0, 'lowerA', opts), milesSession(w, 0, mid, 'easy', 'Easy run', null, center)));
        days.push(lift(1, 'push', opts));
        days.push(then(lift(2, 'pull', opts), wedRun, true));
        days.push(milesSession(w, 3, mid, 'easy', 'Easy run', null, center));
        if (taper) days.push({ id: `w${w}d4`, w, d: 4, date: dateOf(w, 4), type: 'recovery', title: 'Rest', minutes: 0, required: false, subtitle: 'Take it easy' });
        else days.push(lift(4, 'upper', { required: false }));
      }
      const test3 = dateOf(w, 5) === '2027-02-06';
      const testHalf = dateOf(w, 5) === '2027-09-04';
      if (raceWeek) days.push(milesSession(w, 5, 2, 'shakeout', 'Shakeout', null, center));
      else if (test3) days.push(milesSession(w, 5, 3, 'test', '3-mile test', { goalSeconds: 27 * 60 }, 540));
      else if (testHalf) days.push(milesSession(w, 5, 13.1, 'test', 'Half-marathon test', { goalSeconds: 115 * 60 }, 527));
      else days.push(milesSession(w, 5, long, 'long', 'Long, slow distance', null, center + 15));
      if (raceWeek) {
        const s = milesSession(w, 6, 26.2, 'race', 'Detroit Free Press Marathon', null, 600);
        s.time = '07:00';
        s.required = true;
        days.push(s);
      } else days.push(restSession(w, 6));
    }

    const finish = (s) => {
      if (s.time === undefined) s.time = s.type === 'recovery' ? state.times[6] : state.times[s.d];
      if (bare && !s.required && s.type !== 'recovery') s.skippedForBare = true;
      applyOverride(s, state.sessionOverrides && state.sessionOverrides[s.id], center);
      if (s.type === 'run') s.goal = s.run.kind === 'minutes'
        ? { headline: `${s.run.minutes} min`, detail: `Keep your heart rate at ${HR.easyLo}-${HR.easyHi} bpm, walking when you need to. Target ${fmtPace(stats.easyLo)} to ${fmtPace(stats.easyHi)} per mile.`, lo: null, hi: null }
        : runGoal(s.run, stats);
    };
    days.forEach((s) => {
      finish(s);
      if (s.second) finish(s.second);
    });

    return { w, pre: w < 0, start: weekStart(w), end: dateOf(w, 6), phase, deload, bare, travel, finals, shift, days, stats, scheme: LIFT_SCHEMES[phaseOf(Math.max(0, w)).key] };
  }
  /* Every session in a week, including afternoon sessions. */
  const weekSessions = (wk) => wk.days.reduce((all, s) => all.concat(s.second ? [s, s.second] : [s]), []);

  /* Light sessions keep only the core lifts. An approved day-of change then applies on top. */
  function sessionExercises(s) {
    const list = LIFTS[s.lift].list.slice();
    const base = s.subtitle === 'Light session' ? list.filter((id) => EX[id].core) : list;
    const changes = (s.override && s.override.changes) || [];
    if (!changes.length) return base;
    const out = [];
    base.forEach((id) => {
      const c = changes.find((x) => x.id === id);
      if (c && c.action === 'remove') return;
      out.push(c && c.action === 'swap' ? c.replacement : id);
    });
    return out;
  }
  const exerciseOverride = (s, id) => ((s.override && s.override.changes) || []).find((c) => (c.action === 'swap' ? c.replacement === id : c.id === id)) || null;
  function sessionPlan(s, id, deload) {
    const base = schemeFor(s.w, id, deload);
    const c = exerciseOverride(s, id);
    if (!c) return base;
    return Object.assign({}, base, { sets: c.sets || base.sets, goal: c.goal || base.goal, adjusted: true, note: c.note || '' });
  }
  function sessionTarget(ls, s, id) {
    const c = exerciseOverride(s, id);
    return c && c.weight != null ? c.weight : targetFor(ls, id, s.w);
  }
  function applyOverride(s, o, center) {
    if (!o) return;
    s.override = o;
    const r = o.run;
    if (!r || s.type === 'lift') return;
    if (r.action === 'skip') { s.skippedToday = true; return; }
    if (s.type === 'cardio') {
      s.minutes = r.minutes;
      s.subtitle = `${r.minutes} min easy`;
      return;
    }
    if (r.action === 'swap_bike') {
      s.type = 'cardio';
      s.title = 'Bike';
      s.minutes = r.minutes;
      s.subtitle = `${r.minutes} min easy`;
      s.required = false;
      delete s.run;
      return;
    }
    if (r.action === 'easy') {
      const { kind, miles, warm, cool } = s.run;
      s.run = { kind, miles, warm, cool, effort: 'easy' };
      s.title = 'Easy run';
      return;
    }
    if (s.run.kind === 'distance') {
      s.run.miles = r.miles;
      s.subtitle = `${r.miles} miles`;
      s.minutes = round5((r.miles * center) / 60) + 10;
    } else if (s.run.kind === 'minutes') {
      s.run.minutes = r.minutes;
      s.minutes = r.minutes;
      s.subtitle = `${r.minutes} min easy, walk if needed`;
    } else {
      s.run.reps = r.reps;
      s.minutes = r.reps * (s.run.run + s.run.walk) + 10;
      s.subtitle = `${r.reps} x (${s.run.run} run, ${s.run.walk} walk)`;
    }
  }

  function overrideReps(state, w, d, second) {
    const o = state.sessionOverrides && state.sessionOverrides[`w${w}d${d}${second ? 'b' : ''}`];
    return o && o.run && o.run.action === 'shorten' ? o.run.reps : null;
  }
  function sessionFromLog(state, w, d, today, second) {
    // Light rebuild used while reading paces, so it cannot call runStats again.
    if (w >= 0 && w < 6 && w !== FINALS_WEEK && ((d === 2 && second) || d === 5)) {
      const shift = runShift(state, w, today);
      const step = FOUNDATION[clamp(w - shift, 0, 4)];
      const spec = d === 5 ? step.sat : step.mid;
      return { run: { kind: 'intervals', reps: overrideReps(state, w, d, second) || spec[0], run: spec[1], walk: spec[2], warm: 5, cool: 5 } };
    }
    if (w === FINALS_WEEK && d === 2 && second) {
      return { run: { kind: 'intervals', reps: overrideReps(state, w, d, second) || 3, run: 6, walk: 2, warm: 5, cool: 5 } };
    }
    return { run: { kind: 'distance' } };
  }

  const countsAsPlanned = (s) => s.type !== 'recovery' && !s.skippedForBare && !s.skippedToday && s.minutes > 0;

  /* ---------- Lifting logic: replay every log, oldest first ---------- */
  function liftState(state, maxWeek) {
    const out = {};
    Object.keys(EX).forEach((id) => {
      const ex = EX[id];
      const best = STRENGTH_BESTS[id];
      out[id] = { load: ex.start === undefined ? null : ex.start, phaseKey: 'foundation', oneRm: best ? e1rm(best.w, best.r) : null, overStreak: 0, status: 'start', last: null, reason: null, history: [] };
    });
    const logs = Object.keys(state.logs)
      .filter((id) => state.logs[id].type === 'lift')
      .map((id) => {
        const m = /^w(-?\d+)d(\d)$/.exec(id);
        return { id, w: Number(m[1]), d: Number(m[2]), log: state.logs[id] };
      })
      .filter((x) => maxWeek === undefined || x.w <= maxWeek)
      .sort((a, b) => a.w * 7 + a.d - (b.w * 7 + b.d));
    const edits = (state.loadEdits || []).filter((e) => (maxWeek === undefined || e.week <= maxWeek) && out[e.id]).sort((a, b) => a.week - b.week);
    let nextEdit = 0;
    const applyEdits = (beforeWeek) => {
      while (nextEdit < edits.length && edits[nextEdit].week < beforeWeek) {
        const e = edits[nextEdit++];
        const st = out[e.id];
        st.load = e.to;
        st.phaseKey = phaseOf(Math.max(0, e.week + 1)).key;
        st.edited = true;
        st.overStreak = 0;
        st.status = e.to > e.from ? 'up' : 'down';
        st.reason = `You approved this change at your week ${e.week + 1} check-in.`;
      }
    };
    logs.forEach(({ w, d, log }) => {
      applyEdits(w);
      const deload = w >= 0 && (isScheduledDeload(w) || state.targets.deloadWeeks.includes(w) || w === TRAVEL_WEEK);
      const key = phaseOf(Math.max(0, w)).key;
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
        st.last = { date: dateOf(w, d), sets: sets.map((s) => ({ w: s.w === '' ? null : s.w, r: Number(s.r) })), w };
        if (ex.kind !== 'time' && top != null) {
          const best = Math.max(...sets.map((s) => e1rm(Number(s.w) || 0, Number(s.r))));
          st.history.push({ date: dateOf(w, d), w, e1rm: best, top, adjusted: !!entry.adjusted });
          if (best > 0) st.oneRm = entry.adjusted ? Math.max(st.oneRm || 0, best) : best;
        }
        /* A day-of change stays on your graphs, but it doesn't move your target or your 2-for-2 streak. */
        if (entry.adjusted) {
          if (st.load == null && top != null) st.load = top;
          st.status = 'hold';
          st.reason = 'You changed this for the day, so your target holds.';
          return;
        }
        st.planned = st.last;
        const scheme = schemeFor(w, id, deload);
        if (st.phaseKey !== key) st.overStreak = 0;
        st.phaseKey = key;
        if (ex.kind === 'time') {
          const goal = st.load;
          if (deload || w < 0) { st.status = 'hold'; st.reason = 'Your target holds this week.'; return; }
          const last = reps[reps.length - 1];
          st.overStreak = last >= goal + 10 ? st.overStreak + 1 : 0;
          if (st.overStreak >= 2) {
            st.load = Math.min(60, goal + 5);
            st.overStreak = 0;
            st.status = st.load > goal ? 'up' : 'hold';
            st.reason = 'Your last set ran 10 seconds past the goal in 2 sessions in a row.';
          } else { st.status = 'hold'; st.reason = 'Hold this until your last set beats the goal by 10 seconds twice in a row.'; }
          return;
        }
        if (top != null) st.load = top;
        if (w < 0) { st.status = 'hold'; st.reason = 'Saved. Plan targets use this as your starting point.'; return; }
        if (deload) { st.status = 'hold'; st.reason = 'Unloading week, so the target holds.'; return; }
        if (ex.kind === 'power') { st.status = 'hold'; st.reason = 'Power work stays at bodyweight, focused on speed.'; return; }
        const lastReps = reps[reps.length - 1];
        st.overStreak = lastReps >= scheme.goal + 2 ? st.overStreak + 1 : 0;
        if (st.overStreak >= 2) {
          st.overStreak = 0;
          const inc = increment(ex);
          if (ex.kind === 'assist') st.load = Math.max(0, (st.load || 0) - 10);
          else st.load = (st.load || 0) + inc;
          st.status = 'up';
          st.reason = `2-for-2 rule: your last set beat the ${scheme.goal}-rep goal by 2 or more in 2 sessions in a row.`;
        } else {
          st.status = 'hold';
          st.reason = `Add weight when your last set reaches ${scheme.goal + 2} or more reps in 2 sessions in a row.`;
        }
      });
    });
    applyEdits(Infinity);
    return out;
  }
  /* The working weight for a given week: the logged weight within a phase, or a %1RM at a new phase. */
  function targetFor(ls, id, w) {
    const ex = EX[id];
    const st = ls[id];
    if (ex.kind === 'time' || ex.kind === 'power') return st.load;
    const key = phaseOf(Math.max(0, w)).key;
    const scheme = schemeFor(w, id, false);
    const newPhase = st.phaseKey !== key || ((!st.planned || st.planned.w < 0) && !st.edited);
    if (ex.core && ex.kind === 'weight' && scheme.pct && st.oneRm && newPhase && st.oneRm > 0) return round5(st.oneRm * scheme.pct);
    return st.load;
  }

    function loadText(ex, load) {
    if (ex.kind === 'time') return `${load} sec`;
    if (ex.kind === 'power') return 'Bodyweight';
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
      if (a != null && b != null && a !== b && EX[id].kind !== 'power') out.push({ name: EX[id].name, from: loadText(EX[id], a), to: loadText(EX[id], b), up: EX[id].kind === 'assist' ? b < a : b > a });
    });
    return out;
  }

  function liftsDown(ls, today) {
    let down = 0;
    Object.keys(STRENGTH_BESTS).forEach((id) => {
      const h = ((ls[id] && ls[id].history) || []).filter((x) => x.w >= 2 && !x.adjusted);
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
  const FUEL_SNACK = { id: 'fuel', time: '10:30 am', name: 'Fuel snack', portions: '2 bananas, 1 cup juice, 1 tbsp honey', portionsGuide: '2 bananas, 1 cup juice, 1 tbsp honey', cal: 400, pro: 3, carb: 95, fat: 1 };
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
    const fueling = t.calories >= 2750;
    const delta = t.calories - 2315 - (fueling ? FUEL_SNACK.cal : 0); // the listed meals total 2,315 before rice changes
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
      { id: 'lunch', time: '12:30 pm', name: 'Chicken bowl', portions: `5 oz raw chicken breast, ${fractionText(lunchRice)} cup${lunchRice === 1 ? '' : 's'} cooked rice, 1 cup vegetables, 1/2 avocado, 1 tbsp Bachan's`, portionsGuide: `Large palm of chicken, ${lunchRice >= 1.5 ? '2 fists' : '1 fist'} of rice, a fist of vegetables, 1/2 avocado, a drizzle of Bachan's`, cal: 650 - riceCal(1.5) + riceCal(lunchRice), pro: 40, carb: Math.round(79 + (lunchRice - 1.5) * RICE_CARB), fat: 20 },
      { id: 'snack', time: '3:00 pm', name: 'Portable snack', portions: `Ryse protein with almond milk, 1 apple, ${almonds === 1 ? '1 oz' : '1/2 oz'} almonds`, portionsGuide: `Ryse protein with almond milk, 1 apple, ${almonds === 1 ? 'a small handful' : 'half a handful'} of almonds`, cal: 420 - (almonds === 1 ? 0 : 82), pro: 31, carb: 34 - (almonds === 1 ? 0 : 3), fat: 18 - (almonds === 1 ? 0 : 7) },
      { id: 'dinner', time: '8:45 pm', name: 'Dinner', portions: `5 oz raw trout or chicken, ${fractionText(dinnerRice)} cup${dinnerRice === 1 ? '' : 's'} cooked rice, 1 cup vegetables, 1/4 avocado, 1 tbsp Bachan's`, portionsGuide: `Large palm of trout or chicken, ${dinnerRice >= 1.25 ? '1 big fist' : '1 fist'} of rice, a fist of vegetables, 1/4 avocado, a drizzle of Bachan's`, cal: 580 - riceCal(1) + riceCal(dinnerRice), pro: 33, carb: Math.round(68 + (dinnerRice - 1) * RICE_CARB), fat: 20 },
      { id: 'dessert', time: '9:45 pm', name: 'Planned dessert', portions: '1 no-sugar-added strawberry Outshine bar', portionsGuide: '1 no-sugar-added strawberry Outshine bar', cal: 50, pro: 0, carb: 11, fat: 0 }
    ];
    if (fueling) meals.splice(2, 0, FUEL_SNACK);
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
      if (m && m * 11 >= 90) return 'On runs of 90 minutes or longer, take 30 to 90 g of carbs per hour during the run and replace fluid so you lose under 2% of body weight. Eat 1 to 1.85 g of carbs per kg per hour afterward, plus 20 to 40 g of protein.';
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
    const sessions = weekSessions(week);
    const planned = sessions.filter(countsAsPlanned);
    const done = planned.filter((s) => state.logs[s.id]);
    let miles = 0;
    let longest = 0;
    let talkFails = 0;
    let talkLogged = 0;
    sessions.forEach((s) => {
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
    weekSessions(week).forEach((s) => {
      if (s.type !== 'run' || s.skippedForBare || s.skippedToday) return;
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
  /* Easy runs should stay at or under 80% of age-predicted max heart rate. Change it on the review screen if needed. */
  const talkFromHr = (hr) => (hr == null ? null : hr <= HR.easyHi ? 'pass' : 'fail');
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
      const sessions = weekSessions(week);
      const sameDay = sessions.find((s) => s.date === a.date && s.type === a.kind);
      if (sameDay && state.logs[sameDay.id] && state.logs[sameDay.id].source !== 'garmin') {
        item.status = 'manual';
        item.sessionId = sameDay.id;
        item.title = sameDay.title;
        return item;
      }
      const open = sessions
        .filter((s) => s.type === a.kind && !state.logs[s.id] && !used.has(s.id))
        .sort((x, y) => Math.abs(diffDays(x.date, a.date)) - Math.abs(diffDays(y.date, a.date)) || (x.date < y.date ? -1 : 1));
      if (!open.length) {
        const dayWithAddon = week.days.find((s) => s.date === a.date && s.addon && !(state.addons && state.addons[s.addon.id]));
        if (a.kind === 'cardio' && dayWithAddon) {
          item.status = 'addon';
          item.sessionId = dayWithAddon.addon.id;
          item.title = dayWithAddon.addon.title;
          return item;
        }
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
      if (a.kind === 'run' && s.run && HARD_EFFORTS.includes(s.run.effort)) item.talk = 'pass';
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
    const undo = { logIds: [], walkIds: [], extraKeys: [], seenKeys: [], addonIds: [] };
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
      } else if (it.status === 'addon') {
        state.addons = state.addons || {};
        state.addons[it.sessionId] = true;
        undo.addonIds.push(it.sessionId);
        out.cardio++;
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
    if (holds) notes.push('A run came in unfinished or above its heart-rate target, so your running holds at this step before moving on. If that\'s wrong, open the run on the Train tab and change your answer.');
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
    (u.addonIds || []).forEach((id) => { if (state.addons) delete state.addons[id]; });
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
    if (candidate < 0 || candidate >= LAST_WEEK) return null; // no check-in on race day
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
      { title: 'Confirm your training', text: 'Check the sessions, mileage, longest run, and heart-rate results the app counted.' },
      { title: 'Confirm your recovery', text: 'Check average sleep and sleep-device nights, then rate energy, soreness, and cravings from 1 to 10.' },
      { title: 'Note anything that hurt', text: 'Record any pain and anything that made the week hard.' },
      { title: 'Review and apply', text: 'Look over any changes to calories, macros, and training, then shop and meal prep from the updated plan.' }
    );
    return steps;
  }

  /* ---------- The weekly check-in rules ---------- */
  const CALORIE_FLOOR = 2100;
  const MAINTENANCE_CALORIES = 3500; // Cunningham RMR of about 2,060 x activity factor of 1.7
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
        calorieDelta += Math.max(0, MAINTENANCE_CALORIES - after.calories);
        calReason = 'Your fat-loss phase ends here. Calories rise to an estimated maintenance level for preseason, which puts carbs a little above the NSCA 5-6 g/kg range.';
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
        addChange({ kind: 'training', title: 'Next week is a deload', detail: 'Lifting drops to 2 sets per exercise at the same weights, and running drops about 25%.' });
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
        addChange({ kind: 'training', title: 'Next week is a bare-minimum week', detail: 'Do Lower A, Push, Pull, the Wednesday run, and the Saturday run. That week still counts as a win, and the full plan returns the week after.' });
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


  /* ---------- AI coach ----------
     The AI only proposes. Everything it returns passes through these checks, and nothing
     changes until you approve it. Medical red flags are caught here, before anything is sent. */
  const RED_FLAGS = [
    /chest\s+(pain|pressure|tight\w*|hurts?)|(pain|pressure|tightness)\s+in\s+(my\s+|the\s+)?chest/i,
    /faint\w*|pass(ed|ing)?\s+out|black(ed|ing)?\s+out|syncope|collaps\w*/i,
    /short(ness)?\s+of\s+breath|can'?t\s+(catch\s+my\s+|get\s+my\s+)?breath|(trouble|difficulty|hard\s+to)\s+breath\w*|can'?t\s+breathe/i,
    /dizz\w*|light\s*-?\s*headed|vertigo/i,
    /heart\s+(is\s+|keeps\s+)?(racing|pounding|fluttering|skipping)|palpitations?|irregular\s+(heart\s*beat|pulse)/i,
    /(numb\w*|tingl\w*)\s+(in\s+)?(my\s+)?(left\s+)?(arm|jaw|face)|slurred\s+speech|worst\s+headache/i
  ];
  const NEGATED = /\b(no|not|without|never|denies|isn'?t|don'?t|didn'?t|haven'?t|hasn'?t|wasn'?t)\b[^.,;!?]{0,20}$/i;
  function detectRedFlags(text) {
    const t = String(text || '');
    return RED_FLAGS.some((re) => {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(t))) {
        const lead = t.slice(0, m.index).split(/\b(?:but|however|though)\b/i).pop();
        if (!NEGATED.test(lead)) return true;
        if (m[0].length === 0) g.lastIndex++;
      }
      return false;
    });
  }

  const aiText = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 400);
  const aiList = (v, n) => (Array.isArray(v) ? v : []).map((x) => aiText(x, 200)).filter(Boolean).slice(0, n || 4);
  function validateAiExplanation(p) {
    if (!p || typeof p !== 'object') return null;
    const out = { why_in_plan: aiText(p.why_in_plan, 600), setup: aiList(p.setup), cues: aiList(p.cues), common_mistakes: aiList(p.common_mistakes), feel: aiText(p.feel, 300) };
    return out.why_in_plan || out.cues.length ? out : null;
  }

  function aiReplacements(s) {
    const current = sessionExercises(s).map((id) => EX[id].name);
    const groups = new Set(LIFTS[s.lift].list.map((id) => EX[id].group));
    const seen = new Set();
    return Object.keys(EX).filter((id) => {
      const ex = EX[id];
      if (ex.kind === 'time' || ex.kind === 'power' || !groups.has(ex.group) || current.includes(ex.name) || seen.has(ex.name)) return false;
      seen.add(ex.name);
      return true;
    });
  }

  function validateAiAdjustment(state, s, proposal, deload) {
    const out = { ok: false, stopForCare: false, advice: '', reason: '', changes: [], run: null, rejected: [], lines: [] };
    if (!proposal || typeof proposal !== 'object') return out;
    out.ok = true;
    out.advice = aiText(proposal.advice, 600);
    out.reason = aiText(proposal.reason, 300);
    if (proposal.stop_for_care === true) { out.stopForCare = true; return out; }
    const reject = (what, why) => out.rejected.push({ what, why });
    const changes = Array.isArray(proposal.exercise_changes) ? proposal.exercise_changes.slice(0, 10) : [];
    const rc = proposal.run_change && typeof proposal.run_change === 'object' ? proposal.run_change : null;

    if (s.type !== 'lift') {
      if (changes.length) reject('Exercise changes', 'This isn\'t a lifting session.');
    } else {
      if (rc && rc.action && rc.action !== 'keep') reject('Run change', 'This is a lifting session.');
      const ls = liftState(state);
      const inSession = sessionExercises(s);
      const allowed = aiReplacements(s);
      const touched = new Set();
      let remaining = inSession.length;
      changes.forEach((c) => {
        const id = c && c.exercise_id;
        const ex = Object.prototype.hasOwnProperty.call(EX, id) ? EX[id] : null;
        const label = ex ? ex.name : 'An exercise';
        if (!ex || !inSession.includes(id)) return reject(label, 'It isn\'t in today\'s session.');
        if (touched.has(id)) return reject(label, 'It already has a change.');
        const plan = schemeFor(s.w, id, deload);
        const clean = { action: c.action, id, note: aiText(c.note, 120) };
        if (c.action === 'remove') {
          if (remaining <= 1) return reject(label, 'At least one exercise has to stay.');
          remaining--;
          touched.add(id);
          out.changes.push(clean);
          out.lines.push({ name: label, value: 'Removed today', note: clean.note });
          return undefined;
        }
        let swapTo = null;
        if (c.action === 'swap') {
          swapTo = Object.prototype.hasOwnProperty.call(EX, c.replacement_id) ? c.replacement_id : null;
          if (!swapTo || !allowed.includes(swapTo)) return reject(label, 'The replacement isn\'t a similar exercise from your list.');
          clean.replacement = swapTo;
        } else if (c.action !== 'modify') return reject(label, 'The app doesn\'t recognize that kind of change.');
        const subject = swapTo ? EX[swapTo] : ex;
        const subjectPlan = swapTo ? schemeFor(s.w, swapTo, deload) : plan;
        const parts = [];
        if (c.sets != null) {
          const hi = deload ? subjectPlan.sets : Math.min(6, subjectPlan.sets + 1);
          if (!Number.isInteger(c.sets) || c.sets < 1 || c.sets > hi) return reject(subject.name, `Sets must stay between 1 and ${hi}.`);
          if (c.sets !== subjectPlan.sets) { clean.sets = c.sets; parts.push(`${c.sets} sets`); }
        }
        if (c.goal_reps != null) {
          if (subject.kind === 'time' || subject.kind === 'power') return reject(subject.name, 'Its reps or time can\'t change.');
          const lo = Math.max(5, subjectPlan.goal - 3);
          const hi = Math.min(15, subjectPlan.goal + 4);
          if (!Number.isInteger(c.goal_reps) || c.goal_reps < lo || c.goal_reps > hi) return reject(subject.name, `Reps must stay between ${lo} and ${hi}.`);
          if (c.goal_reps !== subjectPlan.goal) { clean.goal = c.goal_reps; parts.push(`${c.goal_reps} reps`); }
        }
        if (c.weight_lb != null) {
          const target = targetFor(ls, swapTo || id, s.w);
          const w = Number(c.weight_lb);
          if (subject.kind === 'time' || subject.kind === 'power') return reject(subject.name, 'It has no weight to change.');
          if ((target == null || target === 0) && !swapTo) return reject(subject.name, 'There\'s no target to change from.');
          if (!Number.isFinite(w)) return reject(subject.name, 'That weight isn\'t a number.');
          if (target != null && target !== 0) {
            const rounded = round5(w);
            if (subject.kind === 'assist') {
              if (rounded < target) return reject(subject.name, 'Assistance can\'t drop on a day-of change.');
            } else {
              const hi = deload ? target : Math.floor((target * 1.05) / 5) * 5;
              if (rounded > hi) return reject(subject.name, `Weight can't go above ${hi} lb today.`);
              if (rounded < target * 0.5) return reject(subject.name, 'That cut is too large for a day-of change.');
            }
            if (rounded !== target) { clean.weight = rounded; parts.push(`${rounded} lb`); }
          }
        }
        if (c.action === 'modify' && !parts.length) return reject(label, 'It didn\'t change anything.');
        touched.add(id);
        out.changes.push(clean);
        out.lines.push({ name: label, value: swapTo ? `Swap to ${subject.name}${parts.length ? `, ${parts.join(', ')}` : ''}` : parts.join(', '), note: clean.note });
        return undefined;
      });
    }

    if (s.type !== 'lift' && rc && rc.action && rc.action !== 'keep') {
      const name = s.title;
      const note = aiText(rc.note, 120);
      const isRace = s.run && s.run.effort === 'race';
      const isCardio = s.type === 'cardio';
      const a = rc.action;
      const mins = Number(rc.minutes);
      const fine = (run, value) => { out.run = Object.assign({ action: a, note }, run); out.lines.push({ name, value, note }); };
      if (isRace) reject(name, 'Race day can\'t be changed here.');
      else if (a === 'skip') fine({}, 'Skip today');
      else if (a === 'swap_bike') {
        if (isCardio) reject(name, 'This is already cardio.');
        else if (!Number.isInteger(mins) || mins < 10 || mins > s.minutes) reject(name, `Bike time must be 10 to ${s.minutes} minutes.`);
        else fine({ minutes: mins }, `Bike for ${mins} minutes, easy`);
      } else if (a === 'easy') {
        if (isCardio || !HARD_EFFORTS.includes(s.run.effort)) reject(name, 'It\'s already an easy session.');
        else fine({}, 'Run it easy');
      } else if (a === 'shorten') {
        if (isCardio) {
          if (!Number.isInteger(mins) || mins < 10 || mins >= s.minutes) reject(name, `Time must be 10 to ${s.minutes - 1} minutes.`);
          else fine({ minutes: mins }, `${mins} minutes`);
        } else if (s.run.effort === 'test') reject(name, 'A test can\'t be shortened. Run it easy or move on.');
        else if (s.run.kind === 'distance') {
          const miles = Math.round(Number(rc.miles) * 10) / 10;
          if (!(miles >= 0.5) || miles >= s.run.miles) reject(name, `Distance must be under ${s.run.miles} miles.`);
          else fine({ miles }, `${miles} miles`);
        } else if (s.run.kind === 'minutes') {
          if (!Number.isInteger(mins) || mins < 10 || mins >= s.run.minutes) reject(name, `Time must be under ${s.run.minutes} minutes.`);
          else fine({ minutes: mins }, `${mins} minutes`);
        } else {
          const reps = Number.isInteger(mins) ? Math.floor((mins - 10) / (s.run.run + s.run.walk)) : 0;
          if (reps < 1 || reps >= s.run.reps) reject(name, `Time must fit fewer than ${s.run.reps} rounds.`);
          else fine({ reps, minutes: reps * (s.run.run + s.run.walk) + 10 }, `${reps} rounds, ${reps * (s.run.run + s.run.walk) + 10} minutes`);
        }
      } else reject(name, 'The app doesn\'t recognize that kind of change.');
    }
    return out;
  }
  function buildOverride(checked, today) {
    return { at: today, advice: checked.advice, reason: checked.reason, changes: checked.changes, run: checked.run, lines: checked.lines };
  }

  function validateAiCheckin(state, rec, proposal) {
    const out = { ok: false, stopForCare: false, headline: '', went: [], watch: [], suggestions: [], reason: '', calorie: null, deload: false, lifts: [], rejected: [] };
    if (!proposal || typeof proposal !== 'object') return out;
    out.ok = true;
    out.headline = aiText(proposal.headline, 300);
    out.went = aiList(proposal.what_went_well, 3);
    out.watch = aiList(proposal.watch_out, 3);
    out.suggestions = aiList(proposal.suggestions, 3);
    if (proposal.stop_for_care === true) {
      out.stopForCare = true;
      return out;
    }
    const p = proposal.proposed && typeof proposal.proposed === 'object' ? proposal.proposed : {};
    out.reason = aiText(p.proposal_reason, 300);
    const reject = (what, why) => out.rejected.push({ what, why });
    const w = rec.week;
    const d = rec.data;
    const blocked = rec.alerts.some((a) => a.level === 'critical') ? 'You reported a symptom that needs care first.' : w === TRAVEL_WEEK ? 'Nothing changes on a travel week.' : null;

    const delta = p.calorie_delta;
    if (delta != null && delta !== 0) {
      const rounded = Math.round(Number(delta) / 25) * 25;
      const to = rec.after.calories + rounded;
      if (blocked) reject('Calories', blocked);
      else if (!Number.isFinite(rounded) || rounded < -150 || rounded > 200) reject('Calories', 'A change must stay between -150 and +200.');
      else if (rec.after.calories !== rec.before.calories) reject('Calories', 'The rules already changed calories this week.');
      else if (to < CALORIE_FLOOR) reject('Calories', `Calories can't go below ${CALORIE_FLOOR.toLocaleString('en-US')}.`);
      else if (rounded < 0 && (Number(d.energy) < 5 || Number(d.cravings) >= 7 || d.trackingBackfired || rec.lossRate == null || rec.lossRate >= 0.5 || d.pain)) reject('Calories', 'Your data this week doesn\'t support a cut.');
      else if (rounded !== 0) out.calorie = { delta: rounded, to };
    }
    if (p.add_deload_next_week === true) {
      if (blocked) reject('Deload', blocked);
      else if (w + 1 >= 46) reject('Deload', 'Taper already covers this.');
      else if (!isScheduledDeload(w + 1) && !rec.after.deloadWeeks.includes(w + 1)) out.deload = true;
    }
    const ls = liftState(state);
    const lifts = Array.isArray(p.lift_targets) ? p.lift_targets : [];
    const seen = new Set();
    lifts.forEach((c, i) => {
      const id = c && c.exercise_id;
      const ex = Object.prototype.hasOwnProperty.call(EX, id) ? EX[id] : null;
      const name = ex ? ex.name : 'A lift';
      if (blocked) return reject(name, blocked);
      if (i >= 4 || out.lifts.length >= 4) return reject(name, 'Only 4 lift targets can change at once.');
      if (!ex || (ex.kind !== 'weight' && ex.kind !== 'assist')) return reject(name, 'Its target can\'t change this way.');
      if (seen.has(id)) return reject(name, 'It already has a change.');
      const st = ls[id];
      const from = targetFor(ls, id, w + 1);
      if (from == null || from === 0) return reject(name, 'It has no target yet.');
      if (!st.last || st.last.w < 0) return reject(name, 'It has no logged session in the plan yet.');
      const to = round5(Number(c.weight_lb));
      if (!Number.isFinite(to) || to === from) return undefined;
      const harder = ex.kind === 'assist' ? to < from : to > from;
      const step = ex.kind === 'assist' ? 10 : increment(ex);
      if (harder) {
        const goal = schemeFor(st.last.w, id, false).goal;
        const lastSet = st.last.sets[st.last.sets.length - 1];
        const nextDeload = isScheduledDeload(w + 1) || rec.after.deloadWeeks.includes(w + 1) || out.deload || w + 1 === TRAVEL_WEEK;
        if (Math.abs(to - from) > step) return reject(name, `A raise can be ${step} lb at most.`);
        if (st.status === 'up' && st.last.w === w) return reject(name, 'The 2-for-2 rule just raised it.');
        if (!lastSet || Number(lastSet.r) < goal) return reject(name, `Your last set didn't reach the ${goal}-rep goal.`);
        if (d.pain) return reject(name, 'You reported pain this week.');
        if (nextDeload) return reject(name, 'Next week is an unloading week.');
      } else if (ex.kind === 'weight' && to < from * 0.9) return reject(name, 'A cut can be 10% at most.');
      else if (ex.kind === 'assist' && to - from > 20) return reject(name, 'That change is too large.');
      seen.add(id);
      out.lifts.push({ id, name, from, to, up: harder, reason: aiText(c.reason, 160), fromText: loadText(ex, from), toText: loadText(ex, to) });
      return undefined;
    });
    return out;
  }
  const aiHasProposal = (r) => !!(r && (r.calorie || r.deload || r.lifts.length));
  /* Adds an approved proposal to a check-in record. */
  function applyAiCheckin(rec, review) {
    const w = rec.week;
    if (review.calorie) {
      rec.after.calories = review.calorie.to;
      rec.changes.push({ kind: 'calories', title: `Daily calories: ${review.calorie.to - review.calorie.delta} to ${review.calorie.to}`, detail: `You approved this from your AI review. ${review.reason}`.trim() });
    }
    if (review.deload) {
      rec.after.deloadWeeks.push(w + 1);
      rec.changes.push({ kind: 'training', title: 'Next week is a deload', detail: `You approved this from your AI review. ${review.reason}`.trim() });
    }
    rec.loadEdits = review.lifts.map((l) => ({ id: l.id, week: w, from: l.from, to: l.to, reason: l.reason }));
    rec.liftChanges = (rec.liftChanges || []).concat(review.lifts.map((l) => ({ name: l.name, from: l.fromText, to: l.toText, up: l.up })));
    rec.aiApplied = true;
    return rec;
  }

  /* What the AI sees. Only what's needed for the question, with no name or sleep-device data. */
  function aiLiftRow(ls, s, id, deload) {
    const ex = EX[id];
    const st = ls[id];
    const plan = sessionPlan(s, id, deload);
    return { id, name: ex.name, kind: ex.kind, core: !!ex.core, sets: plan.sets, goal_reps: plan.goal, rest: plan.rest, target: loadText(ex, sessionTarget(ls, s, id)), last: st.last ? st.last.sets.map((x) => `${x.w == null ? '' : `${x.w}x`}${x.r}`).join(', ') : null, last_status: st.status };
  }
  function aiRunRow(s) {
    if (s.type === 'cardio') return { kind: 'cardio', minutes: s.minutes };
    const r = s.run;
    return { kind: r.kind, effort: r.effort || 'easy', miles: r.miles || null, minutes: s.minutes, rounds: r.reps || null, run_minutes: r.run || null, walk_minutes: r.walk || null, tempo_minutes: r.tempoMin || null, goal: s.goal ? s.goal.headline : null };
  }
  function aiPhase(w) {
    const p = phaseOf(Math.max(0, w));
    return { week: w + 1, phase: p.name, deload: isScheduledDeload(w), travel: w === TRAVEL_WEEK };
  }
  function aiExplainContext(state, s, id, deload) {
    if (id) {
      const ls = liftState(state);
      const ex = EX[id];
      const best = ls[id].history.slice(-1)[0];
      return Object.assign(aiPhase(s.w), { subject: 'exercise', exercise: aiLiftRow(ls, s, id, deload), session: s.title, muscle_area: ex.group, best_estimated_1rm: best ? Math.round(ls[id].oneRm) : null, strength_goal: STRENGTH_GOALS[id] || null });
    }
    return Object.assign(aiPhase(s.w), { subject: 'run', title: s.title, run: aiRunRow(s), heart_rate_target: `${HR.easyLo}-${HR.easyHi} bpm`, purpose_note: s.subtitle || '' });
  }
  function aiAdjustContext(state, s, today, input, deload) {
    const day = state.days[today] || {};
    const ctx = Object.assign(aiPhase(s.w), {
      date: today,
      session: { title: s.title, type: s.type, minutes: s.minutes },
      morning: { sleep_hours: day.sleep == null ? null : day.sleep, resting_hr: day.rhr == null ? null : day.rhr, soreness_out_of_10: day.soreness == null ? null : day.soreness, readiness: (readiness(state, today) || {}).score || null, cautions: backOff(state, today).map((b) => b.title) },
      today: { minutes_available: input.minutes || null, energy: input.energy || null, soreness: input.soreness || null }
    });
    if (s.type === 'lift') {
      const ls = liftState(state);
      ctx.session.exercises = sessionExercises(s).map((id) => aiLiftRow(ls, s, id, deload));
      ctx.replacements = aiReplacements(s).map((id) => ({ id, name: EX[id].name, kind: EX[id].kind }));
    } else ctx.session.run = aiRunRow(s);
    return ctx;
  }
  function aiCheckinContext(state, rec, today) {
    const ls = liftState(state);
    const d = rec.data;
    const history = state.checkins.filter((c) => c.week < rec.week).sort((a, b) => a.week - b.week).slice(-4).map((c) => ({ week: c.week + 1, weight: c.data.weightAvg, waist: c.data.waist || null, energy: c.data.energy, soreness: c.data.soreness, cravings: c.data.cravings, done: c.summary.done, planned: c.summary.planned, miles: c.summary.miles, calories: c.after.calories }));
    const lifts = {};
    Object.keys(EX).forEach((id) => {
      const st = ls[id];
      if (!st.last || (EX[id].kind !== 'weight' && EX[id].kind !== 'assist')) return;
      lifts[id] = { name: EX[id].name, next_target: loadText(EX[id], targetFor(ls, id, rec.week + 1)), last: st.last.sets.map((x) => `${x.w == null ? '' : `${x.w}x`}${x.r}`).join(', '), goal_reps: schemeFor(st.last.w, id, false).goal, status: st.status };
    });
    const stats = runStats(state, today);
    return Object.assign(aiPhase(rec.week), {
      next_week_scheduled_deload: isScheduledDeload(rec.week + 1),
      this_week: { average_weight: d.weightAvg, waist_cm: d.waist || null, sessions_done: rec.summary.done, sessions_planned: rec.summary.planned, miles: rec.summary.miles, longest_run: rec.summary.longest, heart_rate_fails: rec.summary.talkFails, average_sleep: d.sleepAvg, energy: d.energy, soreness: d.soreness, cravings: d.cravings, followed_food_plan: d.food, pain: !!d.pain, loss_rate_lb_per_week: rec.lossRate },
      history,
      targets: { calories: rec.after.calories, floor: CALORIE_FLOOR, maintenance: !!rec.after.maintenance },
      rules_already_decided: { changes: rec.changes.map((c) => c.title), notes: rec.notes },
      easy_pace: `${fmtPace(stats.easyLo)} to ${fmtPace(stats.easyHi)}`,
      lifts
    });
  }

  /* ---------- Checkpoints ---------- */
  const CHECKPOINTS = [
    { date: '2027-02-07', weight: [195, 198], waist: [88, 90], run: 'Run 3 miles without stopping. Under 9:00 per mile is the stretch goal.', strength: 'Match or beat your current best sets' },
    { date: '2027-05-02', weight: [186, 191], waist: [84, 87], run: 'Complete a 10-mile long, slow distance run.', strength: 'Keep climbing toward your June 13 lift goals' },
    { date: '2027-10-17', weight: [180, 188], waist: null, run: 'Finish healthy first, then under 4:30, with under 4:00 as the stretch goal.', strength: 'Hold your June lift numbers within about 5%' }
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
      weekSessions(week).forEach((s) => {
        if (!s.time || s.skippedForBare || s.skippedToday || s.minutes <= 0) return;
        push(s.id, s.date, s.time, s.minutes, s.title, (s.subtitle || '').replace(/,/g, '\\,'));
      });
      push(`checkin${w}`, checkinDate(w), state.checkinTime, 20, 'Weekly check-in', 'Open the Detroit 26.2 app and complete your check-in before breakfast.');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  return {
    START, RACE, HALF, HR, LIFT_SCHEMES, MILEAGE, LAST_WEEK, TRAVEL_WEEK, FINALS_WEEK, EX, LIFTS, STRENGTH_BESTS, STRENGTH_GOALS, DAY_NAMES, DAY_SHORT, CHECKPOINTS, CALORIE_FLOOR,
    addDays, diffDays, fmtDate, dayIndex, weekOf, weekStart, dateOf, fmtPace, fmtDur, fmtTime, e1rm, pctFromReps, schemeFor, targetFor, sessionExercises, weekSessions, increment,
    initialState, phaseOf, buildWeek, liftState, macros, mealPlan, trackingToday, longRunFuel, readiness, backOff,
    parseCsv, parseGarminCsv, planGarminImport, applyGarminImport, undoGarminImport, garminBaseline, loadText, liftChanges, foodTotals, rangeStatus, scaleFood, caloriesFromMacros, exerciseHistory, weekSummary, plannedMiles, checkinDate, waistDue, dueCheckin, nextCheckinWeek, checkinInstructions, evaluateCheckin,
    buildCheckinRecord, checkinSummaryText, detectRedFlags, validateAiExplanation, validateAiAdjustment, validateAiCheckin, aiHasProposal, applyAiCheckin, buildOverride, aiReplacements, aiExplainContext, aiAdjustContext, aiCheckinContext, sessionPlan, sessionTarget, exerciseOverride, nextCheckpoint, runStats, runShift, countsAsPlanned, buildIcs, isScheduledDeload, MARATHON_TIERS
  };
});
