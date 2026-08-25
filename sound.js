/* ============================================================
   キャッフィーの琵琶湖サバイバル ― 効果音
   ------------------------------------------------------------
   音声ファイルは使わず、Web Audio API でその場で音を合成します。
   （ダウンロードが不要なので、どの環境でもすぐ鳴ります）

   ブラウザの制限で、AudioContext は「ユーザーが何かを操作した後」
   でないと音を出せません。そのため unlock() を最初のクリックや
   キー操作のときに呼びます。
   ============================================================ */

window.Sound = (function () {
  'use strict';

  var ctx = null;
  var master = null;
  var ambientGain = null;
  var ambientSource = null;
  var enabled = true;
  var ready = false;

  var STORAGE_KEY = 'biwako_survival_sound_v1';

  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) enabled = saved === 'on';
  } catch (e) { /* localStorage が使えなくても音は鳴らせる */ }

  /* ----------------------------------------------------------
     初期化（最初のユーザー操作のときに呼ぶ）
     ---------------------------------------------------------- */
  function unlock() {
    if (ready) {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.9 : 0;
      master.connect(ctx.destination);
      buildAmbient();
      ready = true;
    } catch (e) {
      ctx = null;
    }
  }

  /* ----------------------------------------------------------
     環境音（湖のさざ波）
       ホワイトノイズをローパスに通して水の音に近づけ、
       ゆっくり揺らして単調にならないようにしています。
     ---------------------------------------------------------- */
  function buildAmbient() {
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    ambientSource = ctx.createBufferSource();
    ambientSource.buffer = buf;
    ambientSource.loop = true;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 620;
    lp.Q.value = 0.6;

    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0;

    // ゆっくりした揺らぎ（波が寄せては返す感じ）
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();

    ambientSource.connect(hp);
    hp.connect(lp);
    lp.connect(ambientGain);
    ambientGain.connect(master);
    ambientSource.start();
  }

  function setAmbient(level, seconds) {
    if (!ready || !ambientGain) return;
    var t = ctx.currentTime;
    ambientGain.gain.cancelScheduledValues(t);
    ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
    ambientGain.gain.linearRampToValueAtTime(level, t + (seconds || 0.8));
  }

  /* ----------------------------------------------------------
     音を作る道具
     ---------------------------------------------------------- */
  function tone(opts) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.toFreq), t0 + opts.dur);

    var peak = opts.gain === undefined ? 0.25 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.03, opts.dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  function noiseBurst(opts) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.3;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filt = ctx.createBiquadFilter();
    filt.type = opts.filterType || 'lowpass';
    filt.frequency.setValueAtTime(opts.freq || 900, t0);
    if (opts.toFreq) filt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.toFreq), t0 + dur);

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain === undefined ? 0.3 : opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt);
    filt.connect(gain);
    gain.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ----------------------------------------------------------
     ゲームで使う音
     ---------------------------------------------------------- */
  var api = {
    unlock: unlock,

    isEnabled: function () { return enabled; },

    setEnabled: function (v) {
      enabled = !!v;
      try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch (e) {}
      if (ready && master) {
        var t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(enabled ? 0.9 : 0, t + 0.15);
      }
      return enabled;
    },

    /* ボタンのクリック */
    click: function () {
      tone({ type: 'triangle', freq: 620, toFreq: 880, dur: 0.09, gain: 0.14 });
    },

    /* キャリブレーション完了 */
    ready: function () {
      tone({ type: 'sine', freq: 660, dur: 0.16, gain: 0.2 });
      tone({ type: 'sine', freq: 990, dur: 0.22, gain: 0.16, delay: 0.12 });
    },

    /* カウントダウンの「3・2・1」 */
    beep: function () {
      tone({ type: 'square', freq: 520, dur: 0.14, gain: 0.13 });
    },

    /* 「GO!」 */
    go: function () {
      tone({ type: 'square', freq: 780, dur: 0.10, gain: 0.16 });
      tone({ type: 'square', freq: 1170, dur: 0.28, gain: 0.16, delay: 0.09 });
      setAmbient(0.16, 1.2);
    },

    /* 障害物をよけた */
    dodge: function () {
      tone({ type: 'sine', freq: 1250, toFreq: 1750, dur: 0.10, gain: 0.075 });
      noiseBurst({ dur: 0.16, freq: 2400, toFreq: 700, gain: 0.05, filterType: 'bandpass' });
    },

    /* 被弾（水しぶき＋低い衝撃音） */
    hit: function () {
      noiseBurst({ dur: 0.42, freq: 1600, toFreq: 160, gain: 0.36 });
      tone({ type: 'sawtooth', freq: 190, toFreq: 60, dur: 0.34, gain: 0.24 });
    },

    /* 時間切れで生き残った */
    clear: function () {
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', freq: notes[i], dur: 0.34, gain: 0.18, delay: i * 0.13 });
      }
      setAmbient(0.05, 1.5);
    },

    /* ライフ切れ */
    gameover: function () {
      var notes = [523, 415, 330, 247];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', freq: notes[i], dur: 0.4, gain: 0.18, delay: i * 0.15 });
      }
      setAmbient(0.05, 1.5);
    },

    /* 自己最高記録の更新 */
    record: function () {
      var notes = [784, 988, 1319];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'sine', freq: notes[i], dur: 0.5, gain: 0.16, delay: 0.5 + i * 0.11 });
      }
    },

    /* 環境音の大きさ（0で無音） */
    ambient: setAmbient,
  };

  return api;
})();
