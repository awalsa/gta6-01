// Puerto Fuego — procedural sound engine.
//
// Nothing here is a recording. Every effect is built from oscillators and filtered noise at
// runtime, so the game ships zero audio files and the first frame never waits on a download.
// The engine stays silent until `unlock()` runs inside a real user gesture: browsers refuse to
// start an AudioContext anywhere else, so before that moment every public method is a harmless
// no-op and every handle it returns still accepts setSpeed()/stop().
//
// Layout of the mix:
//   master  -> destination
//   street  -> cars, gunfire, sirens, footsteps, explosions, ambience
//   ui      -> menu blips and confirmations
//   score   -> the slow synth pad that drifts under the street
//
// A sound is either a *voice* (engine, siren, ambience, score — long-lived, driven over time)
// or a *one-shot* (gunshot, footstep, blip — fire and forget, gone in under two seconds).

/** Clamp a number into [lo, hi]; NaN falls back to lo so a bad speed never silences a voice. */
function clampNum(value, lo, hi) {
  const v = Number(value);
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * MIDI note number -> frequency in Hz. Note 69 is A4 = 440 Hz, the anchor of equal temperament,
 * so the score below can be written as note numbers instead of magic frequencies.
 */
export function noteToHz(midi) {
  return 440 * Math.pow(2, (Number(midi) - 69) / 12);
}

/** Overall ceiling. Engines, a siren and a gunshot can all peak on the same frame. */
const MASTER_GAIN = 0.65;

/** Per-bus trim. The score sits well under the street so it never fights a gunshot. */
const BUS_GAIN = { street: 1.0, ui: 0.85, score: 0.38 };

/** Seconds of white noise pre-rendered once and reused by every noise-based sound. */
const NOISE_LEN = 2;

/** Frozen handle handed out while the context does not exist yet. */
const DEAD_ENGINE = Object.freeze({ setSpeed() {}, stop() {} });

/**
 * Gun voicing table. `cut` is the lowpass corner the noise burst opens at, `body` the pitch the
 * low thump starts from, `tail` how long the sound lasts, `peak` its loudest gain.
 */
const GUN_VOICES = {
  pistol: { cut: 2400, body: 160, tail: 0.16, peak: 0.5 },
  smg: { cut: 3400, body: 200, tail: 0.1, peak: 0.32 },
  shotgun: { cut: 1300, body: 90, tail: 0.32, peak: 0.62 },
  rifle: { cut: 2000, body: 120, tail: 0.24, peak: 0.55 },
};

/** UI blips as [start Hz, end Hz, seconds, peak]. Rising = chosen, falling = back out. */
const BLIPS = {
  click: [640, 720, 0.04, 0.12],
  move: [540, 660, 0.045, 0.12],
  select: [500, 840, 0.09, 0.15],
  confirm: [520, 1040, 0.12, 0.16],
  back: [680, 400, 0.08, 0.13],
  error: [220, 140, 0.18, 0.16],
  pickup: [880, 1320, 0.1, 0.14],
  cash: [990, 1480, 0.14, 0.13],
};

/** Minor pentatonic, two octaves: any three of these notes can ring together without clashing. */
const SCORE_SCALE = [45, 48, 50, 52, 55, 57, 60, 64, 67, 69];

/**
 * How bright the score bed should be at a given hour. Sine through the day: full at noon, gone
 * at 06:00/18:00, with a small lift near dusk when the bed is most exposed behind a slow engine.
 */
function daylightFactor(hour) {
  const day = clampNum(Math.sin(((hour - 6) / 12) * Math.PI), 0, 1);
  const dusk = Math.max(0, 1 - Math.abs(day - 0.28) / 0.28);
  return clampNum(0.12 + day * 0.72 + dusk * 0.2, 0, 1);
}

export function createAudio() {
  let ctx = null;
  let masterGain = null;
  let bus = null; // { street, ui, score }
  let scoreFilter = null;
  let noiseBuf = null;

  /** Live engine loops, keyed by vehicle id, so re-entering a car replaces its loop. */
  const engines = new Map();

  let sirenVoice = null; // { osc, sub, lfo, lfoGain, gain, timer }
  let ambienceVoice = null; // { nodes:[], timer }
  let scoreVoice = null; // { pads:[], sub, lfo, timer }
  let scoreRunning = false;

  let muted = false;
  /** Hour remembered while there is no context; applied the moment one exists. */
  let rememberedHour = 18.2;

  // ------------------------------------------------------------ graph primitives

  /** Lazily render the shared white-noise buffer. */
  function sharedNoise() {
    if (noiseBuf) return noiseBuf;
    const frames = Math.floor(ctx.sampleRate * NOISE_LEN);
    noiseBuf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function noiseSrc(loop = false) {
    const src = ctx.createBufferSource();
    src.buffer = sharedNoise();
    src.loop = loop;
    return src;
  }

  function makeBus(level) {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(masterGain);
    return g;
  }

  /** Build the context and the bus graph. Called only from unlock(), i.e. from a gesture. */
  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const Ctor =
      typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!Ctor) return;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
      return;
    }

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : MASTER_GAIN;
    masterGain.connect(ctx.destination);

    bus = {
      street: makeBus(BUS_GAIN.street),
      ui: makeBus(BUS_GAIN.ui),
      score: makeBus(BUS_GAIN.score),
    };

    // The score's brightness filter lives inside the score bus, so setHour() only ever
    // re-voices the music and never dulls a gunshot or a siren.
    scoreFilter = ctx.createBiquadFilter();
    scoreFilter.type = 'lowpass';
    scoreFilter.frequency.value = 2000;
    scoreFilter.Q.value = 0.5;
    scoreFilter.connect(bus.score);

    applyDaylight();
  }

  function applyDaylight() {
    if (!ctx || !scoreFilter) return;
    const f = daylightFactor(rememberedHour);
    const t = ctx.currentTime;
    // ~0.8 s smoothing: the hour can jump in a staged screenshot and a filter slam would click.
    scoreFilter.frequency.setTargetAtTime(300 + f * 3600, t, 0.8);
    bus.score.gain.setTargetAtTime(BUS_GAIN.score * (0.55 + f * 0.45), t, 0.8);
  }

  /** Time of day for the score bed (0-24). Safe to call before unlock; remembered until then. */
  function setHour(hour) {
    const v = Number(hour);
    if (!Number.isFinite(v)) return;
    rememberedHour = ((v % 24) + 24) % 24;
    if (ctx) applyDaylight();
  }

  /** Mute or unmute the master output. Returns the new muted state. */
  function mute(flag) {
    muted = flag !== false;
    if (ctx && masterGain) {
      masterGain.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.05);
    }
    return muted;
  }

  function isMuted() {
    return muted;
  }

  // ------------------------------------------------------------ one-shot helpers

  /** Short pitched blip: an oscillator gliding from f0 to f1 with a fast attack/decay envelope. */
  function blip(f0, f1, dur, peak, type = 'triangle', dest = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(30, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(dest || bus.ui);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /**
   * Noise burst through a lowpass that darkens as it dies — the shape of a gunshot, a crash, or
   * a footstep, with the numbers deciding which. A low sine thump underneath gives it body.
   */
  function noiseBurst({ cut, tail, peak, body = 0, bodyDrop = 42, rateJitter = true }) {
    if (!ctx) return;
    const t = ctx.currentTime;

    const src = noiseSrc();
    if (rateJitter) src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cut, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, cut * 0.18), t + tail);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + tail);
    src.connect(lp);
    lp.connect(g);
    g.connect(bus.street);
    src.start(t);
    src.stop(t + tail + 0.02);

    if (body > 0) {
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(body, t);
      thump.frequency.exponentialRampToValueAtTime(bodyDrop, t + tail * 0.8);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(peak * 0.55, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + tail * 0.9);
      thump.connect(tg);
      tg.connect(bus.street);
      thump.start(t);
      thump.stop(t + tail + 0.02);
    }
  }

  // ------------------------------------------------------------ named one-shots

  function gunshot(kind) {
    const spec = GUN_VOICES[kind] || GUN_VOICES.pistol;
    noiseBurst({ cut: spec.cut, tail: spec.tail, peak: spec.peak, body: spec.body });
  }

  function explosion() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = 1.9;
    // Deep rumble: noise through a lowpass that collapses from 1.1 kHz to 60 Hz.
    noiseBurst({ cut: 1100, tail: len, peak: 0.85, body: 62, bodyDrop: 26, rateJitter: false });
    // Debris crack: a short bright layer on top, gone before the bass peaks.
    const debris = noiseSrc();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const dg = ctx.createGain();
    dg.gain.setValueAtTime(0.4, t);
    dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    debris.connect(hp);
    hp.connect(dg);
    dg.connect(bus.street);
    debris.start(t);
    debris.stop(t + 0.25);
  }

  function footstep() {
    if (!ctx) return;
    // Bandpassed noise tick, centre frequency randomised per step so a stride never sounds looped.
    const t = ctx.currentTime;
    const src = noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650 + Math.random() * 950;
    bp.Q.value = 2.0;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    src.connect(bp);
    bp.connect(g);
    g.connect(bus.street);
    src.start(t);
    src.stop(t + 0.07);
  }

  function carHorn() {
    if (!ctx) return;
    // Two detuned squares a major third apart — the classic impatient two-note horn.
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    g.connect(bus.street);
    for (const [freq, detune] of [
      [370, -4],
      [466, 5],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.36);
    }
  }

  function ui(kind) {
    const spec = BLIPS[kind] || BLIPS.select;
    blip(spec[0], spec[1], spec[2], spec[3]);
  }

  /**
   * Play a named sound. Names: click, move, select, confirm, back, error, pickup, cash,
   * footstep, horn, explosion, pistol, smg, shotgun, rifle, sirenOn, sirenOff.
   * Unknown names fall back to a plain select blip rather than throwing.
   */
  function play(name, opts) {
    if (!ctx) return;
    switch (name) {
      case 'pistol':
      case 'smg':
      case 'shotgun':
      case 'rifle':
        gunshot(name);
        return;
      case 'explosion':
        explosion();
        return;
      case 'footstep':
        footstep();
        return;
      case 'horn':
        carHorn();
        return;
      case 'sirenOn':
        siren(true);
        return;
      case 'sirenOff':
        siren(false);
        return;
      default:
        ui(typeof name === 'string' ? name : 'select');
        if (opts && opts.weapon) gunshot(opts.weapon);
    }
  }

  // ------------------------------------------------------------ engine voice

  /**
   * Looping engine for one vehicle. Two detuned oscillators (saw growl + square rasp) through a
   * resonant lowpass, plus a bandpassed noise layer for road/wind. `setSpeed(mph)` sweeps pitch,
   * filter and wind together; `stop()` fades out and frees the nodes.
   */
  function engine(id) {
    if (!ctx) return DEAD_ENGINE;
    const key = id === undefined || id === null ? 'default' : String(id);
    const old = engines.get(key);
    if (old) old.stop();

    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(bus.street);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 4.0; // resonance = the body panel, not the buzz
    filter.connect(out);

    const growl = ctx.createOscillator();
    growl.type = 'sawtooth';
    growl.frequency.value = 46;
    const growlGain = ctx.createGain();
    growlGain.gain.value = 0.55;
    growl.connect(growlGain);
    growlGain.connect(filter);

    const rasp = ctx.createOscillator();
    rasp.type = 'square';
    rasp.frequency.value = 69;
    rasp.detune.value = 9; // a few cents sharp of the fifth: the lumpiness of an idle
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.22;
    rasp.connect(raspGain);
    raspGain.connect(filter);

    const wind = noiseSrc(true);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 900;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(out);

    growl.start(t);
    rasp.start(t);
    wind.start(t);
    out.gain.setTargetAtTime(0.08, t, 0.4); // fade in like an ignition, not a cut

    let stopped = false;
    const handle = {
      setSpeed(speed) {
        if (stopped || !ctx) return;
        const s = clampNum(speed, 0, 60);
        const now = ctx.currentTime;
        growl.frequency.setTargetAtTime(34 + s * 2.1, now, 0.08);
        rasp.frequency.setTargetAtTime(50 + s * 3.2, now, 0.08);
        filter.frequency.setTargetAtTime(220 + s * 62, now, 0.09);
        windGain.gain.setTargetAtTime(0.02 + s * 0.0035, now, 0.12);
        out.gain.setTargetAtTime(0.07 + Math.min(s, 40) * 0.002, now, 0.2);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (engines.get(key) === handle) engines.delete(key);
        if (!ctx) return;
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setTargetAtTime(0.0001, now, 0.08);
        const kill = () => {
          try {
            growl.stop();
            rasp.stop();
            wind.stop();
          } catch {
            /* already stopped */
          }
          try {
            out.disconnect();
          } catch {
            /* already detached */
          }
        };
        if (typeof setTimeout === 'function') setTimeout(kill, 420);
        else kill();
      },
    };

    engines.set(key, handle);
    return handle;
  }

  // ------------------------------------------------------------ siren voice

  /**
   * Two-tone police wail. Unlike a stepped timer, the wail here is a square-wave LFO driving the
   * oscillator frequency through a gain node, so the pitch glides between 700 Hz and 960 Hz and
   * the second horn rides a fifth above it. siren(false) fades it out.
   */
  function siren(on) {
    if (!ctx) return;
    if (on === false) {
      if (!sirenVoice) return;
      const v = sirenVoice;
      sirenVoice = null;
      if (v.timer) clearInterval(v.timer);
      const t = ctx.currentTime;
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0.0001, t, 0.1);
      const kill = () => {
        try {
          v.osc.stop();
          v.sub.stop();
          v.lfo.stop();
          v.gain.disconnect();
        } catch {
          /* already stopped */
        }
      };
      if (typeof setTimeout === 'function') setTimeout(kill, 420);
      else kill();
      return;
    }
    if (sirenVoice) return;

    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(bus.street);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1050;
    band.Q.value = 1.1;
    band.connect(gain);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 830; // centre between the two wail tones
    osc.connect(band);

    const sub = ctx.createOscillator();
    sub.type = 'sawtooth';
    sub.frequency.value = 1245;
    sub.detune.value = -7;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    sub.connect(subGain);
    subGain.connect(band);

    // Square LFO, 0.9 Hz: swings both horns between their low and high tones in lockstep.
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 0.9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 130; // +/-130 Hz around 830
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const subLfoGain = ctx.createGain();
    subLfoGain.gain.value = 195; // same swing, a fifth up
    lfo.connect(subLfoGain);
    subLfoGain.connect(sub.frequency);

    osc.start(t);
    sub.start(t);
    lfo.start(t);
    gain.gain.setTargetAtTime(0.055, t, 0.25);
    sirenVoice = { osc, sub, lfo, gain, timer: 0 };
  }

  // ------------------------------------------------------------ ambience

  /**
   * Looping street ambience. `kind` selects the bed:
   *  - 'street': low traffic rumble + slow passing-car swells
   *  - 'beach': surf wash + occasional gull cries
   *  - 'night': sparse crickets over a thin wind bed
   * Calling startAmbience again swaps the bed; stopAmbience() / stop() ends it.
   */
  function startAmbience(kind = 'street') {
    if (!ctx) return;
    stopAmbience();
    const t = ctx.currentTime;
    const nodes = [];
    const timers = [];

    const bed = ctx.createGain();
    bed.gain.value = 0.0001;
    bed.connect(bus.street);
    bed.gain.setTargetAtTime(0.05, t, 1.5);
    nodes.push(bed);

    if (kind === 'beach') {
      // Surf: looped noise through a slow-breathing lowpass, 0.12 Hz swell.
      const surf = noiseSrc(true);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const swell = ctx.createOscillator();
      swell.type = 'sine';
      swell.frequency.value = 0.12;
      const swellGain = ctx.createGain();
      swellGain.gain.value = 220;
      swell.connect(swellGain);
      swellGain.connect(lp.frequency);
      const surfGain = ctx.createGain();
      surfGain.gain.value = 0.5;
      surf.connect(lp);
      lp.connect(surfGain);
      surfGain.connect(bed);
      surf.start(t);
      swell.start(t);
      nodes.push(surf, swell);

      // Gulls: a descending two-note cry every 4-9 s, randomised so it never loops audibly.
      const gull = () => {
        if (!ctx || !ambienceVoice) return;
        const now = ctx.currentTime;
        const f = 1400 + Math.random() * 700;
        blip(f, f * 0.62, 0.28, 0.05, 'sine', bed);
        if (Math.random() < 0.5) {
          setTimeout(() => blip(f * 0.9, f * 0.55, 0.22, 0.04, 'sine', bed), 320);
        }
      };
      timers.push(setInterval(gull, 4500 + Math.random() * 4500));
    } else if (kind === 'night') {
      // Crickets: three high sine chirps in a slow rotation, over a thin wind bed.
      const wind = noiseSrc(true);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      const wg = ctx.createGain();
      wg.gain.value = 0.35;
      wind.connect(lp);
      lp.connect(wg);
      wg.connect(bed);
      wind.start(t);
      nodes.push(wind);

      let chirpStep = 0;
      const chirp = () => {
        if (!ctx || !ambienceVoice) return;
        chirpStep += 1;
        const base = 3800 + (chirpStep % 3) * 260;
        for (let i = 0; i < 3; i++) {
          setTimeout(() => blip(base, base * 0.94, 0.05, 0.03, 'sine', bed), i * 90);
        }
      };
      timers.push(setInterval(chirp, 1800));
    } else {
      // Street: brown-ish rumble (noise, heavy lowpass) + a passing-car swell every ~7 s.
      const rumble = noiseSrc(true);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 180;
      const rg = ctx.createGain();
      rg.gain.value = 0.8;
      rumble.connect(lp);
      lp.connect(rg);
      rg.connect(bed);
      rumble.start(t);
      nodes.push(rumble);

      const pass = () => {
        if (!ctx || !ambienceVoice) return;
        const now = ctx.currentTime;
        const src = noiseSrc();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(300, now);
        bp.frequency.linearRampToValueAtTime(900, now + 1.1);
        bp.frequency.linearRampToValueAtTime(300, now + 2.2);
        bp.Q.value = 1.2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.09, now + 1.1);
        g.gain.linearRampToValueAtTime(0.0001, now + 2.2);
        src.connect(bp);
        bp.connect(g);
        g.connect(bed);
        src.start(now);
        src.stop(now + 2.3);
      };
      timers.push(setInterval(pass, 7000));
    }

    ambienceVoice = { nodes, timers, bed };
  }

  function stopAmbience() {
    if (!ambienceVoice) return;
    const v = ambienceVoice;
    ambienceVoice = null;
    for (const timer of v.timers) clearInterval(timer);
    if (!ctx) return;
    const t = ctx.currentTime;
    v.bed.gain.setTargetAtTime(0.0001, t, 0.3);
    const kill = () => {
      for (const n of v.nodes) {
        try {
          if (typeof n.stop === 'function') n.stop();
        } catch {
          /* already stopped */
        }
        try {
          n.disconnect();
        } catch {
          /* already detached */
        }
      }
    };
    if (typeof setTimeout === 'function') setTimeout(kill, 900);
    else kill();
  }

  // ------------------------------------------------------------ score

  /**
   * The slow score bed: three detuned sine pads drifting through the pentatonic scale, one chord
   * every ~4 s, plus a sub pulse that breathes on a 0.16 Hz LFO. Starts once; setHour() re-voices
   * its brightness filter.
   */
  function music() {
    if (!ctx || scoreRunning) return;
    scoreRunning = true;
    const t = ctx.currentTime;

    const pads = [];
    for (let i = 0; i < 3; i++) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.055, t + 7 + i * 0.9);
      g.connect(scoreFilter);
      const a = ctx.createOscillator();
      a.type = 'sine';
      a.detune.value = -6;
      const b = ctx.createOscillator();
      b.type = 'sine';
      b.detune.value = 7; // a few cents apart: slow beating reads as a section, not a test tone
      a.connect(g);
      b.connect(g);
      const note = SCORE_SCALE[(i * 3) % SCORE_SCALE.length];
      a.frequency.value = noteToHz(note);
      b.frequency.value = noteToHz(note) * 2;
      a.start(t);
      b.start(t);
      pads.push({ a, b, g, note });
    }

    let step = 0;
    const advance = () => {
      if (!ctx || !scoreRunning) return;
      const now = ctx.currentTime;
      step += 1;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        const note = SCORE_SCALE[(step * 2 + i * 3) % SCORE_SCALE.length];
        pad.note = note;
        pad.a.frequency.setTargetAtTime(noteToHz(note), now, 1.6);
        pad.b.frequency.setTargetAtTime(noteToHz(note) * 2, now, 1.6);
      }
    };
    const timer = setInterval(advance, 4200);

    // Sub pulse: 55 Hz sine whose level rides a 0.16 Hz LFO — it breathes, never ticks.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = noteToHz(33);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.014;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.16;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.008;
    lfo.connect(lfoGain);
    lfoGain.connect(subGain.gain);
    const subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.value = 220;
    sub.connect(subFilter);
    subFilter.connect(subGain);
    subGain.connect(scoreFilter);
    sub.start(t);
    lfo.start(t);

    scoreVoice = { pads, sub, lfo, timer };
  }

  // ------------------------------------------------------------ teardown

  function stopScore() {
    if (!scoreVoice) return;
    const v = scoreVoice;
    scoreVoice = null;
    scoreRunning = false;
    clearInterval(v.timer);
    if (!ctx) return;
    for (const pad of v.pads) {
      try {
        pad.a.stop();
        pad.b.stop();
      } catch {
        /* already stopped */
      }
    }
    try {
      v.sub.stop();
      v.lfo.stop();
    } catch {
      /* already stopped */
    }
  }

  /** Stop every voice at once: engines, siren, ambience and score. */
  function stop() {
    stopAmbience();
    stopScore();
    siren(false);
    for (const handle of Array.from(engines.values())) handle.stop();
    engines.clear();
  }

  function dispose() {
    stop();
    if (ctx) {
      const closing = ctx;
      ctx = null;
      masterGain = null;
      bus = null;
      scoreFilter = null;
      noiseBuf = null;
      try {
        closing.close();
      } catch {
        /* already closed */
      }
    }
  }

  return {
    unlock,
    engine,
    siren,
    gunshot,
    explosion,
    footstep,
    ui,
    play,
    music,
    startAmbience,
    stopAmbience,
    stop,
    setHour,
    mute,
    isMuted,
    dispose,
    /** Bus gains, so a menu can duck the street under a sting. Null until unlock(). */
    buses: {
      get street() {
        return bus ? bus.street : null;
      },
      get ui() {
        return bus ? bus.ui : null;
      },
      get score() {
        return bus ? bus.score : null;
      },
      // Back-compat aliases for callers that think in world/ui/music terms.
      get world() {
        return bus ? bus.street : null;
      },
      get music() {
        return bus ? bus.score : null;
      },
    },
  };
}
