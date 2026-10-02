/* Sound effect for marking parts placed, synthesised with Web Audio. */

var placedSound = (function () {
  const CAP = 10;            // parts beyond this no longer add hits
  const STREAK_GAP = 0.5;    // s of quiet after a run before ticks stop adding to it
  const SCALE = [0, 2, 4, 7, 9];
  var ctx = null, out = null, noiseBuf = null;
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
      out = ctx.createGain();
      out.gain.value = 0.6;
      out.connect(ctx.destination);
      const verb = ctx.createConvolver();
      verb.buffer = impulse(1.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      out.connect(verb);
      verb.connect(wet);
      wet.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  function pitch(step, base) {
    return base * Math.pow(2, Math.floor(step / 5) + SCALE[step % 5] / 12);
  }

  function envelope(t, attack, dur, gain) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    return g;
  }

  /* An oscillator at freq, or sweeping from `from` to freq over `sweep` s. */
  function tone(freq, t, dur, type, gain, from, sweep) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from || freq, t);
    if (from) o.frequency.exponentialRampToValueAtTime(freq, t + (sweep || 0.07));
    o.connect(envelope(t, 0.006, dur, gain));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /* Filtered noise; freq may be [start, end] to sweep the filter over the duration. */
  function noise(t, dur, filter, freq, q, gain, attack) {
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter();
    src.buffer = noiseBuf;
    src.loop = true;
    f.type = filter;
    f.Q.value = q;
    const [f0, f1] = Array.isArray(freq) ? freq : [freq, freq];
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    src.connect(f);
    f.connect(envelope(t, attack || 0.003, dur, gain));
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  function chord(base, top, t, dur) {
    for (const s of [top, top + 2, top + 4]) {
      const f = pitch(s, base);
      tone(f, t, dur, "triangle", 0.12);
      tone(f * 2, t, dur * 0.6, "sine", 0.04);
    }
  }

  function pebbles(t, count) {
    for (let i = 0; i < count; i++) {
      noise(t + 0.05 + Math.random() * 0.35, 0.03, "bandpass", 2500 + Math.random() * 3000, 4, 0.06);
    }
  }

  function thud(t, r, base, gain, dur) {
    tone(base * 0.35 * r, t, dur, "sine", gain, base * r, 0.12);
    noise(t, dur * 0.35, "lowpass", 900 * r, 0.7, gain * 0.4);
  }

  /* heavy: the finale opens with a boom. step: s between hits. hit(i, t): the i-th part of a run. end(top, t): after a run of several. */
  const VARIANTS = {
    chime: {
      step: 0.075,
      hit(i, t) {
        const f = pitch(i, 523.25);
        tone(f, t, 0.6, "sine", 0.3);
        tone(f * 2, t, 0.3, "sine", 0.08);
        tone(f * 3, t, 0.15, "sine", 0.03);
      },
      end(top, t) { chord(523.25, top, t, 0.8); },
    },
    bubble: {
      step: 0.075,
      hit(i, t) {
        const f = pitch(i, 523.25);
        tone(f, t, 0.22, "sine", 0.4, f * 0.5);
        tone(f * 2, t + 0.02, 0.12, "sine", 0.05, f);
      },
      end(top, t) { chord(523.25, top, t, 0.8); },
    },
    coin: {
      step: 0.075,
      hit(i, t) {
        const f = pitch(i, 493.88);
        tone(f, t, 0.08, "square", 0.1);
        tone(f * 4 / 3, t + 0.07, 0.4, "square", 0.1);
      },
      end(top, t) { chord(493.88, top, t, 0.8); },
    },
    brick: {
      heavy: true,
      step: 0.16,
      hit(i, t) {
        const r = Math.pow(2, i / 12);
        thud(t, r, 140, 0.9, 0.35);
        noise(t, 0.06, "bandpass", 3000, 1, 0.08);
      },
      end(top, t) { pebbles(t, 6); },
    },
    slide: {
      heavy: true,
      step: 0.28,
      hit(i, t) {
        const r = Math.pow(2, i / 12);
        noise(t, 0.2, "bandpass", [900 * r, 450 * r], 3, 0.18, 0.12);
        thud(t + 0.2, r, 120, 1.0, 0.4);
      },
      end(top, t) { pebbles(t + 0.2, 6); },
    },
    clay: {
      heavy: true,
      step: 0.12,
      hit(i, t) {
        const r = Math.pow(2, i / 12);
        tone(150 * r, t, 0.18, "sine", 0.6, 230 * r, 0.06);
        tone(440 * r, t, 0.06, "triangle", 0.12);
        noise(t, 0.015, "highpass", 2000, 0.7, 0.15);
      },
      end(top, t) { pebbles(t, 3); },
    },
    monolith: {
      heavy: true,
      step: 0.3,
      hit(i, t) {
        const r = Math.pow(2, i / 12);
        thud(t, r, 90, 1.0, 0.9);
        noise(t, 0.5, "lowpass", 300 * r, 0.7, 0.3, 0.01);
      },
      end(top, t) { pebbles(t, 10); },
    },
  };

  var api = {
    variant: "brick",
    variants: Object.keys(VARIANTS),

    /* Play for n parts just placed. Ticks during or just after a run extend it. */
    play(n) {
      init();
      const v = VARIANTS[api.variant];
      const now = ctx.currentTime;
      if (now > streakEnd + STREAK_GAP) streak = 0;
      let t = Math.max(now + 0.02, streakEnd);
      const from = Math.min(streak, CAP), to = Math.min(streak + n, CAP);
      streak += n;
      if (to > from) {
        for (let i = from; i < to; i++, t += v.step) v.hit(i, t);
      } else {
        v.hit(CAP - 1, t);
        t += v.step;
      }
      if (streak > 1) v.end(to - 1, t);
      streakEnd = t;
    },

    /* Play the fanfare for the last part placed, after any run in progress. */
    finish() {
      init();
      const v = VARIANTS[api.variant];
      let t = Math.max(ctx.currentTime, streakEnd) + 0.25;
      if (v.heavy) {
        thud(t, 1, 70, 1.0, 1.4);
        pebbles(t + 0.1, 12);
        t += 0.5;
      }
      for (const s of [0, 2, 3, 5]) {
        const f = pitch(s, 523.25);
        tone(f, t, 0.6, "sine", 0.3);
        tone(f * 2, t, 0.3, "sine", 0.08);
        t += 0.11;
      }
      chord(523.25, 5, t, 2.2);
      for (let i = 0; i < 10; i++) {
        tone(pitch(10 + Math.floor(Math.random() * 5), 523.25), t + 0.1 + Math.random() * 1.2,
             0.4, "sine", 0.05);
      }
      streak = 0;
      streakEnd = t + 1.5;
    },
  };
  return api;
})();
