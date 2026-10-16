/* ==========================================================
 * 音效库：全部用 Web Audio 现场合成，无外部音频文件
 * game.js 与 sound-test.html（试听页）共用这一份实现，保证「听到的就是游戏里的」
 * 用法：SoundLib.play('chime', 0.10)
 * ========================================================== */

(function (global) {
  'use strict';

  var ctx = null;

  // 懒加载 AudioContext；必须在用户手势里触发，否则浏览器会拦截
  function ensureAudio() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // C 大调五声音阶：随便挑两个音都和谐，怎么随机都好听
  var SCALE = [523.25, 587.33, 659.25, 783.99, 880.00];   // C5 D5 E5 G5 A5

  // 带轻微滑音 + 低通柔化的单音：给「水滴感」的起音 + 可换波形控制颗粒感
  function sweepTone(c, f0, f1, at, dur, vol, type, cutoff) {
    var osc = c.createOscillator();
    var gain = c.createGain();
    var filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff || 2000;
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f1, at + Math.min(0.08, dur * 0.35));
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(vol, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  // 通用单音：频率 + 起音时间 + 时长 + 音量 + 波形（attack 可单独调，越大越柔）
  function tone(c, freq, at, dur, vol, type, attack) {
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(vol, at + (attack || 0.015));  // 圆滑起音
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);        // 自然收尾
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /* 柔化版滑音：与 sweepTone 的区别是——
   *   1. 起音更慢（0.045s），去掉「敲击/咔哒」的尖锐起始
   *   2. 滑音过程拉长到半程，音高变化更平缓，不刺耳
   *   3. 低通截止更低，把高频毛刺滤掉
   * 用来做「柔和系」音效的主体 */
  function softSweep(c, f0, f1, at, dur, vol, cutoff) {
    var osc = c.createOscillator();
    var gain = c.createGain();
    var filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff || 1200;
    filter.Q.value = 0.5;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f1, at + dur * 0.55);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(vol, at + 0.045);          // 慢起音
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);    // 自然收尾
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /* ---------------- 6 种候选音效 ---------------- */
  var SOUNDS = {

    // 1. 风铃叮咚：五声音阶随机两音上行 + 八度泛音
    chime: function (c, t, vol) {
      var i = Math.floor(Math.random() * (SCALE.length - 1));
      tone(c, SCALE[i], t, 0.30, vol, 'sine');
      tone(c, SCALE[i] * 2, t, 0.15, vol * 0.20, 'sine');
      tone(c, SCALE[i + 1], t + 0.10, 0.40, vol, 'sine');
      tone(c, SCALE[i + 1] * 2, t + 0.10, 0.20, vol * 0.20, 'sine');
    },

    // 2. 水滴：音高快速上扬的短音，像水滴落进水面
    water: function (c, t, vol) {
      var osc = c.createOscillator();
      var gain = c.createGain();
      var filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1800;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520 + Math.random() * 80, t);
      osc.frequency.exponentialRampToValueAtTime(1150, t + 0.07);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    },

    // 3. 木琴：三角波 + 五度叠音，短促有颗粒感
    marimba: function (c, t, vol) {
      var i = Math.floor(Math.random() * SCALE.length);
      var root = SCALE[i];
      tone(c, root, t, 0.22, vol * 0.9, 'triangle');
      tone(c, root * 1.5, t + 0.08, 0.26, vol * 0.7, 'triangle');
    },

    // 4. 气泡：音高下滑 + 低通，闷闷的「啵」
    bubble: function (c, t, vol) {
      var osc = c.createOscillator();
      var gain = c.createGain();
      var filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      osc.type = 'sine';
      var start = 520 + Math.random() * 120;
      osc.frequency.setValueAtTime(start, t);
      osc.frequency.exponentialRampToValueAtTime(start * 0.62, t + 0.18);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    },

    // 5. 八音盒：单音 + 多重泛音，尾音较长
    musicbox: function (c, t, vol) {
      var f = SCALE[Math.floor(Math.random() * SCALE.length)];
      tone(c, f, t, 0.90, vol, 'sine');
      tone(c, f * 2, t, 0.45, vol * 0.25, 'sine');
      tone(c, f * 3, t, 0.30, vol * 0.10, 'sine');
    },

    // 6. 玻璃杯叮：高音短促清脆，像轻敲玻璃杯沿
    glass: function (c, t, vol) {
      var f = 1180 + Math.random() * 160;
      tone(c, f, t, 0.45, vol * 0.85, 'sine');
      tone(c, f * 1.51, t, 0.30, vol * 0.30, 'sine');
    },

    /* ---- 7、8：介于「水滴」与「木琴」之间的混合音 ---- */

    /* 7. 露珠：柔化版水滴 —— 主体是慢起音的正弦滑音，低通压到 1200Hz，
     *    叠音也全部用正弦且放轻，基频下移到 470Hz 左右，整体更闷更柔 */
    dewdrop: function (c, t, vol) {
      var base = 470 + Math.random() * 55;
      softSweep(c, base, base * 1.26, t, 0.34, vol, 1200);                  // 主体：平缓上扬
      tone(c, base * 1.5, t + 0.07, 0.30, vol * 0.16, 'sine', 0.05);        // 五度：很轻的一层
      tone(c, base * 2, t + 0.02, 0.18, vol * 0.05, 'sine', 0.05);          // 八度：只留一丝空气感
    },

    // 8. 水滴木琴：偏木琴 —— 三角波主体（低通柔化掉刺耳感）+ 轻微上扬 + 五度叠音
    aqueous: function (c, t, vol) {
      var i = Math.floor(Math.random() * SCALE.length);
      var base = SCALE[i] * 1.05;
      sweepTone(c, base, base * 1.32, t, 0.26, vol * 0.9, 'triangle', 2200);  // 木质主体
      tone(c, base * 1.5, t + 0.07, 0.28, vol * 0.45, 'sine');                // 柔和五度尾音
      tone(c, base * 2, t, 0.12, vol * 0.12, 'sine');
    },

    /* ---- 错误提示音：配对失败时的「噔~」 ----
     * 不放在上面的可切换列表里，因为它是固定提示音，不随消除音一起换。
     * 设计要点（常见错误提示音的共性）：
     *   1. 音高下行（约 330Hz → 233Hz，下行小三度），天然带「否定、落空」的语气
     *   2. 三角波而非正弦——比正弦更「硬」有警示感，再靠低通滤掉毛刺
     *   3. 时长偏短（0.26s），不拖沓；底下垫一层八度低音让声音更实，不像电子蜂鸣
     */
    wrong: function (c, t, vol) {
      sweepTone(c, 330, 233, t, 0.26, vol, 'triangle', 1100);        // 主体：下行滑音
      tone(c, 165, t + 0.03, 0.22, vol * 0.45, 'sine', 0.02);        // 低八度：加厚，避免单薄
    }
  };

  global.SoundLib = {
    // 选项列表（试听页与文档共用）
    list: [
      { key: 'chime',    name: '风铃叮咚', desc: '随机两音上行 + 泛音，有旋律感，不腻' },
      { key: 'water',    name: '水滴',     desc: '音高快速上扬的短音，干净利落' },
      { key: 'marimba',  name: '木琴',     desc: '三角波颗粒感，带五度叠音，偏活泼' },
      { key: 'bubble',   name: '气泡',     desc: '音高下滑 + 低通，闷闷的「啵」' },
      { key: 'musicbox', name: '八音盒',   desc: '多重泛音，尾音较长，温柔' },
      { key: 'glass',    name: '玻璃杯叮', desc: '高音清脆，像轻敲杯沿' },
      { key: 'dewdrop',  name: '露珠（2+3 混合·偏水滴·已柔化）', desc: '慢起音正弦滑音 + 1200Hz 低通，闷而柔和，不刺耳（当前默认）' },
      { key: 'aqueous',  name: '水滴木琴（2+3 混合·偏木琴）', desc: '木琴的圆润主体 + 水滴的轻微上扬，去掉刺耳感' }
    ],
    unlock: ensureAudio,
    play: function (key, vol) {
      var c = ensureAudio();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      var fn = SOUNDS[key] || SOUNDS.chime;
      fn(c, c.currentTime, vol == null ? 0.1 : vol);
    },
    // 错误提示音入口：与消除音分开，音量跟随游戏统一设置
    playWrong: function (vol) {
      var c = ensureAudio();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      SOUNDS.wrong(c, c.currentTime, vol == null ? 0.1 : vol);
    }
  };
})(window);
