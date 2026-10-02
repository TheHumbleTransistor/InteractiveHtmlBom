/* Sound effect for marking parts placed, synthesised with Web Audio. */

var placedSound = (function () {
  const CAP = 10;            // parts beyond this no longer add notes
  const STEP = 0.075;        // s between notes of a run
  const STREAK_GAP = 0.5;    // s of quiet after a run before ticks stop adding to it
  const SCALE = [0, 2, 4, 7, 9];
  var ctx = null, out = null;
  var streak = 0, streakEnd = 0;

  function impulse(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  function init() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();
      comp.connect(ctx.destination);
      out = ctx.createGain();
      out.gain.value = 0.6;
      out.connect(comp);
      const verb = ctx.createConvolver();
      verb.buffer = impulse(1.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      out.connect(verb);
      verb.connect(wet);
      wet.connect(comp);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  function pitch(step, base) {
    return base * Math.pow(2, Math.floor(step / 5) + SCALE[step % 5] / 12);
  }

  function tone(freq, t, dur, type, gain, glideFrom) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq * (glideFrom || 1), t);
    if (glideFrom) o.frequency.exponentialRampToValueAtTime(freq, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const VARIANTS = {
    chime: {
      base: 523.25,
      note(f, t) {
        tone(f, t, 0.6, "sine", 0.3);
        tone(f * 2, t, 0.3, "sine", 0.08);
        tone(f * 3, t, 0.15, "sine", 0.03);
      },
    },
    bubble: {
      base: 523.25,
      note(f, t) {
        tone(f, t, 0.22, "sine", 0.4, 0.5);
        tone(f * 2, t + 0.02, 0.12, "sine", 0.05, 0.5);
      },
    },
    coin: {
      base: 493.88,
      note(f, t) {
        tone(f, t, 0.08, "square", 0.06);
        tone(f * 4 / 3, t + 0.07, 0.4, "square", 0.06);
      },
    },
  };

  function chord(v, top, t, dur) {
    for (const s of [top, top + 2, top + 4]) {
      const f = pitch(s, v.base);
      tone(f, t, dur, "triangle", 0.12);
      tone(f * 2, t, dur * 0.6, "sine", 0.04);
    }
  }

  var api = {
    variant: "chime",

    /* Play for n parts just placed. Ticks during or just after a run extend it. */
    play(n) {
      init();
      const v = VARIANTS[api.variant];
      const now = ctx.currentTime;
      if (now > streakEnd + STREAK_GAP) streak = 0;
      let t = Math.max(now, streakEnd);
      const from = Math.min(streak, CAP), to = Math.min(streak + n, CAP);
      streak += n;
      if (to > from) {
        for (let i = from; i < to; i++, t += STEP) v.note(pitch(i, v.base), t);
      } else {
        v.note(pitch(CAP - 1, v.base), t);
        t += STEP;
      }
      if (streak > 1) chord(v, to - 1, t, 0.8);
      streakEnd = t;
    },

    /* Play the fanfare for the last part placed, after any run in progress. */
    finish() {
      init();
      const v = VARIANTS[api.variant];
      let t = Math.max(ctx.currentTime, streakEnd) + 0.25;
      for (const s of [0, 2, 3, 5]) {
        v.note(pitch(s, v.base), t);
        t += 0.11;
      }
      chord(v, 5, t, 2.2);
      for (let i = 0; i < 10; i++) {
        tone(pitch(10 + Math.floor(Math.random() * 5), v.base), t + 0.1 + Math.random() * 1.2,
             0.4, "sine", 0.05);
      }
      streak = 0;
      streakEnd = t + 1.5;
    },
  };
  return api;
})();
