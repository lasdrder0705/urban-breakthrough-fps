(() => {
  'use strict';

  window.DF = window.DF || {};

  // ============================================================================
  // DF.Audio — Procedural Web Audio Battlefield Soundscape & Adaptive Score
  // Zero external assets. Lazy-unlocked on first gesture. Safe in headless mode.
  // ============================================================================

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  // State
  let ctx = null;
  let initialized = false;
  let unlocked = false;
  let muted = false;

  // Buses
  let masterGain = null;
  let compressor = null;
  let sfxGain = null;
  let uiGain = null;
  let musicGain = null;
  let ambienceGain = null;
  let reverbSendGain = null;
  let reverbNode = null;
  let reverbReturnGain = null;

  // Distortion waveshaper curves
  let softClipCurve = null;
  let hardDriveCurve = null;

  // Reusable noise buffers
  let whiteBuf = null;
  let pinkBuf = null;
  let crackBuf = null;

  // Volumes
  const volumes = {
    master: 0.82,
    sfx: 0.90,
    music: 0.55
  };

  // Listener spatial transform
  const listener = {
    pos: [0, 1.7, 0],
    yaw: 0,
    pitch: 0,
    right: [1, 0, 0],
    forward: [0, 0, -1]
  };

  // Polyphony / throttling guard
  let activeShotVoices = 0;
  let lastWhizTime = 0;
  let lastCasingTime = 0;
  let lastImpactTime = 0;
  let lastFootstepTime = 0;
  let footstepParity = 0;
  const MAX_SHOT_VOICES = 18;

  // Continuous loop nodes
  let loopsReady = false;
  const loops = {
    // Tank / IFV diesel engine + track clatter
    engineOsc1: null,
    engineOsc2: null,
    engineSub: null,
    engineFilter: null,
    engineGain: null,
    trackSrc: null,
    trackFilter: null,
    trackGain: null,
    trackLfo: null,
    trackLfoGain: null,

    // Quadcopter dual-rotor harmonic hum
    droneOsc1: null,
    droneOsc2: null,
    droneOsc3: null,
    droneFilter: null,
    droneGain: null,
    dronePan: null,

    // Robot dog electric servo whir
    dogOsc: null,
    dogFilter: null,
    dogGain: null,
    dogPan: null,

    // Donbas urban wind ambience
    windSrc: null,
    windFilter: null,
    windGain: null,
    windPhase: 0,

    // Distant artillery timer
    distantArtyTimer: 5.5
  };

  // Adaptive Cinematic Combat Score state (108 BPM, D minor / Phrygian)
  const music = {
    step: 0,
    accum: 0,
    stepDur: 60 / 108 / 4, // 16th note ~0.1389s
    intensity: 0.12,
    smoothIntensity: 0.12,
    droneOscA: null,
    droneOscB: null,
    droneOscC: null,
    droneFilter: null,
    droneGain: null,
    chordIdx: 0,
    ready: false
  };

  // Musical tables (Hz) — Dm, Bb, Gm, A7sus4 dark cinematic Eastern European palette
  const CHORD_ROOTS = [73.42, 58.27, 49.00, 55.00]; // D2, Bb1, G1, A1
  const CHORD_FIFTHS = [110.00, 87.31, 73.42, 82.41]; // A2, F2, D2, E2
  const CHORD_THIRDS = [174.61, 146.83, 116.54, 146.83]; // F3, D3, Bb2, D3
  // 16-step dark bass ostinato in semitone offsets from current chord root (Phrygian flavor)
  const BASS_PATTERN = [0, 0, 12, 0, 1, 0, 7, 0, 0, 0, 12, 0, 3, 1, 0, -2];
  const BRASS_MOTIF = [
    293.66, 0, 0, 0, 311.13, 0, 293.66, 0,
    261.63, 0, 0, 0, 220.00, 0, 0, 0
  ]; // D4, Eb4, D4, C4, A3

  function makeDistortionCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function createNoiseBuffers(audioCtx) {
    const sr = audioCtx.sampleRate;

    // 1. White noise (2.0s)
    whiteBuf = audioCtx.createBuffer(1, Math.floor(sr * 2.0), sr);
    const wData = whiteBuf.getChannelData(0);
    for (let i = 0; i < wData.length; i++) {
      wData[i] = Math.random() * 2 - 1;
    }

    // 2. Pink noise (2.5s) — Paul Kellet 7-pole approximation
    pinkBuf = audioCtx.createBuffer(1, Math.floor(sr * 2.5), sr);
    const pData = pinkBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < pData.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      pData[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.14, -1, 1);
      b6 = white * 0.115926;
    }

    // 3. Sharp transient crack noise (0.45s) — spiked impulses for ballistic snaps
    crackBuf = audioCtx.createBuffer(1, Math.floor(sr * 0.45), sr);
    const cData = crackBuf.getChannelData(0);
    for (let i = 0; i < cData.length; i++) {
      const env = Math.exp(-i / (sr * 0.055));
      const r = Math.random() * 2 - 1;
      cData[i] = Math.sign(r) * Math.pow(Math.abs(r), 0.65) * env;
    }
  }

  // Procedural Urban Canyon Impulse Response (Concrete Khrushchyovka boulevard slapback)
  function createUrbanCanyonIR(audioCtx) {
    const sr = audioCtx.sampleRate;
    const duration = 1.65;
    const length = Math.floor(sr * duration);
    const ir = audioCtx.createBuffer(2, length, sr);
    const chL = ir.getChannelData(0);
    const chR = ir.getChannelData(1);

    // Early discrete street-alley facade reflections (asymmetric L/R concrete bounce)
    const tapsL = [
      [0.019, 0.72], [0.036, 0.55], [0.058, 0.44], [0.084, 0.34],
      [0.118, 0.27], [0.162, 0.21], [0.215, 0.16], [0.285, 0.11]
    ];
    const tapsR = [
      [0.023, 0.68], [0.043, 0.52], [0.067, 0.40], [0.095, 0.31],
      [0.132, 0.24], [0.178, 0.19], [0.236, 0.14], [0.305, 0.10]
    ];

    const injectTap = (buf, timeSec, amp) => {
      const idx = Math.floor(timeSec * sr);
      const spread = Math.floor(0.005 * sr);
      for (let k = 0; k < spread && idx + k < length; k++) {
        const w = Math.exp(-k / (spread * 0.35));
        buf[idx + k] += (Math.random() * 2 - 1) * amp * w;
      }
    };

    for (let i = 0; i < tapsL.length; i++) injectTap(chL, tapsL[i][0], tapsL[i][1]);
    for (let i = 0; i < tapsR.length; i++) injectTap(chR, tapsR[i][0], tapsR[i][1]);

    // Diffuse canyon tail with progressive air-damping lowpass
    let lpL = 0;
    let lpR = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const decay = Math.exp(-t * 2.85) * (t < 0.025 ? t / 0.025 : 1.0);
      const damp = clamp(0.18 + 0.65 * Math.exp(-t * 1.9), 0.12, 0.85);
      const nL = (Math.random() * 2 - 1) * decay * 0.32;
      const nR = (Math.random() * 2 - 1) * decay * 0.32;
      lpL += (nL - lpL) * damp;
      lpR += (nR - lpR) * damp;
      chL[i] = clamp(chL[i] + lpL, -1, 1);
      chR[i] = clamp(chR[i] + lpR, -1, 1);
    }

    return ir;
  }

  function applyVolumes(immediate) {
    if (!ctx || !masterGain) return;
    const now = ctx.currentTime;
    const m = muted ? 0 : clamp(volumes.master, 0, 1);
    const s = clamp(volumes.sfx, 0, 1);
    const mu = clamp(volumes.music, 0, 1);
    if (immediate) {
      masterGain.gain.setValueAtTime(m, now);
      sfxGain.gain.setValueAtTime(s, now);
      musicGain.gain.setValueAtTime(mu * 0.62, now);
      ambienceGain.gain.setValueAtTime(s * 0.55, now);
      uiGain.gain.setValueAtTime(clamp(s * 0.88, 0, 1), now);
    } else {
      masterGain.gain.setTargetAtTime(m, now, 0.03);
      sfxGain.gain.setTargetAtTime(s, now, 0.03);
      musicGain.gain.setTargetAtTime(mu * 0.62, now, 0.06);
      ambienceGain.gain.setTargetAtTime(s * 0.55, now, 0.05);
      uiGain.gain.setTargetAtTime(clamp(s * 0.88, 0, 1), now, 0.03);
    }
  }

  function ensureContext() {
    if (ctx) {
      if (ctx.state === 'suspended') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) { /* ignore */ }
      }
      return ctx;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      ctx = new AudioCtx();
    } catch (_) {
      return null;
    }

    // Master chain with broadcast dynamics limiter
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -9;
    compressor.knee.value = 14;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.16;

    masterGain = ctx.createGain();
    sfxGain = ctx.createGain();
    uiGain = ctx.createGain();
    musicGain = ctx.createGain();
    ambienceGain = ctx.createGain();

    // Urban canyon convolver reverb bus
    reverbSendGain = ctx.createGain();
    reverbSendGain.gain.value = 1.0;
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = createUrbanCanyonIR(ctx);
    reverbReturnGain = ctx.createGain();
    reverbReturnGain.gain.value = 0.52;

    reverbSendGain.connect(reverbNode);
    reverbNode.connect(reverbReturnGain);
    reverbReturnGain.connect(sfxGain);

    sfxGain.connect(masterGain);
    ambienceGain.connect(sfxGain);
    musicGain.connect(masterGain);
    uiGain.connect(masterGain);

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    softClipCurve = makeDistortionCurve(24);
    hardDriveCurve = makeDistortionCurve(75);
    createNoiseBuffers(ctx);

    applyVolumes(true);
    setupContinuousLoops();
    setupMusicDrone();

    return ctx;
  }

  function setupContinuousLoops() {
    if (!ctx || loopsReady) return;
    loopsReady = true;
    const now = ctx.currentTime;

    // 1. Diesel Tank/IFV Engine + Metallic Track Clatter
    loops.engineOsc1 = ctx.createOscillator();
    loops.engineOsc1.type = 'sawtooth';
    loops.engineOsc1.frequency.setValueAtTime(36, now);

    loops.engineOsc2 = ctx.createOscillator();
    loops.engineOsc2.type = 'sawtooth';
    loops.engineOsc2.frequency.setValueAtTime(54.2, now);

    loops.engineSub = ctx.createOscillator();
    loops.engineSub.type = 'triangle';
    loops.engineSub.frequency.setValueAtTime(24, now);

    loops.engineFilter = ctx.createBiquadFilter();
    loops.engineFilter.type = 'lowpass';
    loops.engineFilter.frequency.setValueAtTime(140, now);
    loops.engineFilter.Q.value = 3.2;

    loops.engineGain = ctx.createGain();
    loops.engineGain.gain.setValueAtTime(0, now);

    loops.engineOsc1.connect(loops.engineFilter);
    loops.engineOsc2.connect(loops.engineFilter);
    loops.engineSub.connect(loops.engineFilter);
    loops.engineFilter.connect(loops.engineGain);
    loops.engineGain.connect(sfxGain);

    loops.engineOsc1.start(now);
    loops.engineOsc2.start(now);
    loops.engineSub.start(now);

    // Metallic track clatter (bandpassed pink noise rhythmically gated by LFO)
    loops.trackSrc = ctx.createBufferSource();
    loops.trackSrc.buffer = pinkBuf;
    loops.trackSrc.loop = true;

    loops.trackFilter = ctx.createBiquadFilter();
    loops.trackFilter.type = 'bandpass';
    loops.trackFilter.frequency.setValueAtTime(720, now);
    loops.trackFilter.Q.value = 2.4;

    loops.trackGain = ctx.createGain();
    loops.trackGain.gain.setValueAtTime(0, now);

    loops.trackLfo = ctx.createOscillator();
    loops.trackLfo.type = 'sine';
    loops.trackLfo.frequency.setValueAtTime(9, now);
    loops.trackLfoGain = ctx.createGain();
    loops.trackLfoGain.gain.setValueAtTime(0, now);

    loops.trackLfo.connect(loops.trackLfoGain);
    loops.trackLfoGain.connect(loops.trackGain.gain);

    loops.trackSrc.connect(loops.trackFilter);
    loops.trackFilter.connect(loops.trackGain);
    loops.trackGain.connect(sfxGain);
    loops.trackSrc.start(now);
    loops.trackLfo.start(now);

    // 2. Quadcopter / FPV Drone Dual-Rotor Harmonic Hum
    loops.droneOsc1 = ctx.createOscillator();
    loops.droneOsc1.type = 'sawtooth';
    loops.droneOsc1.frequency.setValueAtTime(192, now);

    loops.droneOsc2 = ctx.createOscillator();
    loops.droneOsc2.type = 'sawtooth';
    loops.droneOsc2.frequency.setValueAtTime(196.8, now); // dual-rotor beat

    loops.droneOsc3 = ctx.createOscillator();
    loops.droneOsc3.type = 'triangle';
    loops.droneOsc3.frequency.setValueAtTime(388, now);

    loops.droneFilter = ctx.createBiquadFilter();
    loops.droneFilter.type = 'bandpass';
    loops.droneFilter.frequency.setValueAtTime(520, now);
    loops.droneFilter.Q.value = 1.6;

    loops.droneGain = ctx.createGain();
    loops.droneGain.gain.setValueAtTime(0, now);

    loops.dronePan = createPanner(0);
    loops.droneOsc1.connect(loops.droneFilter);
    loops.droneOsc2.connect(loops.droneFilter);
    loops.droneOsc3.connect(loops.droneFilter);
    loops.droneFilter.connect(loops.droneGain);
    loops.droneGain.connect(loops.dronePan);
    loops.dronePan.connect(sfxGain);

    loops.droneOsc1.start(now);
    loops.droneOsc2.start(now);
    loops.droneOsc3.start(now);

    // 3. Robot Dog Electric Actuator Servo Whir
    loops.dogOsc = ctx.createOscillator();
    loops.dogOsc.type = 'sawtooth';
    loops.dogOsc.frequency.setValueAtTime(420, now);

    loops.dogFilter = ctx.createBiquadFilter();
    loops.dogFilter.type = 'bandpass';
    loops.dogFilter.frequency.setValueAtTime(680, now);
    loops.dogFilter.Q.value = 4.5;

    loops.dogGain = ctx.createGain();
    loops.dogGain.gain.setValueAtTime(0, now);

    loops.dogPan = createPanner(0);
    loops.dogOsc.connect(loops.dogFilter);
    loops.dogFilter.connect(loops.dogGain);
    loops.dogGain.connect(loops.dogPan);
    loops.dogPan.connect(sfxGain);
    loops.dogOsc.start(now);

    // 4. Cold Donbas Urban Wind Ambience
    loops.windSrc = ctx.createBufferSource();
    loops.windSrc.buffer = pinkBuf;
    loops.windSrc.loop = true;

    loops.windFilter = ctx.createBiquadFilter();
    loops.windFilter.type = 'bandpass';
    loops.windFilter.frequency.setValueAtTime(340, now);
    loops.windFilter.Q.value = 1.4;

    loops.windGain = ctx.createGain();
    loops.windGain.gain.setValueAtTime(0.09, now);

    loops.windSrc.connect(loops.windFilter);
    loops.windFilter.connect(loops.windGain);
    loops.windGain.connect(ambienceGain);
    loops.windSrc.start(now);
  }

  function setupMusicDrone() {
    if (!ctx || music.ready) return;
    music.ready = true;
    const now = ctx.currentTime;

    // Dark Eastern European bowed-cello / synth string pad (3 detuned voices)
    music.droneOscA = ctx.createOscillator();
    music.droneOscB = ctx.createOscillator();
    music.droneOscC = ctx.createOscillator();
    music.droneOscA.type = 'sawtooth';
    music.droneOscB.type = 'sawtooth';
    music.droneOscC.type = 'triangle';

    music.droneOscA.frequency.setValueAtTime(CHORD_ROOTS[0], now);
    music.droneOscB.frequency.setValueAtTime(CHORD_FIFTHS[0] * 1.003, now);
    music.droneOscC.frequency.setValueAtTime(CHORD_THIRDS[0] * 0.997, now);

    music.droneFilter = ctx.createBiquadFilter();
    music.droneFilter.type = 'lowpass';
    music.droneFilter.frequency.setValueAtTime(420, now);
    music.droneFilter.Q.value = 1.2;

    music.droneGain = ctx.createGain();
    music.droneGain.gain.setValueAtTime(0.16, now);

    music.droneOscA.connect(music.droneFilter);
    music.droneOscB.connect(music.droneFilter);
    music.droneOscC.connect(music.droneFilter);
    music.droneFilter.connect(music.droneGain);
    music.droneGain.connect(musicGain);
    // Subtle dark reverb bloom on strings
    const padSend = ctx.createGain();
    padSend.gain.value = 0.28;
    music.droneGain.connect(padSend);
    padSend.connect(reverbSendGain);

    music.droneOscA.start(now);
    music.droneOscB.start(now);
    music.droneOscC.start(now);
  }

  function createPanner(panVal) {
    if (ctx && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(panVal, -1, 1);
      return p;
    }
    return ctx.createGain();
  }

  // Compute distance attenuation, stereo pan, air-absorption cutoff, and urban reverb ratio
  function computeSpatial(pos, isPlayer, maxDist) {
    if (isPlayer || !pos) {
      return { gain: 1.0, pan: 0, cutoff: 18000, reverb: 0.24, dist: 0 };
    }
    const dx = pos[0] - listener.pos[0];
    const dy = (pos[1] || 0) - listener.pos[1];
    const dz = pos[2] - listener.pos[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const refDist = 7.5;
    const limit = maxDist || 175;
    if (dist > limit) {
      return { gain: 0, pan: 0, cutoff: 1200, reverb: 0, dist };
    }
    const atten = clamp(refDist / (refDist + dist * 0.95), 0, 1) * Math.pow(1 - dist / limit, 0.7);
    const invD = dist > 0.01 ? 1 / dist : 0;
    const pan = clamp((dx * listener.right[0] + dz * listener.right[2]) * invD, -0.95, 0.95);
    // Air absorption: distant fire loses crisp highs and becomes punchy/echoing
    const cutoff = clamp(16000 * Math.exp(-dist * 0.022), 1150, 16000);
    // Urban canyon reverb increases proportionally with distance
    const reverb = clamp(0.18 + (dist / 85) * 0.68, 0.18, 0.85);
    return { gain: atten, pan, cutoff, reverb, dist };
  }

  function isReady() {
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore */ }
    }
    return ctx.state === 'running';
  }

  function routeSpatial(node, sp, extraReverb) {
    const dryGain = ctx.createGain();
    dryGain.gain.value = sp.gain;

    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = sp.cutoff;

    const panner = createPanner(sp.pan);

    node.connect(lpf);
    lpf.connect(dryGain);
    dryGain.connect(panner);
    panner.connect(sfxGain);

    const revAmt = clamp(sp.reverb * (extraReverb !== undefined ? extraReverb : 1.0) * sp.gain, 0, 0.95);
    if (revAmt > 0.015) {
      const wetGain = ctx.createGain();
      wetGain.gain.value = revAmt;
      panner.connect(wetGain);
      wetGain.connect(reverbSendGain);
    }
    return { dryGain, lpf, panner };
  }

  // Normalize caliber/weapon alias to one of the 11 core acoustic profiles
  function resolveGunProfile(profile) {
    if (!profile) return 'ar_556';
    const k = String(profile).toLowerCase();
    if (k === 'ar_556' || k.includes('m4') || k.includes('uar') || k.includes('556')) return 'ar_556';
    if (k === 'ar_545' || k.includes('ak') || k.includes('545')) return 'ar_545';
    if (k === 'lmg' || k.includes('m249') || k.includes('pkm') || k.includes('saw')) return 'lmg';
    if (k === 'sniper' || k.includes('m24') || k.includes('svd') || k.includes('dragunov')) return 'sniper';
    if (k === 'shotgun' || k.includes('m870') || k.includes('saiga') || k.includes('12ga')) return 'shotgun';
    if (k === 'gl' || k.includes('m320') || k.includes('gp25') || k.includes('gp-25') || k.includes('40mm')) return 'gl';
    if (k === 'rpg' || k.includes('rocket') || k.includes('atgm')) return 'rpg';
    if (k === 'tank_125' || k.includes('tank') || k.includes('125') || k.includes('t64') || k.includes('t72')) return 'tank_125';
    if (k === 'autocannon' || k.includes('ifv') || k.includes('30mm') || k.includes('25mm') || k.includes('bradley') || k.includes('bmp')) return 'autocannon';
    if (k === 'coax' || k.includes('pkt')) return 'coax';
    if (k === 'dog_rws' || k.includes('dog') || k.includes('rws') || k.includes('suppressed')) return 'dog_rws';
    return 'ar_556';
  }

  // ============================================================================
  // Caliber-Accurate Procedural Gunshots
  // ============================================================================
  function playGunshot(profile, pos, isPlayer) {
    if (!isReady() || muted) return;
    const p = resolveGunProfile(profile);
    const maxDist = (p === 'tank_125' || p === 'rpg' || p === 'sniper') ? 240 : 165;
    const sp = computeSpatial(pos, !!isPlayer, maxDist);
    if (sp.gain < 0.015) return;

    // Polyphony protection for distant AI fire
    if (!isPlayer && activeShotVoices >= MAX_SHOT_VOICES) return;
    activeShotVoices++;

    const now = ctx.currentTime;
    const jitter = rand(0.955, 1.045);

    const outBus = ctx.createGain();
    outBus.gain.value = 1.0;

    let reverbScale = 1.0;
    let voiceDuration = 0.35;

    if (p === 'ar_556') {
      reverbScale = 0.95;
      voiceDuration = 0.24;
      // 1. High-velocity supersonic crack
      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = 1.25 * jitter;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2400 * jitter, now);
      bp.Q.value = 0.9;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.95, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      n.connect(bp); bp.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.14);

      // 2. Crisp chest punch
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(165 * jitter, now);
      osc.frequency.exponentialRampToValueAtTime(46, now + 0.075);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.75, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(og); og.connect(outBus);
      osc.start(now); osc.stop(now + 0.095);

      // 3. Player bolt/buffer spring metallic transient
      if (isPlayer) {
        const mech = ctx.createOscillator();
        mech.type = 'square';
        mech.frequency.setValueAtTime(3600 * jitter, now + 0.012);
        mech.frequency.exponentialRampToValueAtTime(1400, now + 0.045);
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(0.11, now + 0.012);
        mg.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        mech.connect(mg); mg.connect(outBus);
        mech.start(now + 0.012); mech.stop(now + 0.055);
      }

    } else if (p === 'ar_545') {
      reverbScale = 1.05;
      voiceDuration = 0.27;
      // Punchy AK bark (strong mid-low muzzle brake slap + heavy steel bolt clack)
      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = 0.96 * jitter;
      const shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1450 * jitter, now);
      bp.Q.value = 0.75;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(1.05, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      n.connect(bp); bp.connect(shaper); shaper.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.17);

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(215 * jitter, now);
      osc.frequency.exponentialRampToValueAtTime(52, now + 0.095);
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 460;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.88, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      osc.connect(lpf); lpf.connect(og); og.connect(outBus);
      osc.start(now); osc.stop(now + 0.115);

      if (isPlayer) {
        const bolt = ctx.createOscillator();
        bolt.type = 'triangle';
        bolt.frequency.setValueAtTime(2400 * jitter, now + 0.018);
        bolt.frequency.exponentialRampToValueAtTime(920, now + 0.06);
        const bg = ctx.createGain();
        bg.gain.setValueAtTime(0.16, now + 0.018);
        bg.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        bolt.connect(bg); bg.connect(outBus);
        bolt.start(now + 0.018); bolt.stop(now + 0.07);
      }

    } else if (p === 'lmg') {
      reverbScale = 1.2;
      voiceDuration = 0.30;
      // Heavy rhythmic thunder + saturated bark
      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = 0.85 * jitter;
      const drive = ctx.createWaveShaper();
      drive.curve = hardDriveCurve;
      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass';
      bp.frequency.setValueAtTime(3400, now);
      bp.frequency.exponentialRampToValueAtTime(520, now + 0.19);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.95, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.21);
      n.connect(drive); drive.connect(bp); bp.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.22);

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(140 * jitter, now);
      sub.frequency.exponentialRampToValueAtTime(38, now + 0.12);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.92, now);
      sg.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      sub.connect(sg); sg.connect(outBus);
      sub.start(now); sub.stop(now + 0.15);

    } else if (p === 'sniper') {
      reverbScale = 1.65;
      voiceDuration = 0.55;
      // Deep echoing supersonic crack
      const whip = ctx.createBufferSource();
      whip.buffer = crackBuf;
      whip.playbackRate.value = 1.35 * jitter;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1100;
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(1.15, now);
      wg.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      whip.connect(hp); hp.connect(wg); wg.connect(outBus);
      whip.start(now); whip.stop(now + 0.25);

      const boom = ctx.createOscillator();
      boom.type = 'triangle';
      boom.frequency.setValueAtTime(135 * jitter, now);
      boom.frequency.exponentialRampToValueAtTime(30, now + 0.22);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(1.05, now);
      bg.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
      boom.connect(bg); bg.connect(outBus);
      boom.start(now); boom.stop(now + 0.27);

      const tail = ctx.createBufferSource();
      tail.buffer = pinkBuf;
      const tlpf = ctx.createBiquadFilter();
      tlpf.type = 'lowpass';
      tlpf.frequency.setValueAtTime(1400, now);
      tlpf.frequency.exponentialRampToValueAtTime(280, now + 0.48);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.55, now + 0.015);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.50);
      tail.connect(tlpf); tlpf.connect(tg); tg.connect(outBus);
      tail.start(now + 0.015); tail.stop(now + 0.52);

    } else if (p === 'shotgun') {
      reverbScale = 1.4;
      voiceDuration = 0.42;
      // Booming 12-gauge blast
      const n = ctx.createBufferSource();
      n.buffer = pinkBuf;
      const shaper = ctx.createWaveShaper();
      shaper.curve = hardDriveCurve;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(2800, now);
      lpf.frequency.exponentialRampToValueAtTime(320, now + 0.30);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(1.05, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.33);
      n.connect(shaper); shaper.connect(lpf); lpf.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.34);

      const chest = ctx.createOscillator();
      chest.type = 'sine';
      chest.frequency.setValueAtTime(108 * jitter, now);
      chest.frequency.exponentialRampToValueAtTime(28, now + 0.19);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(1.1, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      chest.connect(cg); cg.connect(outBus);
      chest.start(now); chest.stop(now + 0.23);

    } else if (p === 'gl') {
      reverbScale = 0.85;
      voiceDuration = 0.32;
      // Hollow 40mm 'THOOP' tube launch
      const tube = ctx.createOscillator();
      tube.type = 'triangle';
      tube.frequency.setValueAtTime(275 * jitter, now);
      tube.frequency.exponentialRampToValueAtTime(86 * jitter, now + 0.16);
      const tbp = ctx.createBiquadFilter();
      tbp.type = 'bandpass';
      tbp.frequency.setValueAtTime(220, now);
      tbp.Q.value = 3.6;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(1.15, now);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      tube.connect(tbp); tbp.connect(tg); tg.connect(outBus);
      tube.start(now); tube.stop(now + 0.24);

      // Hollow body layer
      const body = ctx.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(185 * jitter, now);
      body.frequency.exponentialRampToValueAtTime(64, now + 0.14);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.75, now);
      bg.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      body.connect(bg); bg.connect(outBus);
      body.start(now); body.stop(now + 0.17);

      // Pressurized propellant puff
      const puff = ctx.createBufferSource();
      puff.buffer = whiteBuf;
      const pbp = ctx.createBiquadFilter();
      pbp.type = 'bandpass';
      pbp.frequency.setValueAtTime(780, now);
      pbp.frequency.exponentialRampToValueAtTime(280, now + 0.15);
      pbp.Q.value = 1.2;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.42, now);
      pg.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      puff.connect(pbp); pbp.connect(pg); pg.connect(outBus);
      puff.start(now); puff.stop(now + 0.18);

    } else if (p === 'rpg') {
      reverbScale = 1.45;
      voiceDuration = 0.95;
      // 1. Booster ignition punch
      const ign = ctx.createOscillator();
      ign.type = 'triangle';
      ign.frequency.setValueAtTime(145, now);
      ign.frequency.exponentialRampToValueAtTime(34, now + 0.18);
      const ig = ctx.createGain();
      ig.gain.setValueAtTime(0.95, now);
      ig.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      ign.connect(ig); ig.connect(outBus);
      ign.start(now); ign.stop(now + 0.22);

      // 2. Whoosh + roaring rocket sustainer tail
      const roar = ctx.createBufferSource();
      roar.buffer = pinkBuf;
      const rbp = ctx.createBiquadFilter();
      rbp.type = 'bandpass';
      rbp.frequency.setValueAtTime(1850, now);
      rbp.frequency.exponentialRampToValueAtTime(420, now + 0.85);
      rbp.Q.value = 0.7;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.05, now);
      rg.gain.linearRampToValueAtTime(0.92, now + 0.045);
      rg.gain.exponentialRampToValueAtTime(0.001, now + 0.90);
      roar.connect(rbp); rbp.connect(rg); rg.connect(outBus);
      roar.start(now); roar.stop(now + 0.92);

    } else if (p === 'tank_125') {
      reverbScale = 1.85;
      voiceDuration = 1.25;
      // Massive 125mm smoothbore cannon: sub-bass shock + overloaded blast + steel breech ring
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(76 * jitter, now);
      sub.frequency.exponentialRampToValueAtTime(19, now + 0.45);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(1.35, now);
      sg.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      sub.connect(sg); sg.connect(outBus);
      sub.start(now); sub.stop(now + 0.68);

      const blast = ctx.createBufferSource();
      blast.buffer = pinkBuf;
      const drive = ctx.createWaveShaper();
      drive.curve = hardDriveCurve;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(2600, now);
      lpf.frequency.exponentialRampToValueAtTime(180, now + 0.95);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(1.25, now);
      bg.gain.exponentialRampToValueAtTime(0.001, now + 1.05);
      blast.connect(drive); drive.connect(lpf); lpf.connect(bg); bg.connect(outBus);
      blast.start(now); blast.stop(now + 1.1);

      // Metallic breech recoil ring (distinctive inside/near tank turret)
      if (isPlayer || sp.dist < 18) {
        const ring1 = ctx.createOscillator();
        const ring2 = ctx.createOscillator();
        ring1.type = 'sine';
        ring2.type = 'sine';
        ring1.frequency.setValueAtTime(1380 * jitter, now + 0.02);
        ring2.frequency.setValueAtTime(2210 * jitter, now + 0.02);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.22, now + 0.02);
        rg.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
        ring1.connect(rg); ring2.connect(rg); rg.connect(outBus);
        ring1.start(now + 0.02); ring2.start(now + 0.02);
        ring1.stop(now + 0.45); ring2.stop(now + 0.45);
      }

    } else if (p === 'autocannon') {
      reverbScale = 1.35;
      voiceDuration = 0.34;
      // Heavy mechanical 25mm/30mm thud
      const punch = ctx.createOscillator();
      punch.type = 'triangle';
      punch.frequency.setValueAtTime(125 * jitter, now);
      punch.frequency.exponentialRampToValueAtTime(35, now + 0.14);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(1.05, now);
      pg.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      punch.connect(pg); pg.connect(outBus);
      punch.start(now); punch.stop(now + 0.18);

      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = 0.72 * jitter;
      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass';
      bp.frequency.setValueAtTime(1900, now);
      bp.frequency.exponentialRampToValueAtTime(340, now + 0.24);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.98, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
      n.connect(bp); bp.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.28);

    } else if (p === 'coax') {
      reverbScale = 0.75;
      voiceDuration = 0.16;
      // Fast tight turret-mounted chatter
      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = 1.4 * jitter;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1350 * jitter, now);
      bp.Q.value = 1.4;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.75, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
      n.connect(bp); bp.connect(ng); ng.connect(outBus);
      n.start(now); n.stop(now + 0.095);

      const thump = ctx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(190 * jitter, now);
      thump.frequency.exponentialRampToValueAtTime(68, now + 0.05);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.55, now);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      thump.connect(tg); tg.connect(outBus);
      thump.start(now); thump.stop(now + 0.065);

    } else {
      // dog_rws — tight suppressed burst
      reverbScale = 0.45;
      voiceDuration = 0.15;
      const puff = ctx.createBufferSource();
      puff.buffer = whiteBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(980 * jitter, now);
      bp.Q.value = 1.6;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.55, now);
      pg.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
      puff.connect(bp); bp.connect(pg); pg.connect(outBus);
      puff.start(now); puff.stop(now + 0.085);

      const click = ctx.createOscillator();
      click.type = 'square';
      click.frequency.setValueAtTime(2900 * jitter, now);
      click.frequency.exponentialRampToValueAtTime(880, now + 0.028);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.24, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      click.connect(cg); cg.connect(outBus);
      click.start(now); click.stop(now + 0.04);
    }

    routeSpatial(outBus, sp, reverbScale);

    setTimeout(() => {
      activeShotVoices = Math.max(0, activeShotVoices - 1);
    }, Math.ceil(voiceDuration * 1000));
  }

  // ============================================================================
  // Synced Reload & Weapon Foley
  // ============================================================================
  function playReloadFoley(stage, pos) {
    if (!isReady() || muted) return;
    const isPlayer = !pos;
    const sp = computeSpatial(pos, isPlayer, 28);
    if (sp.gain < 0.02) return;

    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0.85;
    const s = String(stage || '').toLowerCase();

    const makeClick = (t, freqStart, freqEnd, dur, vol, type) => {
      const o = ctx.createOscillator();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freqStart, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(25, freqEnd), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(bus);
      o.start(t); o.stop(t + dur + 0.01);
    };

    const makeSlide = (t, freqStart, freqEnd, dur, vol, q) => {
      const n = ctx.createBufferSource();
      n.buffer = whiteBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(freqStart, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, freqEnd), t + dur);
      f.Q.value = q || 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(vol, t + Math.min(0.015, dur * 0.2));
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      n.connect(f); f.connect(g); g.connect(bus);
      n.start(t); n.stop(t + dur + 0.01);
    };

    if (s === 'mag_out') {
      makeClick(now, 3200, 1100, 0.028, 0.42, 'square'); // mag catch release
      makeSlide(now + 0.02, 1650, 720, 0.14, 0.34, 2.2); // magwell slide out
    } else if (s === 'mag_in') {
      makeSlide(now, 900, 1450, 0.065, 0.25, 2.0); // align into well
      makeClick(now + 0.055, 210, 62, 0.085, 0.72, 'triangle'); // solid seat thump
      makeClick(now + 0.065, 2900, 1300, 0.032, 0.44, 'square'); // latch lock click
    } else if (s === 'bolt_pull') {
      makeClick(now, 2400, 1500, 0.025, 0.36, 'square');
      makeSlide(now + 0.015, 2400, 3900, 0.11, 0.40, 3.8); // steel rail drag
      makeClick(now + 0.11, 1800, 880, 0.035, 0.38, 'triangle');
    } else if (s === 'bolt_release') {
      makeSlide(now, 3600, 1750, 0.045, 0.45, 3.2);
      makeClick(now + 0.03, 3100, 950, 0.042, 0.62, 'square'); // crisp steel slam
      makeClick(now + 0.03, 280, 85, 0.065, 0.58, 'triangle'); // receiver body thump
    } else if (s === 'pump') {
      // Iconic dual-stroke 12ga CHICK-CHACK
      makeSlide(now, 1900, 2900, 0.075, 0.45, 3.0);
      makeClick(now + 0.06, 2600, 1100, 0.03, 0.48, 'square');
      makeSlide(now + 0.135, 2700, 1600, 0.075, 0.50, 3.0);
      makeClick(now + 0.195, 2900, 980, 0.04, 0.58, 'square');
      makeClick(now + 0.195, 240, 78, 0.055, 0.48, 'triangle');
    } else if (s === 'shell_insert') {
      makeSlide(now, 1300, 1950, 0.055, 0.28, 2.6);
      makeClick(now + 0.045, 3400, 1500, 0.026, 0.42, 'square');
      makeClick(now + 0.05, 320, 140, 0.04, 0.32, 'triangle');
    } else if (s === 'rpg_load') {
      makeSlide(now, 620, 380, 0.22, 0.46, 2.8); // hollow launch tube insertion
      makeClick(now + 0.20, 480, 165, 0.09, 0.68, 'triangle'); // PG-7V warhead seat
      makeClick(now + 0.24, 2200, 1200, 0.035, 0.42, 'square'); // indexing notch lock
    } else if (s === 'breech_open' || s === 'breech_close') {
      makeClick(now, s === 'breech_open' ? 2100 : 2800, 740, 0.045, 0.52, 'square');
      makeClick(now + 0.015, 260, 90, 0.07, 0.48, 'triangle');
    } else if (s === 'dry_fire') {
      makeClick(now, 4200, 1600, 0.018, 0.46, 'square');
      makeClick(now, 620, 260, 0.025, 0.25, 'triangle');
    } else if (s === 'grenade_pin') {
      makeClick(now, 3800, 2400, 0.04, 0.38, 'sine');
      makeSlide(now + 0.02, 4200, 2800, 0.06, 0.24, 4.0);
    } else {
      // equip / weapon sling rustle
      makeSlide(now, 750, 480, 0.14, 0.26, 1.4);
      makeClick(now + 0.09, 260, 110, 0.055, 0.30, 'triangle');
    }

    routeSpatial(bus, sp, 0.25);
  }

  // ============================================================================
  // Physical Shell Casing Bounce Pings
  // ============================================================================
  function playCasingPing(pos, type) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    if (now - lastCasingTime < 0.035) return;
    lastCasingTime = now;

    const sp = computeSpatial(pos, false, 18);
    if (sp.gain < 0.04) return;

    const bus = ctx.createGain();
    bus.gain.value = 0.26;
    const isShell = type === 'shell';

    const bounceTimes = [0, rand(0.075, 0.11), rand(0.155, 0.21)];
    const bounceAmps = [1.0, 0.55, 0.26];

    for (let i = 0; i < bounceTimes.length; i++) {
      const t = now + bounceTimes[i];
      const baseF = isShell ? rand(1350, 1650) : rand(5600, 6800);
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = 'sine';
      o2.type = 'sine';
      o1.frequency.setValueAtTime(baseF, t);
      o2.frequency.setValueAtTime(baseF * (isShell ? 1.52 : 1.47), t);

      const g = ctx.createGain();
      g.gain.setValueAtTime(bounceAmps[i], t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (isShell ? 0.032 : 0.055));

      o1.connect(g);
      o2.connect(g);
      g.connect(bus);
      o1.start(t); o2.start(t);
      o1.stop(t + 0.06); o2.stop(t + 0.06);
    }

    routeSpatial(bus, sp, 0.35);
  }

  // ============================================================================
  // Material Bullet Impacts
  // ============================================================================
  function playImpact(material, pos) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    if (now - lastImpactTime < 0.025) return;
    lastImpactTime = now;

    const sp = computeSpatial(pos, false, 65);
    if (sp.gain < 0.03) return;

    const bus = ctx.createGain();
    bus.gain.value = 0.72;
    const mat = String(material || 'concrete').toLowerCase();

    if (mat === 'metal' || mat === 'armor' || mat === 'vehicle') {
      // Steel clank + ricochet whine
      const clank = ctx.createOscillator();
      clank.type = 'square';
      clank.frequency.setValueAtTime(rand(2200, 3100), now);
      clank.frequency.exponentialRampToValueAtTime(640, now + 0.055);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.45, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
      clank.connect(cg); cg.connect(bus);
      clank.start(now); clank.stop(now + 0.07);

      if (Math.random() < 0.65) {
        const ric = ctx.createOscillator();
        ric.type = 'sine';
        const f0 = rand(2100, 3600);
        ric.frequency.setValueAtTime(f0, now + 0.01);
        ric.frequency.exponentialRampToValueAtTime(f0 * rand(0.28, 0.45), now + 0.28);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.26, now + 0.01);
        rg.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
        ric.connect(rg); rg.connect(bus);
        ric.start(now + 0.01); ric.stop(now + 0.32);
      }

    } else if (mat === 'flesh' || mat === 'body' || mat === 'soldier') {
      // Muted wet thump
      const th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(165, now);
      th.frequency.exponentialRampToValueAtTime(48, now + 0.065);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.68, now);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
      th.connect(tg); tg.connect(bus);
      th.start(now); th.stop(now + 0.08);

    } else if (mat === 'wood') {
      // Hollow wooden crack + splinter
      const w = ctx.createOscillator();
      w.type = 'triangle';
      w.frequency.setValueAtTime(340, now);
      w.frequency.exponentialRampToValueAtTime(115, now + 0.07);
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.65, now);
      wg.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
      w.connect(wg); wg.connect(bus);
      w.start(now); w.stop(now + 0.09);

      const spN = ctx.createBufferSource();
      spN.buffer = crackBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1850;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.45, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      spN.connect(bp); bp.connect(ng); ng.connect(bus);
      spN.start(now); spN.stop(now + 0.09);

    } else if (mat === 'glass') {
      // Multi-shard crystalline shatter
      for (let i = 0; i < 4; i++) {
        const t = now + i * rand(0.012, 0.032);
        const sh = ctx.createOscillator();
        sh.type = 'sine';
        sh.frequency.setValueAtTime(rand(4200, 9600), t);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.24, t);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
        sh.connect(sg); sg.connect(bus);
        sh.start(t); sh.stop(t + 0.085);
      }

    } else {
      // Concrete / brick / rubble crack + tumbling grit
      const n = ctx.createBufferSource();
      n.buffer = crackBuf;
      n.playbackRate.value = rand(0.95, 1.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(rand(1400, 2400), now);
      bp.Q.value = 0.85;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.65, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      n.connect(bp); bp.connect(ng); ng.connect(bus);
      n.start(now); n.stop(now + 0.12);

      const chip = ctx.createOscillator();
      chip.type = 'triangle';
      chip.frequency.setValueAtTime(240, now);
      chip.frequency.exponentialRampToValueAtTime(72, now + 0.06);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.42, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      chip.connect(cg); cg.connect(bus);
      chip.start(now); chip.stop(now + 0.08);
    }

    routeSpatial(bus, sp, 0.45);
  }

  // ============================================================================
  // Multi-Layered Battlefield Explosions (Transient + Sub + Rumble + Debris)
  // ============================================================================
  function playExplosion(pos, scale) {
    if (!isReady() || muted) return;
    const sc = clamp(scale || 1.0, 0.35, 2.5);
    const sp = computeSpatial(pos, false, 240 * Math.max(1, sc * 0.7));
    if (sp.gain < 0.015) return;

    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = clamp(0.85 + sc * 0.25, 0.7, 1.45);

    // Layer 1: Instant overpressure crack
    const crack = ctx.createBufferSource();
    crack.buffer = crackBuf;
    crack.playbackRate.value = clamp(0.9 / Math.sqrt(sc), 0.45, 1.15);
    const drive = ctx.createWaveShaper();
    drive.curve = hardDriveCurve;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(1.1, now);
    cg.gain.exponentialRampToValueAtTime(0.001, now + 0.22 * sc);
    crack.connect(drive); drive.connect(cg); cg.connect(bus);
    crack.start(now); crack.stop(now + 0.24 * sc);

    // Layer 2: Chest-shaking sub-bass boom
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(86 / Math.pow(sc, 0.25), now);
    sub.frequency.exponentialRampToValueAtTime(16, now + 0.55 * sc);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(1.3, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.85 * sc);
    sub.connect(sg); sg.connect(bus);
    sub.start(now); sub.stop(now + 0.90 * sc);

    // Layer 3: Sustained fireball low-rumble
    const rumble = ctx.createBufferSource();
    rumble.buffer = pinkBuf;
    const rlpf = ctx.createBiquadFilter();
    rlpf.type = 'lowpass';
    rlpf.frequency.setValueAtTime(980, now);
    rlpf.frequency.exponentialRampToValueAtTime(95, now + 1.4 * sc);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.98, now + 0.01);
    rg.gain.exponentialRampToValueAtTime(0.001, now + 1.65 * sc);
    rumble.connect(rlpf); rlpf.connect(rg); rg.connect(bus);
    rumble.start(now); rumble.stop(now + 1.75 * sc);

    // Layer 4: Delayed falling rubble / concrete debris scatter
    const debrisCount = Math.min(7, Math.floor(3 + sc * 2.5));
    for (let i = 0; i < debrisCount; i++) {
      const dt = now + rand(0.28, 1.35 * sc);
      const dSrc = ctx.createBufferSource();
      dSrc.buffer = whiteBuf;
      const df = ctx.createBiquadFilter();
      df.type = 'bandpass';
      df.frequency.value = rand(900, 3200);
      df.Q.value = 1.8;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(rand(0.12, 0.28), dt);
      dg.gain.exponentialRampToValueAtTime(0.001, dt + rand(0.05, 0.14));
      dSrc.connect(df); df.connect(dg); dg.connect(bus);
      dSrc.start(dt); dSrc.stop(dt + 0.16);
    }

    routeSpatial(bus, sp, 1.85);
  }

  // ============================================================================
  // Supersonic Bullet Whiz / Crack Near Camera
  // ============================================================================
  function playBulletWhiz(pos) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    if (now - lastWhizTime < 0.085) return;
    lastWhizTime = now;

    const sp = computeSpatial(pos, false, 16);
    const bus = ctx.createGain();
    bus.gain.value = clamp(0.45 + sp.gain * 0.45, 0.25, 0.9);

    // Sharp supersonic shockwave snap
    const snap = ctx.createBufferSource();
    snap.buffer = crackBuf;
    snap.playbackRate.value = rand(1.5, 1.9);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.75, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    snap.connect(hp); hp.connect(sg); sg.connect(bus);
    snap.start(now); snap.stop(now + 0.05);

    // Doppler air-whip sweep
    const whiz = ctx.createBufferSource();
    whiz.buffer = whiteBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(rand(2400, 3400), now);
    bp.frequency.exponentialRampToValueAtTime(rand(360, 560), now + 0.13);
    bp.Q.value = 3.2;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.02, now);
    wg.gain.linearRampToValueAtTime(0.55, now + 0.025);
    wg.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    whiz.connect(bp); bp.connect(wg); wg.connect(bus);
    whiz.start(now); whiz.stop(now + 0.15);

    const panner = createPanner(sp.pan);
    bus.connect(panner);
    panner.connect(sfxGain);
  }

  // ============================================================================
  // Synced Tactical Footstep Foley (Asphalt/Wet, Concrete/Stairs, Rubble, Metal)
  // ============================================================================
  function playFootstep(surface, isSprint) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    if (now - lastFootstepTime < 0.14) return;
    lastFootstepTime = now;
    footstepParity = 1 - footstepParity;

    const sprint = !!isSprint;
    const surf = String(surface || 'asphalt').toLowerCase();
    const jitter = rand(0.92, 1.09) * (footstepParity ? 1.03 : 0.97);
    const volScale = sprint ? 0.34 : 0.21;

    const bus = ctx.createGain();
    bus.gain.value = volScale;

    // 1. Sole / heel impact body thump
    const thud = ctx.createOscillator();
    thud.type = 'triangle';
    const isConcrete = surf.includes('concrete') || surf.includes('stair') || surf.includes('floor') || surf.includes('interior') || surf.includes('brick');
    const isMetal = surf.includes('metal') || surf.includes('grate') || surf.includes('vehicle');
    const isRubble = surf.includes('rubble') || surf.includes('gravel') || surf.includes('dirt') || surf.includes('mud') || surf.includes('earth') || surf.includes('sand');
    const isWet = surf.includes('wet') || surf.includes('puddle') || surf.includes('asphalt') || surf.includes('road');

    const f0 = (isMetal ? 260 : isConcrete ? 175 : isRubble ? 120 : 138) * jitter;
    const f1 = (isMetal ? 95 : isConcrete ? 58 : 42) * jitter;
    thud.frequency.setValueAtTime(f0, now);
    thud.frequency.exponentialRampToValueAtTime(f1, now + 0.055);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(sprint ? 0.85 : 0.62, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.068);
    thud.connect(tg); tg.connect(bus);
    thud.start(now); thud.stop(now + 0.075);

    // 2. Surface texture layer
    if (isRubble) {
      // Multi-grain gravel / rubble crunch
      for (let i = 0; i < 3; i++) {
        const t = now + i * rand(0.014, 0.024);
        const gr = ctx.createBufferSource();
        gr.buffer = crackBuf;
        gr.playbackRate.value = rand(0.9, 1.45);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = rand(1400, 3600);
        bp.Q.value = 1.4;
        const gg = ctx.createGain();
        gg.gain.setValueAtTime((0.46 - i * 0.11) * (sprint ? 1.2 : 0.9), t);
        gg.gain.exponentialRampToValueAtTime(0.001, t + 0.042);
        gr.connect(bp); bp.connect(gg); gg.connect(bus);
        gr.start(t); gr.stop(t + 0.048);
      }
    } else if (isConcrete) {
      // Crisp hard indoor/stair heel tap
      const tap = ctx.createBufferSource();
      tap.buffer = crackBuf;
      tap.playbackRate.value = 1.25 * jitter;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1280 * jitter;
      bp.Q.value = 2.0;
      const tapG = ctx.createGain();
      tapG.gain.setValueAtTime(sprint ? 0.62 : 0.44, now);
      tapG.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      tap.connect(bp); bp.connect(tapG); tapG.connect(bus);
      tap.start(now); tap.stop(now + 0.052);
    } else if (isMetal) {
      // Resonant metallic boot clank
      const cl = ctx.createOscillator();
      cl.type = 'square';
      cl.frequency.setValueAtTime(880 * jitter, now);
      cl.frequency.exponentialRampToValueAtTime(340, now + 0.06);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.24, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      cl.connect(cg); cg.connect(bus);
      cl.start(now); cl.stop(now + 0.08);
    } else if (isWet) {
      // Wet Donbas asphalt boot grit + crisp splash-hiss
      const spl = ctx.createBufferSource();
      spl.buffer = whiteBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1650 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(3400, now + 0.045);
      bp.Q.value = 1.3;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(sprint ? 0.44 : 0.28, now);
      sg.gain.exponentialRampToValueAtTime(0.001, now + 0.062);
      spl.connect(bp); bp.connect(sg); sg.connect(bus);
      spl.start(now); spl.stop(now + 0.07);
    }

    // 3. Tactical vest / sling / cloth gear rustle when sprinting
    if (sprint) {
      const gear = ctx.createBufferSource();
      gear.buffer = pinkBuf;
      const gbp = ctx.createBiquadFilter();
      gbp.type = 'bandpass';
      gbp.frequency.setValueAtTime(2150 * jitter, now + 0.01);
      gbp.frequency.exponentialRampToValueAtTime(1180, now + 0.095);
      gbp.Q.value = 1.5;
      const gg = ctx.createGain();
      gg.gain.setValueAtTime(0.001, now + 0.01);
      gg.gain.linearRampToValueAtTime(0.26, now + 0.028);
      gg.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
      gear.connect(gbp); gbp.connect(gg); gg.connect(bus);
      gear.start(now + 0.01); gear.stop(now + 0.11);
    }

    const panner = createPanner(footstepParity ? 0.12 : -0.12);
    bus.connect(panner);
    panner.connect(sfxGain);

    // Subtle canyon/indoor reflection tail on concrete stairs/rooms
    if (isConcrete || isMetal) {
      const revSend = ctx.createGain();
      revSend.gain.value = 0.24;
      panner.connect(revSend);
      revSend.connect(reverbSendGain);
    }
  }

  // ============================================================================
  // Tactical Hitmarkers, Armor Clanks & Kill Confirmations
  // ============================================================================
  function playHitmarker(isKill, isHeadshot, isArmor) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;

    // Crisp tactical primary tick
    const tick = ctx.createOscillator();
    tick.type = isArmor ? 'square' : 'triangle';
    tick.frequency.setValueAtTime(isHeadshot ? 2900 : (isArmor ? 1180 : 1850), now);
    tick.frequency.exponentialRampToValueAtTime(isHeadshot ? 1400 : (isArmor ? 420 : 760), now + (isArmor ? 0.055 : 0.032));
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(isArmor ? 0.34 : 0.42, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + (isArmor ? 0.062 : 0.038));
    tick.connect(tg); tg.connect(uiGain);
    tick.start(now); tick.stop(now + 0.068);

    if (isArmor) {
      // Resonant armor steel ping
      const ping = ctx.createOscillator();
      ping.type = 'sine';
      ping.frequency.setValueAtTime(1640, now + 0.008);
      ping.frequency.exponentialRampToValueAtTime(1280, now + 0.11);
      const ag = ctx.createGain();
      ag.gain.setValueAtTime(0.24, now + 0.008);
      ag.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      ping.connect(ag); ag.connect(uiGain);
      ping.start(now + 0.008); ping.stop(now + 0.13);
    }

    if (isHeadshot) {
      // Crisp helmet metallic double-ding
      const ding = ctx.createOscillator();
      ding.type = 'sine';
      ding.frequency.setValueAtTime(3850, now + 0.018);
      ding.frequency.exponentialRampToValueAtTime(3400, now + 0.13);
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.32, now + 0.018);
      dg.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      ding.connect(dg); dg.connect(uiGain);
      ding.start(now + 0.018); ding.stop(now + 0.15);
    }

    if (isKill) {
      // Satisfying Battlefield low-punch + high confirmation chirp
      const punch = ctx.createOscillator();
      punch.type = 'sine';
      punch.frequency.setValueAtTime(220, now + 0.01);
      punch.frequency.exponentialRampToValueAtTime(68, now + 0.10);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.46, now + 0.01);
      pg.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      punch.connect(pg); pg.connect(uiGain);
      punch.start(now + 0.01); punch.stop(now + 0.12);

      const chirp = ctx.createOscillator();
      chirp.type = 'triangle';
      chirp.frequency.setValueAtTime(2450, now + 0.045);
      chirp.frequency.setValueAtTime(3100, now + 0.08);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.24, now + 0.045);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.145);
      chirp.connect(cg); cg.connect(uiGain);
      chirp.start(now + 0.045); chirp.stop(now + 0.15);
    }
  }

  // ============================================================================
  // Military Radio Squelch, Order Ack & UI Tones
  // ============================================================================
  function playRadioCue(type) {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    const t = String(type || 'order').toLowerCase();

    const squelch = (start, dur, vol) => {
      const n = ctx.createBufferSource();
      n.buffer = whiteBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1750;
      bp.Q.value = 2.0;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol || 0.14, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      n.connect(bp); bp.connect(g); g.connect(uiGain);
      n.start(start); n.stop(start + dur + 0.01);
    };

    const tone = (start, freq, dur, vol, wave) => {
      const o = ctx.createOscillator();
      o.type = wave || 'sine';
      o.frequency.setValueAtTime(freq, start);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol || 0.16, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.connect(g); g.connect(uiGain);
      o.start(start); o.stop(start + dur + 0.01);
    };

    if (t === 'ui_hover') {
      tone(now, 1180, 0.022, 0.05, 'triangle');
    } else if (t === 'ui_click') {
      tone(now, 1520, 0.03, 0.10, 'triangle');
    } else if (t === 'spot') {
      tone(now, 1320, 0.045, 0.14, 'triangle');
      tone(now + 0.05, 1760, 0.065, 0.16, 'triangle');
    } else if (t === 'order' || t === 'ack') {
      squelch(now, 0.04, 0.14);
      tone(now + 0.02, 980, 0.055, 0.14, 'sine');
      tone(now + 0.085, 1280, 0.075, 0.15, 'sine');
      squelch(now + 0.16, 0.055, 0.11);
    } else if (t === 'revive') {
      squelch(now, 0.035, 0.12);
      tone(now + 0.02, 740, 0.07, 0.15, 'triangle');
      tone(now + 0.09, 988, 0.07, 0.16, 'triangle');
      tone(now + 0.16, 1318, 0.11, 0.16, 'triangle');
    } else if (t === 'sector') {
      squelch(now, 0.05, 0.16);
      tone(now + 0.03, 440, 0.18, 0.18, 'sawtooth');
      tone(now + 0.22, 587.3, 0.28, 0.18, 'triangle');
    } else if (t === 'alert' || t === 'warning') {
      tone(now, 880, 0.075, 0.16, 'sawtooth');
      tone(now + 0.11, 660, 0.11, 0.16, 'sawtooth');
    } else if (t === 'drone') {
      // Encrypted UAV/UGV datalink handshake chirp
      tone(now, 1480, 0.04, 0.14, 'square');
      tone(now + 0.045, 2220, 0.055, 0.14, 'triangle');
      tone(now + 0.105, 1960, 0.08, 0.13, 'sine');
    } else if (t === 'start') {
      // Tactical deployment start confirmation chime
      squelch(now, 0.04, 0.14);
      tone(now + 0.02, 587.33, 0.09, 0.16, 'triangle');
      tone(now + 0.11, 880.0, 0.16, 0.17, 'triangle');
    } else if (t === 'victory') {
      // Dark solemn heroic minor-to-fifth resolution
      tone(now, 146.83, 0.9, 0.24, 'sawtooth');
      tone(now + 0.18, 220.00, 0.95, 0.22, 'triangle');
      tone(now + 0.42, 293.66, 1.35, 0.24, 'triangle');
      tone(now + 0.42, 440.00, 1.35, 0.14, 'sine');
    } else if (t === 'defeat') {
      tone(now, 174.61, 0.7, 0.22, 'sawtooth');
      tone(now + 0.35, 146.83, 0.9, 0.24, 'sawtooth');
      tone(now + 0.75, 110.00, 1.3, 0.26, 'triangle');
    } else {
      squelch(now, 0.045, 0.12);
      tone(now + 0.025, 1080, 0.06, 0.12, 'sine');
    }
  }

  // ============================================================================
  // Distant Horizon Artillery Rumble (Ambience)
  // ============================================================================
  function triggerDistantArtillery() {
    if (!isReady() || muted) return;
    const now = ctx.currentTime;
    const pan = rand(-0.85, 0.85);
    const vol = rand(0.08, 0.19);

    const src = ctx.createBufferSource();
    src.buffer = pinkBuf;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(rand(150, 260), now);
    lpf.frequency.exponentialRampToValueAtTime(55, now + 1.6);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.09);
    g.gain.exponentialRampToValueAtTime(0.001, now + rand(1.4, 2.3));

    const panner = createPanner(pan);
    src.connect(lpf); lpf.connect(g); g.connect(panner); panner.connect(ambienceGain);
    src.start(now); src.stop(now + 2.4);
  }

  // ============================================================================
  // Adaptive Cinematic Combat Score Step Sequencer
  // ============================================================================
  function stepMusic(dt, targetIntensity) {
    if (!isReady() || !music.ready) return;

    music.intensity = clamp(targetIntensity, 0, 1);
    music.smoothIntensity = lerp(music.smoothIntensity, music.intensity, clamp(dt * 1.4, 0, 1));

    const now = ctx.currentTime;
    const inten = music.smoothIntensity;

    // Continuously shape dark cello/synth string drone
    music.droneFilter.frequency.setTargetAtTime(280 + inten * 620, now, 0.15);
    music.droneGain.gain.setTargetAtTime(0.13 + inten * 0.12, now, 0.15);

    if (volumes.music <= 0.005 || muted) return;

    music.accum += dt;
    if (music.accum < music.stepDur) return;
    // Cap catch-up steps after tab sleep
    if (music.accum > music.stepDur * 3) music.accum = music.stepDur;

    while (music.accum >= music.stepDur) {
      music.accum -= music.stepDur;
      const step = music.step % 64;
      const barStep = step % 16;
      const chordIdx = Math.floor(step / 16) % 4;

      // Update pad chord on bar boundary
      if (barStep === 0 && chordIdx !== music.chordIdx) {
        music.chordIdx = chordIdx;
        music.droneOscA.frequency.setTargetAtTime(CHORD_ROOTS[chordIdx], now, 0.22);
        music.droneOscB.frequency.setTargetAtTime(CHORD_FIFTHS[chordIdx] * 1.003, now, 0.22);
        music.droneOscC.frequency.setTargetAtTime(CHORD_THIRDS[chordIdx] * 0.997, now, 0.22);
      }

      // Layer 2: Frostbite dark rhythmic bass ostinato (intensity > 0.22)
      if (inten > 0.22) {
        const semi = BASS_PATTERN[barStep];
        const rootHz = CHORD_ROOTS[chordIdx] * 0.5; // deep octave bass
        const freq = rootHz * Math.pow(2, semi / 12);
        const level = clamp((inten - 0.22) / 0.65, 0, 1);
        const accent = (barStep % 4 === 0) ? 1.25 : 0.78;

        const bass = ctx.createOscillator();
        bass.type = 'sawtooth';
        bass.frequency.setValueAtTime(freq, now);
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.setValueAtTime(140 + level * 680 * accent, now);
        flt.frequency.exponentialRampToValueAtTime(90, now + 0.11);
        flt.Q.value = 3.2;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.22 * level * accent, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.125);

        bass.connect(flt); flt.connect(g); g.connect(musicGain);
        bass.start(now); bass.stop(now + 0.135);
      }

      // Layer 3: Industrial battlefield percussion (intensity > 0.48)
      if (inten > 0.48) {
        const pLevel = clamp((inten - 0.48) / 0.52, 0, 1);
        // Deep war-drum kick on 0, 6, 8, 14
        if (barStep === 0 || barStep === 6 || barStep === 8 || barStep === 14) {
          const kick = ctx.createOscillator();
          kick.type = 'sine';
          kick.frequency.setValueAtTime(92, now);
          kick.frequency.exponentialRampToValueAtTime(28, now + 0.14);
          const kg = ctx.createGain();
          kg.gain.setValueAtTime(0.38 * pLevel, now);
          kg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          kick.connect(kg); kg.connect(musicGain);
          kick.start(now); kick.stop(now + 0.19);
        }
        // Metallic industrial snare/clang on 4 and 12
        if (barStep === 4 || barStep === 12) {
          const sn = ctx.createBufferSource();
          sn.buffer = crackBuf;
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 1150;
          bp.Q.value = 1.6;
          const sg = ctx.createGain();
          sg.gain.setValueAtTime(0.22 * pLevel, now);
          sg.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
          sn.connect(bp); bp.connect(sg); sg.connect(musicGain);
          sn.start(now); sn.stop(now + 0.14);
        }
        // Tense 16th hi-tick pulse
        if (barStep % 2 === 1) {
          const hh = ctx.createBufferSource();
          hh.buffer = whiteBuf;
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 6500;
          const hg = ctx.createGain();
          hg.gain.setValueAtTime(0.055 * pLevel, now);
          hg.gain.exponentialRampToValueAtTime(0.001, now + 0.032);
          hh.connect(hp); hp.connect(hg); hg.connect(musicGain);
          hh.start(now); hh.stop(now + 0.04);
        }
      }

      // Layer 4: Grim dark horn/brass motif on climax (intensity > 0.72)
      if (inten > 0.72 && (step % 32) < 16) {
        const note = BRASS_MOTIF[barStep];
        if (note > 0) {
          const bLevel = clamp((inten - 0.72) / 0.28, 0, 1);
          const br = ctx.createOscillator();
          br.type = 'sawtooth';
          br.frequency.setValueAtTime(note, now);
          const br2 = ctx.createOscillator();
          br2.type = 'sawtooth';
          br2.frequency.setValueAtTime(note * 0.501, now);

          const flt = ctx.createBiquadFilter();
          flt.type = 'lowpass';
          flt.frequency.setValueAtTime(320, now);
          flt.frequency.linearRampToValueAtTime(1100, now + 0.14);
          flt.frequency.exponentialRampToValueAtTime(380, now + 0.45);

          const bg = ctx.createGain();
          bg.gain.setValueAtTime(0.001, now);
          bg.gain.linearRampToValueAtTime(0.11 * bLevel, now + 0.08);
          bg.gain.exponentialRampToValueAtTime(0.001, now + 0.52);

          br.connect(flt); br2.connect(flt); flt.connect(bg); bg.connect(musicGain);
          br.start(now); br2.start(now);
          br.stop(now + 0.55); br2.stop(now + 0.55);
        }
      }

      music.step++;
    }
  }

  // ============================================================================
  // Continuous Loops Updater (Vehicles, Drones, Robot Dogs, Ambience, Score)
  // ============================================================================
  function updateVehicleLoops(camPos, vehicles, drones, dogs, combatIntensity, dt) {
    const safeDt = clamp(dt || 0.016, 0.001, 0.1);
    if (camPos && camPos.length >= 3) {
      listener.pos[0] = camPos[0];
      listener.pos[1] = camPos[1];
      listener.pos[2] = camPos[2];
    }
    if (window.DF && window.DF.Game && window.DF.Game.camera && typeof window.DF.Game.camera.yaw === 'number') {
      const cy = window.DF.Game.camera.yaw;
      listener.yaw = cy;
      listener.forward[0] = -Math.sin(cy);
      listener.forward[2] = -Math.cos(cy);
      listener.right[0] = Math.cos(cy);
      listener.right[2] = -Math.sin(cy);
    }

    if (!isReady() || !loopsReady) return;
    const now = ctx.currentTime;

    // 1. Nearest alive vehicle (tank/IFV) diesel rumble & track clatter
    let bestVehDist = 999;
    let bestVehSpeed = 0;
    let bestVehHeavy = false;
    if (Array.isArray(vehicles)) {
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || v.destroyed || v.hp <= 0 || !v.pos) continue;
        const dx = v.pos[0] - listener.pos[0];
        const dy = (v.pos[1] || 0) - listener.pos[1];
        const dz = v.pos[2] - listener.pos[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestVehDist) {
          bestVehDist = d;
          const vx = v.vel ? v.vel[0] : 0;
          const vz = v.vel ? v.vel[2] : 0;
          bestVehSpeed = v.speed !== undefined ? Math.abs(v.speed) : Math.sqrt(vx * vx + vz * vz);
          bestVehHeavy = (v.type === 'tank');
        }
      }
    }

    if (bestVehDist < 72) {
      const att = clamp(1 - bestVehDist / 72, 0, 1);
      const rev = clamp(bestVehSpeed / 12, 0, 1);
      const baseHz = bestVehHeavy ? 32 : 42;
      loops.engineOsc1.frequency.setTargetAtTime(baseHz + rev * 26, now, 0.08);
      loops.engineOsc2.frequency.setTargetAtTime((baseHz + rev * 26) * 1.51, now, 0.08);
      loops.engineSub.frequency.setTargetAtTime((baseHz + rev * 18) * 0.5, now, 0.08);
      loops.engineFilter.frequency.setTargetAtTime(115 + rev * 240, now, 0.08);
      loops.engineGain.gain.setTargetAtTime(att * att * (0.14 + rev * 0.14), now, 0.08);

      const trackVol = att * att * clamp(bestVehSpeed / 8, 0, 1) * 0.13;
      loops.trackLfo.frequency.setTargetAtTime(6 + rev * 14, now, 0.08);
      loops.trackLfoGain.gain.setTargetAtTime(trackVol * 0.65, now, 0.08);
      loops.trackGain.gain.setTargetAtTime(trackVol, now, 0.08);
    } else {
      loops.engineGain.gain.setTargetAtTime(0, now, 0.12);
      loops.trackGain.gain.setTargetAtTime(0, now, 0.12);
      loops.trackLfoGain.gain.setTargetAtTime(0, now, 0.12);
    }

    // 2. Nearest alive Quadcopter / FPV Drone harmonic rotor whine
    let bestDroneDist = 999;
    let bestDroneSpeed = 0;
    let bestDronePan = 0;
    if (Array.isArray(drones)) {
      for (let i = 0; i < drones.length; i++) {
        const dr = drones[i];
        if (!dr || dr.destroyed || dr.alive === false || dr.hp <= 0 || !dr.pos) continue;
        const dx = dr.pos[0] - listener.pos[0];
        const dy = (dr.pos[1] || 0) - listener.pos[1];
        const dz = dr.pos[2] - listener.pos[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestDroneDist) {
          bestDroneDist = d;
          const vx = dr.vel ? dr.vel[0] : 0;
          const vy = dr.vel ? dr.vel[1] : 0;
          const vz = dr.vel ? dr.vel[2] : 0;
          bestDroneSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          const invD = d > 0.05 ? 1 / d : 0;
          bestDronePan = clamp((dx * listener.right[0] + dz * listener.right[2]) * invD, -0.9, 0.9);
        }
      }
    }

    if (bestDroneDist < 65) {
      const att = clamp(1 - bestDroneDist / 65, 0, 1);
      const thr = clamp(bestDroneSpeed / 18, 0, 1);
      const f = 185 + thr * 135;
      loops.droneOsc1.frequency.setTargetAtTime(f, now, 0.06);
      loops.droneOsc2.frequency.setTargetAtTime(f * 1.024, now, 0.06);
      loops.droneOsc3.frequency.setTargetAtTime(f * 2.01, now, 0.06);
      loops.droneFilter.frequency.setTargetAtTime(480 + thr * 520, now, 0.06);
      loops.droneGain.gain.setTargetAtTime(att * att * (0.075 + thr * 0.06), now, 0.08);
      if (loops.dronePan && loops.dronePan.pan) {
        loops.dronePan.pan.setTargetAtTime(bestDronePan, now, 0.06);
      }
    } else {
      loops.droneGain.gain.setTargetAtTime(0, now, 0.10);
    }

    // 3. Nearest alive Robot Dog electric servo whirs
    let bestDogDist = 999;
    let bestDogSpeed = 0;
    let bestDogPan = 0;
    if (Array.isArray(dogs)) {
      for (let i = 0; i < dogs.length; i++) {
        const dg = dogs[i];
        if (!dg || dg.destroyed || dg.alive === false || dg.hp <= 0 || !dg.pos) continue;
        const dx = dg.pos[0] - listener.pos[0];
        const dy = (dg.pos[1] || 0) - listener.pos[1];
        const dz = dg.pos[2] - listener.pos[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestDogDist) {
          bestDogDist = d;
          const vx = dg.vel ? dg.vel[0] : 0;
          const vz = dg.vel ? dg.vel[2] : 0;
          bestDogSpeed = Math.sqrt(vx * vx + vz * vz);
          const invD = d > 0.05 ? 1 / d : 0;
          bestDogPan = clamp((dx * listener.right[0] + dz * listener.right[2]) * invD, -0.9, 0.9);
        }
      }
    }

    if (bestDogDist < 28 && bestDogSpeed > 0.35) {
      const att = clamp(1 - bestDogDist / 28, 0, 1);
      const spNorm = clamp(bestDogSpeed / 9, 0, 1);
      loops.dogOsc.frequency.setTargetAtTime(360 + spNorm * 440, now, 0.05);
      loops.dogFilter.frequency.setTargetAtTime(580 + spNorm * 580, now, 0.05);
      loops.dogGain.gain.setTargetAtTime(att * att * spNorm * 0.065, now, 0.07);
      if (loops.dogPan && loops.dogPan.pan) {
        loops.dogPan.pan.setTargetAtTime(bestDogPan, now, 0.06);
      }
    } else {
      loops.dogGain.gain.setTargetAtTime(0, now, 0.08);
    }

    // 4. Cold Donbas urban wind modulation & distant horizon artillery
    loops.windPhase += safeDt * 0.32;
    const gust = 0.5 + 0.5 * Math.sin(loops.windPhase) * Math.cos(loops.windPhase * 0.43);
    loops.windFilter.frequency.setTargetAtTime(240 + gust * 310, now, 0.25);
    loops.windGain.gain.setTargetAtTime(0.055 + gust * 0.055, now, 0.25);

    loops.distantArtyTimer -= safeDt;
    if (loops.distantArtyTimer <= 0) {
      triggerDistantArtillery();
      loops.distantArtyTimer = rand(6.5, 15.0) / (0.8 + (combatIntensity || 0) * 0.6);
    }

    // 5. Adaptive Cinematic Combat Score
    stepMusic(safeDt, combatIntensity !== undefined ? combatIntensity : 0.15);
  }

  // ============================================================================
  // Listener & Gesture Unlock Lifecycle
  // ============================================================================
  function setListener(pos, yaw, pitch) {
    if (pos && pos.length >= 3) {
      listener.pos[0] = pos[0];
      listener.pos[1] = pos[1];
      listener.pos[2] = pos[2];
    }
    if (typeof yaw === 'number' && !isNaN(yaw)) {
      listener.yaw = yaw;
      // Right-handed Y-up: yaw=0 looks along -Z, +right = (+cos(yaw), 0, -sin(yaw)) or standard camera basis
      // Let's handle both standard forward = (-sin(yaw), 0, -cos(yaw)) -> right = (cos(yaw), 0, -sin(yaw))
      listener.forward[0] = -Math.sin(yaw);
      listener.forward[1] = 0;
      listener.forward[2] = -Math.cos(yaw);
      listener.right[0] = Math.cos(yaw);
      listener.right[1] = 0;
      listener.right[2] = -Math.sin(yaw);
    }
    if (typeof pitch === 'number' && !isNaN(pitch)) {
      listener.pitch = pitch;
    }
  }

  function unlock() {
    const c = ensureContext();
    if (!c) return;
    if (c.state === 'suspended') {
      try {
        const p = c.resume();
        if (p && typeof p.then === 'function') {
          p.then(() => { unlocked = true; }).catch(() => {});
        }
      } catch (_) { /* ignore */ }
    } else {
      unlocked = true;
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const onGesture = () => {
      unlock();
      if (unlocked && ctx && ctx.state === 'running') {
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        window.removeEventListener('mousedown', onGesture, true);
      }
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    window.addEventListener('mousedown', onGesture, true);
  }

  function setVolumes(cfg) {
    if (!cfg) return;
    if (typeof cfg.master === 'number') volumes.master = clamp(cfg.master, 0, 1);
    if (typeof cfg.sfx === 'number') volumes.sfx = clamp(cfg.sfx, 0, 1);
    if (typeof cfg.music === 'number') volumes.music = clamp(cfg.music, 0, 1);
    applyVolumes(false);
  }

  function getVolumes() {
    return { master: volumes.master, sfx: volumes.sfx, music: volumes.music, muted };
  }

  function setMuted(m) {
    muted = !!m;
    applyVolumes(false);
  }

  window.DF.Audio = {
    init,
    unlock,
    setListener,
    setVolumes,
    getVolumes,
    setMuted,
    playGunshot,
    playReloadFoley,
    playFootstep,
    playCasingPing,
    playExplosion,
    playImpact,
    playHitmarker,
    playRadioCue,
    playBulletWhiz,
    updateVehicleLoops
  };
})();
