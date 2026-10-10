// Procedural sound: every effect is synthesised with Web Audio, so there are no audio
// files and it works offline. Sounds are panned and attenuated by where the event
// happens relative to the camera, and rate-limited so a big battle stays listenable.

const PREF_KEY = 'rtw.sound';
const MAX_VOICES = 28;
// Minimum seconds between two sounds of the same kind.
const MIN_GAP = {
  loose: 0.07, bolt: 0.09, clash: 0.045, arrowhit: 0.06, death: 0.12, impact: 0.08, charge: 0.6, rout: 0.8,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function loadPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

function savePref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch { /* storage unavailable; preference just won't persist */ }
}

export class SoundEngine {
  constructor() {
    this.enabled = loadPref();
    this.ctx = null;
    this.last = {};
    this.busy = []; // end times of active voices
    this.melee = 0; // recent clash rate, drives the battle din
  }

  // Browsers only allow audio to start from a user gesture; call this from one.
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    // iOS can also leave the context 'interrupted' (calls, backgrounding).
    if (this.ctx && this.ctx.state !== 'running' && !this.paused) this.ctx.resume();
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(comp);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.startAmbience();
  }

  loop(filterType, freq, q, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return { f, g };
  }

  // Wind over the field, plus a crowd din that swells with the fighting.
  startAmbience() {
    const ctx = this.ctx;
    const wind = this.loop('bandpass', 500, 0.8, 0.05);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg).connect(wind.f.frequency);
    lfo.start();
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.05;
    const lg2 = ctx.createGain();
    lg2.gain.value = 0.03;
    lfo2.connect(lg2).connect(wind.g.gain);
    lfo2.start();
    this.din = this.loop('bandpass', 900, 0.6, 0);
  }

  setEnabled(on) {
    this.enabled = on;
    savePref(on);
    if (on) this.unlock();
    else this.ctx?.suspend();
  }

  setPaused(p) {
    this.paused = p;
    if (!this.ctx) return;
    if (p) this.ctx.suspend();
    else if (this.enabled) this.ctx.resume();
  }

  ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  // view: anything with { cam: {x, y, zoom}, w, h } — the renderer.
  ingest(events, view) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    this.busy = this.busy.filter((t) => t > now);
    let clashes = 0;
    for (const e of events) {
      let kind = e.type === 'loose' && e.bolt ? 'bolt' : e.type;
      if (kind === 'clash') clashes++;
      if (!(kind in MIN_GAP)) continue;
      const big = kind === 'charge' || kind === 'rout';
      if (now - (this.last[kind] ?? -1) < MIN_GAP[kind] || (!big && this.busy.length >= MAX_VOICES)) continue;
      const sp = this.spatial(e.x, e.y, view);
      if (!sp) continue;
      this.last[kind] = now;
      this.play(kind, e, sp, now + 0.01);
    }
    // One sim step's clashes feed a smoothed din level.
    this.melee += (clashes * 60 - this.melee) * 0.02;
    this.din.g.gain.setTargetAtTime(clamp(this.melee / 400, 0, 0.12), now, 0.5);
  }

  spatial(x, y, view) {
    const z = view.cam.zoom;
    const dx = (x - view.cam.x) * z, dy = (y - view.cam.y) * z;
    const hw = view.w / 2, hh = view.h / 2;
    const d = Math.hypot(dx / hw, dy / hh); // 1 ≈ screen edge
    if (d > 1.6) return null;
    const gain = clamp(1.15 - d * 0.6, 0.1, 1) * clamp(0.4 + z * 0.5, 0.45, 1);
    return { gain, pan: clamp(dx / hw, -1, 1) * 0.75 };
  }

  // --- building blocks -----------------------------------------------------------

  voice(sp, t, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = sp.gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = sp.pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    this.busy.push(t + dur);
    return g;
  }

  tone(dest, type, f0, f1, t, dur, peak, attack = 0.005) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  noise(dest, filterType, f0, f1, q, t, dur, peak, attack = 0.003) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.8);
    src.stop(t + dur + 0.05);
  }

  // A brass-ish note: detuned saws through a lowpass that opens on the attack.
  horn(dest, f, t, dur, peak) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(f * 5, t + 0.08);
    lp.frequency.exponentialRampToValueAtTime(f * 3, t + dur);
    lp.connect(dest);
    for (const detune of [-6, 5]) {
      const o = this.tone(lp, 'sawtooth', f, f, t, dur, peak, 0.06);
      o.detune.value = detune;
    }
  }

  // --- the sounds ----------------------------------------------------------------

  play(kind, e, sp, t) {
    const pf = 0.92 + Math.random() * 0.16;
    switch (kind) {
      case 'loose': {
        // Bowstring twang and the whoosh of the arrow leaving.
        const v = this.voice(sp, t, 0.25);
        this.tone(v, 'triangle', 190 * pf, 120 * pf, t, 0.09, 0.07, 0.002);
        this.noise(v, 'bandpass', 3800 * pf, 1400, 2.5, t + 0.01, 0.2, 0.12, 0.02);
        break;
      }
      case 'bolt': {
        const v = this.voice(sp, t, 0.12);
        this.tone(v, 'square', 150 * pf, 70, t, 0.07, 0.07, 0.001);
        this.noise(v, 'highpass', 2500, 1800, 0.8, t, 0.04, 0.2, 0.001);
        break;
      }
      case 'clash': {
        // Inharmonic partials ring like struck steel.
        const v = this.voice(sp, t, 0.3);
        const base = 1900 * pf;
        this.tone(v, 'sine', base, base * 0.98, t, 0.22, 0.05, 0.001);
        this.tone(v, 'sine', base * 1.47, base * 1.45, t, 0.16, 0.035, 0.001);
        this.tone(v, 'sine', base * 2.09, base * 2.05, t, 0.1, 0.02, 0.001);
        this.noise(v, 'highpass', 4000, 3000, 0.7, t, 0.03, 0.12, 0.001);
        break;
      }
      case 'arrowhit': {
        const v = this.voice(sp, t, 0.1);
        this.noise(v, 'lowpass', 900, 200, 1, t, 0.07, 0.18, 0.001);
        break;
      }
      case 'death': {
        const v = this.voice(sp, t, 0.3);
        this.noise(v, 'bandpass', 420 * pf, 260, 4, t, 0.25, 0.1, 0.02);
        this.tone(v, 'sine', 110, 55, t + 0.05, 0.15, 0.08, 0.004);
        break;
      }
      case 'impact': {
        const v = this.voice(sp, t, 0.4);
        this.noise(v, 'lowpass', 700, 90, 0.8, t, 0.35, 0.35, 0.002);
        this.tone(v, 'sine', 90, 40, t, 0.25, 0.25, 0.002);
        // Shafts snapping on a braced line.
        if (e.kind === 'braced') this.noise(v, 'bandpass', 2400, 1600, 3, t + 0.01, 0.06, 0.3, 0.001);
        break;
      }
      case 'charge': {
        // A horn call over the rumble of hooves.
        const v = this.voice(sp, t, 2.4);
        this.horn(v, 233, t, 0.35, 0.05);
        this.horn(v, 311, t + 0.38, 0.8, 0.06);
        for (let i = 0; i < 16; i++) {
          this.noise(v, 'lowpass', 260, 120, 1, t + 0.2 + i * 0.12 + Math.random() * 0.04, 0.12, 0.12 * Math.min(1, i / 4), 0.005);
        }
        break;
      }
      case 'rout': {
        const v = this.voice(sp, t, 1.6);
        this.horn(v, 311, t, 0.4, 0.04);
        this.horn(v, 233, t + 0.42, 0.5, 0.035);
        this.horn(v, 196, t + 0.95, 0.6, 0.03);
        break;
      }
    }
  }

  // Trumpets when a battle is decided (minor if nobody holds the field).
  fanfare(victory) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + 0.05;
    const notes = victory ? [196, 261.6, 329.6, 392, 523.3] : [220, 261.6, 311.1, 293.7, 220];
    const durs = [0.18, 0.18, 0.18, 0.4, 1.2];
    const v = this.voice({ gain: 1, pan: 0 }, t, 3);
    let at = t;
    notes.forEach((f, i) => {
      this.horn(v, f, at, durs[i], 0.05);
      at += durs[i] + 0.02;
    });
  }
}
