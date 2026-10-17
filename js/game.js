/* ==========================================================
 * 四级单词连线闯关 · 游戏逻辑
 * 设计思路：
 *   1. 单一数据源：所有运行状态集中在 state 对象里，界面只负责渲染
 *   2. 函数分层：数据层（取词 / 洗牌）→ 状态层（选中 / 配对）→ 渲染层（DOM / SVG）
 *   3. 事件委托：整块棋盘只绑一个 click，性能更好也更易维护
 *   4. localStorage 持久化：统计每个难度练过的词，保证「不出错尽量不重复」，
 *      全部词都出现过后才重新开始轮转
 * ========================================================== */

(function () {
  'use strict';

  var ROUND_COUNT = 3;    // 每大关的回合数
  var ROUND_SIZE  = 6;    // 每回合的单词组数
  var MATCH_DELAY = 320;  // 连线出现 → 卡片消失（毫秒）
  var WRONG_DELAY = 420;  // 配对失败的高亮提示时长（毫秒）
  var NEXT_DELAY  = 900;  // 回合完成后自动进入下一回合的间隔（毫秒）
  var SVG_NS      = 'http://www.w3.org/2000/svg';
  // localStorage 键名：词库重新分档后 id 会变，所以升级到 v2，
  // 启动时顺手清掉 v1 的旧统计，避免旧 id 错位导致复习列表串词
  var STORE_KEY   = 'cet4link_records_v2';
  var OLD_KEYS    = ['cet4link_records_v1'];

  /* ---------------- 词库归一化 ----------------
   * data.js 里每档是 ["英文", "释义"] 紧凑数组，这里统一转成
   * { id, en, zh } 对象；id 用「档内下标」，跨会话保持稳定，
   * 这样 localStorage 里的统计才可靠。 */
  var BANK = {};
  (function () {
    for (var key in WORD_BANK) {
      BANK[key] = WORD_BANK[key].map(function (item, i) {
        return { id: i, en: item[0], zh: item[1] };
      });
    }
  })();

  /* ---------------- DOM 引用 ---------------- */
  var $ = function (id) { return document.getElementById(id); };

  var dom = {
    home: $('home'),
    game: $('game'),
    select: $('difficultySelect'),
    startBtn: $('startBtn'),
    quitBtn: $('quitBtn'),

    board: $('board'),
    colEn: $('colEn'),
    colZh: $('colZh'),
    lines: $('lines'),
    hint: $('hint'),

    statDiff: $('statDiff'),
    statRound: $('statRound'),
    statRoundTime: $('statRoundTime'),
    statTotalTime: $('statTotalTime'),

    // 通关复习弹窗
    finalModal: $('finalModal'),
    fmSub: $('fmSub'),
    reviewList: $('reviewList'),
    playAgainBtn: $('playAgainBtn'),
    backHomeBtn: $('backHomeBtn'),

    // 首页复习区块
    openReviewBtn: $('openReviewBtn'),
    homeReviewModal: $('homeReviewModal'),
    rvSub: $('rvSub'),
    rvList: $('rvList'),
    rvTime: $('rvTime'),
    closeReviewBtn: $('closeReviewBtn'),
    clearRecordBtn: $('clearRecordBtn'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    importFile: $('importFile')
  };

  /* ---------------- 全局状态（唯一数据源） ---------------- */
  var state = {
    difficultyKey: 'cet4',   // 当前难度
    difficultyName: '中等',
    roundIndex: 0,           // 当前回合下标，0 表示第 1 回合
    pairs: [],               // 当前回合的 6 组单词 [{ id, en, zh }]
    reviewWords: [],         // 本关出现过的全部单词（供通关后复习）
    wrongIds: {},            // 本局配对时选错过的单词 id 集合
    pool: [],                // 本局词池：从未练过的词洗牌后的结果
    store: null,             // 当前难度的持久化统计 { seen:[], wrong:{} }
    matched: 0,              // 本回合已配对成功的组数
    selected: null,          // 当前选中卡片 { side:'en'|'zh', id, node }
    locked: false,           // 配对动画期间锁定操作，避免连点错乱
    roundClicks: 0,          // 本回合点击次数
    roundStartAt: 0,         // 本回合计时起点（时间戳，0 表示未在计时）
    roundMs: 0,              // 本回合已耗时（毫秒）
    doneMs: 0,               // 已完成回合的累计耗时（毫秒）
    timerId: null,           // 计时器 id
    nextTimerId: null        // 自动进入下一回合的延时器 id
  };

  /* ==========================================================
   * 持久化统计模块（localStorage）
   * 结构：{ seen: [按出现顺序排列的单词 id], wrong: { id: 1 } }
   * seen 用于「不重复抽词」和首页复习列表，wrong 用于标亮错过的词
   * ========================================================== */

  // 首次启动时清一次旧版本的统计（词库分档变了，旧 id 已失效）
  (function cleanLegacy() {
    try {
      OLD_KEYS.forEach(function (old) {
        ['basic', 'cet4', 'advanced'].forEach(function (k) {
          localStorage.removeItem(old + '_' + k);
        });
      });
    } catch (e) { /* 忽略 */ }
  })();

  function loadStore(key) {
    try {
      var raw = localStorage.getItem(STORE_KEY + '_' + key);
      var data = raw ? JSON.parse(raw) : null;
      if (data && data.seen && data.wrong) return data;
    } catch (e) { /* 隐私模式等场景下静默降级为不持久化 */ }
    return { seen: [], wrong: {} };
  }

  function saveStore() {
    try {
      state.store.updatedAt = Date.now();   // 记录保存时间，方便确认数据有没有丢
      localStorage.setItem(STORE_KEY + '_' + state.difficultyKey,
                           JSON.stringify(state.store));
    } catch (e) { /* 存不进去也不影响游戏 */ }
  }

  /* ---------------- 记录备份：导出 / 导入 ----------------
   * localStorage 是按「协议 + 域名 + 端口」隔离的，换一个地址打开
   * （比如预览端口变了、换浏览器、换设备）就读不到原来的记录。
   * 所以这里提供手动导出 / 导入 JSON，保证复习记录能一直带着走。 */
  var DIFF_KEYS = ['basic', 'cet4', 'advanced'];

  function exportRecords() {
    var data = { app: 'cet4link', schema: 2, exportedAt: Date.now(), records: {} };
    DIFF_KEYS.forEach(function (k) { data.records[k] = loadStore(k); });

    try {
      var text = JSON.stringify(data, null, 2);
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'cet4link-records-' + fmtDate(Date.now()) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.alert('已导出备份文件，换设备或换地址打开时用它导入即可。');
    } catch (e) {
      window.alert('导出失败：当前环境不支持文件下载。');
    }
  }

  function importRecords(text) {
    var data, records;
    try {
      data = JSON.parse(text);
      records = data.records || data;
    } catch (e) {
      window.alert('导入失败：不是有效的备份文件。');
      return;
    }
    var count = 0;
    DIFF_KEYS.forEach(function (k) {
      var r = records[k];
      if (r && r.seen && r.wrong) {
        try { localStorage.setItem(STORE_KEY + '_' + k, JSON.stringify(r)); } catch (e) {}
        count += r.seen.length;
      }
    });
    window.alert(count ? '导入完成：共恢复 ' + count + ' 个单词的练习记录。'
                       : '导入完成，但文件里没有可识别的记录。');
    openHomeReview();
    updateReviewEntry();
  }

  // 时间戳 → 2026-10-16 23:20
  function fmtDate(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 单词出现过 → 记进 seen（保持练习顺序），并落盘
  function markSeen(pair) {
    if (state.store.seen.indexOf(pair.id) === -1) {
      state.store.seen.push(pair.id);
    }
  }

  // 配对出错 → 记进 wrong，并落盘
  function markWrong(id) {
    state.wrongIds[id] = true;
    state.store.wrong[id] = 1;
  }

  /* ==========================================================
   * 音效：统一走 js/sounds.js 的音效库（可切换 8 种，见 sound-test.html 试听页）
   * 改这里两个常量即可换音色 / 调音量
   * ========================================================== */

  // 音色：dewdrop 露珠 / aqueous 水滴木琴 / chime 风铃 / water 水滴 /
  //       marimba 木琴 / bubble 气泡 / musicbox 八音盒 / glass 玻璃杯叮
  var SOUND_KEY     = 'dewdrop'; // 当前默认：露珠（已柔化的水滴混合音）
  var SOUND_VOLUME  = 0.10;      // 音量：0 ~ 1，默认偏小
  var WRONG_VOLUME  = 0.20;      // 错误提示音音量：要比消除音明显一些才听得清

  function playMatchSound() {
    SoundLib.play(SOUND_KEY, SOUND_VOLUME);
  }

  // 配对失败：播「噔~」下行提示音（固定音色，不随消除音切换）
  function playWrongSound() {
    SoundLib.playWrong(WRONG_VOLUME);
  }

  /* ==========================================================
   * 工具函数
   * ========================================================== */

  // 毫秒 → mm:ss
  function formatTime(ms) {
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Fisher-Yates 洗牌：返回新数组，不修改原数组
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 组装本局词池：只从「没练过的词」里洗牌
  // 当没练过的词不足一局所需（18 组）时，说明整档词库都出现过了，
  // 此时清空 seen 重新开始轮转 —— 这就是「尽量不重复」的策略
  function buildPool() {
    var bank = BANK[state.difficultyKey];
    var seenSet = {};
    state.store.seen.forEach(function (id) { seenSet[id] = 1; });

    var unseen = bank.filter(function (w) { return !seenSet[w.id]; });
    if (unseen.length < ROUND_COUNT * ROUND_SIZE) {
      state.store.seen = [];   // 全库轮转完一轮，重置出现记录
      unseen = bank;
    }
    return shuffle(unseen);
  }

  // 从词池头部取出本回合的 6 组单词
  function takeRoundWords() {
    var words = state.pool.splice(0, ROUND_SIZE);
    // 兜底：词池不够时重新补一池，避免取到空数组
    if (words.length < ROUND_SIZE) {
      state.pool = buildPool();
      words = state.pool.splice(0, ROUND_SIZE);
    }
    return words;
  }

  /* ==========================================================
   * 计时模块
   * ========================================================== */

  function startTimer() {
    stopTimer();
    state.roundStartAt = Date.now();
    state.timerId = setInterval(updateStatus, 200);
  }

  function stopTimer() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (state.roundStartAt) {
      state.roundMs = Date.now() - state.roundStartAt;
      state.roundStartAt = 0;
    }
    updateStatus();
  }

  // 当前回合实时耗时
  function currentRoundMs() {
    return state.roundStartAt ? (Date.now() - state.roundStartAt) : state.roundMs;
  }

  // 整关累计耗时 = 已完成回合 + 当前回合
  function totalMs() {
    return state.doneMs + currentRoundMs();
  }

  /* ==========================================================
   * 渲染模块
   * ========================================================== */

  // 刷新顶部状态栏
  function updateStatus() {
    dom.statDiff.textContent = state.difficultyName;
    dom.statRound.textContent = (state.roundIndex + 1) + ' / ' + ROUND_COUNT;
    dom.statRoundTime.textContent = formatTime(currentRoundMs());
    dom.statTotalTime.textContent = formatTime(totalMs());
  }

  function setHint(text) {
    dom.hint.textContent = text;
  }

  // 渲染一回合的左右两栏卡片（英文、中文各自独立洗牌）
  function renderRound() {
    dom.colEn.innerHTML = '';
    dom.colZh.innerHTML = '';
    dom.lines.innerHTML = '';

    var enOrder = shuffle(state.pairs);   // 左栏顺序
    var zhOrder = shuffle(state.pairs);   // 右栏顺序

    enOrder.forEach(function (p) {
      dom.colEn.appendChild(createCard('en', p));
    });
    zhOrder.forEach(function (p) {
      dom.colZh.appendChild(createCard('zh', p));
    });

    setHint('请点击左侧英文单词卡片，共 ' + ROUND_SIZE + ' 组');
  }

  // 创建一张卡片（用 button 保证可点击、可键盘聚焦）
  function createCard(side, pair) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    btn.dataset.side = side;
    btn.dataset.id = String(pair.id);
    btn.textContent = side === 'en' ? pair.en : pair.zh;
    return btn;
  }

  // 渲染「左英右中、错过的标亮」的复习列表（通关弹窗和首页复习共用）
  // words: [{ id, en, zh }]；wrongIds: 错过的 id 集合
  function renderReviewRows(listEl, words, wrongIds) {
    listEl.innerHTML = '';
    var frag = document.createDocumentFragment();
    words.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'review-item' + (wrongIds[p.id] ? ' missed' : '');
      row.innerHTML =
        '<span class="review-en">' + p.en +
        (wrongIds[p.id] ? '<i class="miss-tag">错过</i>' : '') +
        '</span>' +
        '<span class="review-zh">' + p.zh + '</span>';
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
  }

  // 在两张卡片之间绘制一条浅色直线（SVG 覆盖在棋盘上层）
  function drawLine(nodeA, nodeB) {
    var boardRect = dom.board.getBoundingClientRect();
    var ra = nodeA.getBoundingClientRect();
    var rb = nodeB.getBoundingClientRect();

    // 起点取左卡片右边缘中点，终点取右卡片左边缘中点，避免线压住文字
    var x1 = ra.right - boardRect.left;
    var y1 = ra.top + ra.height / 2 - boardRect.top;
    var x2 = rb.left - boardRect.left;
    var y2 = rb.top + rb.height / 2 - boardRect.top;

    var line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('class', 'link-line');
    dom.lines.appendChild(line);

    // 强制回流后再加 class，保证淡入过渡生效
    void line.getBoundingClientRect();
    line.setAttribute('class', 'link-line show');
    return line;
  }

  function removeLine(line) {
    if (!line || !line.parentNode) return;
    line.setAttribute('class', 'link-line');
    setTimeout(function () {
      if (line.parentNode) line.parentNode.removeChild(line);
    }, 260);
  }

  /* ==========================================================
   * 交互与状态流转
   * ========================================================== */

  // 棋盘事件委托：统一处理左右两栏的点击
  function onBoardClick(e) {
    var node = e.target.closest ? e.target.closest('.card') : null;
    if (!node || node.classList.contains('matched') || state.locked) return;

    var side = node.dataset.side;
    var id = Number(node.dataset.id);

    // 点击已选中的卡片 → 取消选中
    if (state.selected && state.selected.node === node) {
      clearSelection();
      setHint('已取消选中，请重新选择');
      state.roundClicks++;
      updateStatus();
      return;
    }

    // 未选中 → 记为本次选择
    if (!state.selected) {
      state.selected = { side: side, id: id, node: node };
      node.classList.add('selected');
      state.roundClicks++;
      updateStatus();
      setHint(side === 'en'
        ? '已选中 ' + node.textContent + '，请点击右侧中文释义'
        : '已选中 ' + node.textContent + '，请点击左侧英文单词');
      return;
    }

    // 已选中一张：再点同一栏 → 改选；点另一栏 → 判定是否匹配
    if (state.selected.side === side) {
      clearSelection();
      state.selected = { side: side, id: id, node: node };
      node.classList.add('selected');
      state.roundClicks++;
      updateStatus();
      return;
    }

    state.roundClicks++;
    updateStatus();
    judge(state.selected, { side: side, id: id, node: node });
  }

  function clearSelection() {
    if (state.selected) {
      state.selected.node.classList.remove('selected');
      state.selected = null;
    }
  }

  // 判定是否匹配
  function judge(sel, cur) {
    if (sel.id === cur.id) {
      handleMatch(sel.node, cur.node);
    } else {
      handleWrong(sel.node, cur.node);
    }
  }

  // 匹配成功：播放气泡音 → 绘制连线 → 卡片消失 → 检查回合是否结束
  function handleMatch(enSideNode, zhSideNode) {
    var leftNode  = enSideNode.dataset.side === 'en' ? enSideNode : zhSideNode;
    var rightNode = enSideNode.dataset.side === 'en' ? zhSideNode : enSideNode;

    state.locked = true;
    clearSelection();
    playMatchSound();   // 配对成功的提示音

    var line = drawLine(leftNode, rightNode);
    leftNode.classList.add('matched');
    rightNode.classList.add('matched');

    setTimeout(function () {
      leftNode.classList.add('gone');
      rightNode.classList.add('gone');
      removeLine(line);
      state.matched++;
      state.locked = false;

      var left = ROUND_SIZE - state.matched;
      setHint(left > 0 ? '配对成功，本回合还剩 ' + left + ' 组' : '本回合全部配对完成');

      if (state.matched === ROUND_SIZE) {
        setTimeout(completeRound, 420);   // 等消失动画结束后切换
      }
    }, MATCH_DELAY);
  }

  // 匹配失败：两张卡片短暂标亮提示，然后取消选中
  function handleWrong(a, b) {
    state.locked = true;
    playWrongSound();   // 配对失败的「噔~」提示音
    // 记录错过的一对单词：两个词都记入「错过」，复习时都会标亮
    markWrong(Number(a.dataset.id));
    markWrong(Number(b.dataset.id));
    saveStore();

    a.classList.add('wrong');
    b.classList.add('wrong');
    setHint('配对不正确，请重新选择');

    setTimeout(function () {
      a.classList.remove('wrong');
      b.classList.remove('wrong');
      clearSelection();
      state.locked = false;
      setHint('请重新点击左侧英文单词卡片');
    }, WRONG_DELAY);
  }

  /* ==========================================================
   * 回合 / 关卡流程
   * ========================================================== */

  function startGame() {
    SoundLib.unlock();   // 用户手势里解锁音频，避免浏览器自动播放限制
    state.difficultyKey = dom.select.value;
    state.difficultyName = DIFFICULTY_NAME[state.difficultyKey];
    resetGame();
    showScreen('game');
    loadRound(0);
  }

  function resetGame() {
    if (state.nextTimerId) {           // 清掉可能残留的切回合延时器
      clearTimeout(state.nextTimerId);
      state.nextTimerId = null;
    }
    state.roundIndex = 0;
    state.matched = 0;
    state.selected = null;
    state.locked = false;
    state.roundClicks = 0;
    state.roundMs = 0;
    state.doneMs = 0;
    state.reviewWords = [];
    state.wrongIds = {};
    state.store = loadStore(state.difficultyKey);   // 读入该难度的练习统计
    state.pool = buildPool();                       // 只从没练过的词里组词池
    stopTimer();
  }

  // 加载指定回合：取全新 6 组单词 → 渲染 → 开始计时
  function loadRound(index) {
    state.roundIndex = index;
    state.matched = 0;
    state.selected = null;
    state.locked = false;
    state.roundClicks = 0;
    state.roundMs = 0;
    state.pairs = takeRoundWords();   // 从词池取 6 组，与前面回合不重复

    // 把本回合单词收进复习列表，并写进持久化统计（出现顺序）
    state.pairs.forEach(function (p) {
      state.reviewWords.push({ id: p.id, en: p.en, zh: p.zh });
      markSeen(p);
    });
    saveStore();

    renderRound();
    updateStatus();
    startTimer();
  }

  // 一个回合结束：停止计时、累计耗时，然后直接进入下一回合（或弹复习）
  function completeRound() {
    stopTimer();
    state.doneMs += state.roundMs;
    updateStatus();

    if (state.roundIndex < ROUND_COUNT - 1) {
      // 不弹窗打断节奏：短暂提示后自动加载下一回合的全新单词
      setHint('第 ' + (state.roundIndex + 1) + ' 回合完成，即将进入第 ' +
              (state.roundIndex + 2) + ' 回合');
      state.nextTimerId = setTimeout(function () {
        state.nextTimerId = null;
        loadRound(state.roundIndex + 1);
      }, NEXT_DELAY);
    } else {
      setHint('全部 ' + ROUND_COUNT + ' 个回合完成');
      showFinalReview();
    }
  }

  // 通关后的复习面板：本关 18 个单词，左英右中，错过的标亮
  function showFinalReview() {
    dom.fmSub.textContent = state.difficultyName + ' · ' + ROUND_COUNT +
                            ' 个回合全部完成 · 总用时 ' + formatTime(state.doneMs);
    renderReviewRows(dom.reviewList, state.reviewWords, state.wrongIds);
    dom.finalModal.classList.remove('hidden');
  }

  /* ==========================================================
   * 首页复习区块：展示该难度「历史上出现过的全部单词」
   * 数据来源就是 localStorage 里那份统计（seen 顺序 + wrong 标记）
   * ========================================================== */

  function updateReviewEntry() {
    var key = dom.select.value;
    var rec = loadStore(key);
    var total = BANK[key].length;
    dom.openReviewBtn.textContent =
      '复习单词（本档已练 ' + rec.seen.length + ' / ' + total + ' 词）';
  }

  function openHomeReview() {
    var key = dom.select.value;
    var rec = loadStore(key);
    var bank = BANK[key];
    var missCount = Object.keys(rec.wrong).length;

    dom.rvSub.textContent = DIFFICULTY_NAME[key] + '档 · 已练 ' +
                            rec.seen.length + ' / ' + bank.length +
                            ' 词 · 错过 ' + missCount + ' 词';

    // 显示最后保存时间：能一眼看出记录是不是还在（换地址打开时会是空的）
    dom.rvTime.textContent = rec.updatedAt
      ? '记录最后保存于 ' + fmtDate(rec.updatedAt) + '（存在本机浏览器，换地址/换设备请用导出备份）'
      : '';

    if (!rec.seen.length) {
      dom.rvList.innerHTML =
        '<p class="review-empty">这个难度还没有练习记录，先玩一局再来复习吧。</p>';
      dom.clearRecordBtn.classList.add('hidden');
      dom.homeReviewModal.classList.remove('hidden');
      return;
    }

    dom.clearRecordBtn.classList.remove('hidden');

    // 按第一次出现的顺序整理，错过的词自动排到最前面，方便优先复习
    var idSet = {};                 // 去重（理论上 seen 本身已不重复）
    var missed = [], normal = [];
    rec.seen.forEach(function (id) {
      if (idSet[id]) return;
      idSet[id] = 1;
      var w = bank[id];
      if (!w) return;
      var item = { id: id, en: w.en, zh: w.zh };
      (rec.wrong[id] ? missed : normal).push(item);
    });
    renderReviewRows(dom.rvList, missed.concat(normal), rec.wrong);

    dom.homeReviewModal.classList.remove('hidden');
  }

  function showScreen(name) {
    dom.home.classList.toggle('hidden', name !== 'home');
    dom.game.classList.toggle('hidden', name !== 'game');
    dom.finalModal.classList.add('hidden');
    dom.homeReviewModal.classList.add('hidden');
    if (name === 'home') updateReviewEntry();   // 回首页时刷新练习进度
  }

  /* ==========================================================
   * 事件绑定
   * ========================================================== */

  dom.startBtn.addEventListener('click', startGame);

  dom.board.addEventListener('click', onBoardClick);

  // 再来一局（同难度）
  dom.playAgainBtn.addEventListener('click', function () {
    dom.finalModal.classList.add('hidden');
    resetGame();
    loadRound(0);
  });

  // 返回首页重新选择难度
  dom.backHomeBtn.addEventListener('click', function () {
    showScreen('home');
    stopTimer();
  });

  // 游戏中途返回首页
  dom.quitBtn.addEventListener('click', function () {
    if (window.confirm('确定放弃本局并返回首页吗？')) {
      if (state.nextTimerId) {         // 取消挂起的切回合任务
        clearTimeout(state.nextTimerId);
        state.nextTimerId = null;
      }
      stopTimer();
      showScreen('home');
    }
  });

  // 首页复习区块
  dom.openReviewBtn.addEventListener('click', openHomeReview);
  dom.closeReviewBtn.addEventListener('click', function () {
    dom.homeReviewModal.classList.add('hidden');
  });
  dom.clearRecordBtn.addEventListener('click', function () {
    if (!window.confirm('确定清空该难度下的全部练习记录吗？\n清空后抽词会从词库头部重新开始。')) return;
    var key = dom.select.value;
    try { localStorage.removeItem(STORE_KEY + '_' + key); } catch (e) {}
    state.store = loadStore(key);
    openHomeReview();      // 重新渲染（会显示空提示）
    updateReviewEntry();
  });

  // 导出 / 导入备份：防止换地址、换浏览器后练习记录丢失
  dom.exportBtn.addEventListener('click', exportRecords);
  dom.importBtn.addEventListener('click', function () {
    dom.importFile.click();     // 用隐藏的 file 输入框触发选择文件
  });
  dom.importFile.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { importRecords(String(reader.result)); };
    reader.onerror = function () { window.alert('读取文件失败，请重试。'); };
    reader.readAsText(file);
    e.target.value = '';        // 清空，方便再次导入同一个文件
  });

  // 切换难度时同步刷新首页按钮上的进度文案
  dom.select.addEventListener('change', updateReviewEntry);

  // 窗口尺寸变化时清掉临时连线，避免坐标错位
  window.addEventListener('resize', function () {
    dom.lines.innerHTML = '';
  });

  // 初始：刷新首页按钮上的练习进度
  updateReviewEntry();
})();
