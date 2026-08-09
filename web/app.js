(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pullTimer = null;
  var bridgeTimer = null;
  var publishTimer = null;
  var SIDEBAR_KEY = 'dzmm-console-sidebar-collapsed';
  var CONSOLE_MODE_KEY = 'dzmm-console-mode';
  var CONSOLE_CARD_KEY = 'dzmm-console-card-id';
  var consoleMode = 'game'; // game | card
  var lastGamePanel = 'login';
  var FAB_POS_KEY = 'dzmm-console-fab-pos';
  var FAB_CIRC = 2 * Math.PI * 20; // r=20
  var currentCardId = '';
  var currentCard = null;
  var currentCardMtime = 0;
  var currentCardFolder = '';
  var cardPollTimer = null;
  var cardListPollTimer = null;
  var cardListPollBusy = false;
  var cardListPollTick = 0;
  var lastLocalListSig = '';
  var lastCloudListSig = '';
  var cardApplyingRemote = false;
  var voiceCatalog = { public: [], mine: [] };
  var voiceAudio = null;
  var cloudCardItems = [];
  var cloudCardFilter = 'all'; // all | draft | pub
  var cloudCardSearch = '';
  var cloudVisibleCount = 20;
  var cardPlayMode = false;
  var playState = {
    chatId: '',
    cardId: 0,
    messages: [],
    sending: false,
    modelsLoaded: false,
    presetsLoaded: false,
    defaultModel: '',
    modelGroups: [],
    selectedGroupKey: '',
    selectedModel: '',
    charName: '',
    userName: '',
    presetCatalog: [],
    selectedPresetIds: [],
    // 会话设置（chat.getSettings / updateSettings）
    title: '会话',
    style: 'standard',
    maxTokens: 2500,
    imageGenerationModel: 'anime',
    enableHighlight: false,
    classicUi: false,
  };
  var CLOUD_PAGE_SIZE = 20;
  var cloudSearchTimer = null;

  function previewEmbedUrl(url) {
    if (!url) return '';
    try {
      var u = new URL(url, window.location.href);
      u.searchParams.set('embed', '1');
      return u.toString();
    } catch (_) {
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'embed=1';
    }
  }

  function showMsg(text, ok) {
    var el = $('msg');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    var toast = $('fabToast');
    if (toast) {
      var dock = $('fabDock');
      var showToast = !!(text && dock && !dock.hidden);
      toast.hidden = !showToast;
      toast.textContent = text || '';
      toast.className = 'fab-toast' + (ok ? '' : ' is-err');
    }
  }

  function setBusy(busy, opts) {
    opts = opts || {};
    var keep = opts.keepEnabled || {};
    ['loginBtn', 'logoutBtn', 'pingBtn', 'pullBtn', 'pullRetryBtn', 'previewStartBtn', 'previewStopBtn', 'previewReloadBtn', 'publishBtn', 'bridgeRefreshBtn', 'fabPublish', 'fabReload', 'fabSync', 'fabExpand', 'cardAiBtn', 'cardCopyPromptBtn', 'cardNewBtn2', 'cardSaveBtn', 'cardExportPngBtn', 'cardRefreshBtn', 'cardCloudBtn', 'cardReloadBtn', 'cardMenuBtn', 'cardVoiceRefreshBtn', 'cardVoiceClearBtn', 'cardPublishBtn', 'cardDraftBtn', 'cardCloudFilterAll', 'cardCloudFilterDraft', 'cardCloudFilterPub', 'cardCloudSearch'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (busy && keep[id]) {
        el.disabled = false;
        return;
      }
      el.disabled = !!busy;
    });
    // 文件选择不要 disabled：禁用会导致 label 点不开系统对话框
    ['cardAvatarFile', 'cardImageFile'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = false;
    });
  }

  function reloadPreviewOnly() {
    var frame = $('previewFrame');
    if (!frame) return false;
    var src = frame.getAttribute('src') || '';
    if (!src || src === 'about:blank') {
      showMsg('预览未启动，请先点「启动预览」', false);
      return false;
    }
    try {
      // 同域时可直接 reload；跨端口也兜底改 src 带时间戳
      if (frame.contentWindow) {
        frame.contentWindow.location.reload();
        showMsg('已刷新预览', true);
        return true;
      }
    } catch (_) {}
    try {
      var u = new URL(src, window.location.href);
      u.searchParams.set('_ts', String(Date.now()));
      frame.dataset.url = u.origin + u.pathname + (u.searchParams.get('embed') ? '?embed=1' : '');
      frame.src = u.toString();
      showMsg('已刷新预览', true);
      return true;
    } catch (_) {
      frame.src = src;
      showMsg('已刷新预览', true);
      return true;
    }
  }

  function setFabProgress(percent, mode) {
    var prog = $('fabProg');
    var fab = $('fabPublish');
    var label = $('fabLabel');
    if (!prog || !fab) return;
    var p = Math.max(0, Math.min(100, Number(percent) || 0));
    prog.style.strokeDasharray = String(FAB_CIRC);
    prog.style.strokeDashoffset = String(FAB_CIRC * (1 - p / 100));
    fab.classList.remove('is-ok', 'is-err');
    if (mode === 'ok') {
      fab.classList.add('is-ok');
      label.textContent = '完成';
    } else if (mode === 'err') {
      fab.classList.add('is-err');
      label.textContent = '失败';
    } else if (mode === 'run') {
      label.textContent = Math.round(p) + '%';
    } else {
      label.textContent = '发布';
    }
  }

  function isCardMode() {
    return !!( $('appShell') && $('appShell').classList.contains('is-card-mode') );
  }

  function setSidebarCollapsed(collapsed) {
    var app = $('appShell');
    var fab = $('fabDock');
    if (!app) return;
    if (collapsed) {
      app.classList.add('is-collapsed');
      // 角色卡全屏不显示游戏 FAB；游戏全屏才显示
      if (fab) fab.hidden = isCardMode();
      try { localStorage.setItem(SIDEBAR_KEY, '1'); } catch (_) {}
    } else {
      app.classList.remove('is-collapsed');
      if (fab) fab.hidden = true;
      try { localStorage.setItem(SIDEBAR_KEY, '0'); } catch (_) {}
      setFabProgress(0, 'idle');
    }
  }

  function setCardFullscreen(on) {
    var app = $('appShell');
    if (!app) return;
    if (on) {
      app.classList.add('is-card-mode');
      setSidebarCollapsed(true);
    } else {
      app.classList.remove('is-card-mode');
      var fab = $('fabDock');
      if (fab && isSidebarCollapsed()) fab.hidden = false;
    }
  }

  function isSidebarCollapsed() {
    return !!( $('appShell') && $('appShell').classList.contains('is-collapsed') );
  }

  function renderBridge(bridge, preview) {
    var card = $('bridgeCard');
    var alive = !!(preview && preview.running);
    card.className = 'bridge-card ' + (alive && bridge && bridge.loggedIn ? 'on' : 'off');
    $('bridgeLamp').className = 'dot';
    if (!alive) {
      $('bridgeHeadText').textContent = '预览未启动';
      $('bridgeProject').textContent = '—';
      $('bridgeContainer').textContent = '—';
      $('bridgePort').textContent = (preview && preview.port) || $('previewPort').value || '—';
      $('bridgeUser').textContent = '—';
      $('bridgeServices').textContent = '启动预览后显示云端接入状态';
      $('bridgeRemain').textContent = '—';
      return;
    }
    if (!bridge) {
      $('bridgeHeadText').textContent = '预览已启动 · 桥接读取中';
      $('bridgePort').textContent = preview.port || '—';
      return;
    }
    $('bridgeHeadText').textContent = bridge.loggedIn ? '已连接 DZMM 云端' : '预览已启动 · 未登录';
    $('bridgeProject').textContent = bridge.projectName || '—';
    $('bridgeContainer').textContent = bridge.containerShort || bridge.containerId || bridge.gameId || '—';
    $('bridgePort').textContent = bridge.port || preview.port || '—';
    $('bridgeUser').textContent = bridge.displayName || bridge.email || '—';
    $('bridgeServices').textContent = bridge.services || '服务端函数、生图、对话模型已接入';
    var remain = bridge.remainSec != null ? bridge.remainSec : bridge.remain;
    var mins = bridge.remainMin != null ? bridge.remainMin : Math.floor((remain || 0) / 60);
    $('bridgeRemain').textContent = '登录态剩余约 ' + mins + ' 分钟（' + (remain || 0) + 's）';
  }

  async function refreshBridge() {
    try {
      var data = await api('/api/bridge');
      renderBridge(data.bridge, data.preview || {});
      return data;
    } catch (e) {
      renderBridge(null, { running: false });
      return null;
    }
  }

  function startBridgePoll() {
    stopBridgePoll();
    refreshBridge();
    bridgeTimer = setInterval(refreshBridge, 5000);
  }

  function stopBridgePoll() {
    if (bridgeTimer) {
      clearInterval(bridgeTimer);
      bridgeTimer = null;
    }
  }

  function stopPublishPoll() {
    if (publishTimer) {
      clearInterval(publishTimer);
      publishTimer = null;
    }
  }

  function startPublishPoll() {
    stopPublishPoll();
    publishTimer = setInterval(async function () {
      try {
        var data = await api('/api/bridge/publish');
        var job = data.job || {};
        var wrap = $('publishBarWrap');
        var bar = $('publishBar');
        var pct = Number(job.percent) || 0;
        if (job.status === 'running') {
          wrap.hidden = false;
          bar.style.width = Math.max(8, pct || 10) + '%';
          $('publishMsg').textContent = job.message || '发布中…';
          setFabProgress(Math.max(8, pct || 10), 'run');
        } else {
          wrap.hidden = job.status !== 'ok' && job.status !== 'error';
          bar.style.width = job.status === 'ok' ? '100%' : pct + '%';
          if (job.status === 'ok') {
            $('publishMsg').textContent = job.message || '发布成功';
            setFabProgress(100, 'ok');
            showMsg('发布成功', true);
            stopPublishPoll();
            setBusy(false);
            setTimeout(function () { setFabProgress(0, 'idle'); }, 1600);
          } else if (job.status === 'error') {
            $('publishMsg').textContent = job.message || '发布失败';
            setFabProgress(pct || 100, 'err');
            showMsg(job.message || '发布失败', false);
            stopPublishPoll();
            setBusy(false);
            setTimeout(function () { setFabProgress(0, 'idle'); }, 2200);
          }
        }
      } catch (_) {}
    }, 900);
  }

  async function runPublish(options) {
    var opts = options || {};
    var direct = !!opts.direct;
    if (!direct && !confirm('确认发布到线上玩家版？\n将把当前容器内容正式上线。')) return;
    setBusy(true);
    $('publishBarWrap').hidden = false;
    $('publishBar').style.width = '12%';
    $('publishMsg').textContent = '正在发布…';
    setFabProgress(12, 'run');
    showMsg('正在发布…', true);
    try {
      var data = await api('/api/bridge/publish', {
        method: 'POST',
        body: JSON.stringify({ message: 'publish from local console' }),
      });
      if (!data.ok) {
        showMsg(data.error || '发布失败', false);
        $('publishMsg').textContent = data.error || '发布失败';
        setFabProgress(100, 'err');
        setBusy(false);
        setTimeout(function () { setFabProgress(0, 'idle'); }, 2200);
        return;
      }
      if (data.via === 'studio') {
        $('publishBar').style.width = '100%';
        $('publishMsg').textContent = data.message || '发布成功';
        setFabProgress(100, 'ok');
        showMsg(data.message || '发布成功', true);
        setBusy(false);
        setTimeout(function () { setFabProgress(0, 'idle'); }, 1600);
        return;
      }
      startPublishPoll();
    } catch (e) {
      showMsg(String(e.message || e), false);
      setFabProgress(100, 'err');
      setBusy(false);
      setTimeout(function () { setFabProgress(0, 'idle'); }, 2200);
    }
  }

  function setStageLive(alive) {
    var wrap = document.querySelector('.stage-frame');
    if (!wrap) return;
    if (alive) wrap.classList.add('is-live');
    else wrap.classList.remove('is-live');
  }

  function renderPreview(preview) {
    var meta = $('previewMeta');
    var link = $('previewLink');
    var frame = $('previewFrame');
    if (!preview) {
      meta.textContent = '预览未启动';
      link.href = '#';
      setStageLive(false);
      return;
    }
    var url = preview.url || '';
    var alive = !!(preview.running && url);
    if (alive) {
      meta.textContent = '预览中 · ' + url + (preview.projectPath ? ' · ' + preview.projectPath : '');
      link.href = url;
      setStageLive(true);
      var embed = previewEmbedUrl(url);
      if (frame.dataset.url !== embed) {
        frame.dataset.url = embed;
        frame.src = embed + (embed.indexOf('?') >= 0 ? '&' : '?') + '_ts=' + Date.now();
      }
      startBridgePoll();
    } else {
      meta.textContent = preview.message || preview.error || '预览未启动';
      link.href = url || '#';
      if (!preview.running) {
        setStageLive(false);
        stopBridgePoll();
        renderBridge(null, preview);
      }
      if (preview.error) {
        frame.dataset.url = '';
        frame.src = 'about:blank';
        setStageLive(false);
        stopBridgePoll();
      }
    }
  }

  function setStageMode(mode) {
    var game = $('gameStage');
    var card = $('cardStage');
    if (!game || !card) return;
    var isCard = mode === 'card';
    if (isCard) {
      game.setAttribute('hidden', '');
      card.removeAttribute('hidden');
    } else {
      card.setAttribute('hidden', '');
      game.removeAttribute('hidden');
    }
  }

  function switchPanel(name, opts) {
    opts = opts || {};
    if (!name) return;
    if (name === 'card') {
      if (consoleMode !== 'card') {
        switchConsoleMode('card', { skipPanel: true });
      }
    } else if (consoleMode !== 'game') {
      switchConsoleMode('game', { skipPanel: true, panel: name });
    }

    document.querySelectorAll('.menu-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-panel') === name);
    });
    document.querySelectorAll('.sidebar-scroll .panel').forEach(function (panel) {
      var match = panel.getAttribute('data-panel') === name;
      panel.classList.toggle('active', match);
      if (match) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });

    if (name === 'card') {
      setStageMode('card');
      // 切到角色卡：侧栏直接是本地写卡；打开具体卡时再全屏
      if (opts.fullscreen) setCardFullscreen(true);
      else setCardFullscreen(false);
      startCardListPoll();
      if ($('cardBrief') && $('cardBriefMain') && !$('cardBriefMain').value) {
        $('cardBriefMain').value = $('cardBrief').value || '';
      }
      if (currentCardId) startCardPoll();
    } else {
      lastGamePanel = name;
      stopCardPoll();
      stopCardListPoll();
      setStageMode('game');
      setCardFullscreen(false);
    }
  }

  function switchConsoleMode(mode, opts) {
    opts = opts || {};
    mode = mode === 'card' ? 'card' : 'game';
    consoleMode = mode;
    try { localStorage.setItem(CONSOLE_MODE_KEY, mode); } catch (_) {}

    document.querySelectorAll('.mode-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.toggle('is-card-console', mode === 'card');

    if (opts.skipPanel) return;

    if (mode === 'card') {
      switchPanel('card', { fullscreen: false });
    } else {
      switchPanel(opts.panel || lastGamePanel || 'login');
    }
  }

  function tagsToText(tags) {
    if (!Array.isArray(tags)) return '';
    return tags.map(function (t) { return String(t || '').trim(); }).filter(Boolean).join(', ');
  }

  function textToTags(text) {
    return String(text || '')
      .split(/[,，]/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  function cardAssetUrl(localId, url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u) || u.indexOf('/api/card/asset') === 0 || u.indexOf('data:') === 0) {
      return u;
    }
    // 本地相对路径：assets/avatar.png
    var rel = u.replace(/^local:\/\//, '');
    if (!localId) return '';
    return '/api/card/asset?id=' + encodeURIComponent(localId) +
      '&path=' + encodeURIComponent(rel) +
      '&t=' + encodeURIComponent(String(currentCardMtime || Date.now()));
  }

  function updateAvatarPreview(url) {
    var img = $('cardAvatarPreview');
    var empty = $('cardAvatarEmpty');
    if (!img) return;
    var src = cardAssetUrl(currentCardId, url || ($('cardAvatarUrl') && $('cardAvatarUrl').value) || '');
    if (!src) {
      img.removeAttribute('src');
      img.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    img.src = src;
    img.hidden = false;
    if (empty) empty.hidden = true;
  }

  function renderImageGallery(images) {
    var box = $('cardImageGallery');
    if (!box) return;
    box.innerHTML = '';
    (images || []).forEach(function (it, idx) {
      var tile = document.createElement('div');
      tile.className = 'image-tile';
      var img = document.createElement('img');
      img.alt = it.name || ('立绘' + (idx + 1));
      img.src = cardAssetUrl(currentCardId, it.url || '');
      var name = document.createElement('div');
      name.className = 'image-tile-name';
      name.textContent = it.name || it.url || ('#' + (idx + 1));
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.textContent = '删除';
      del.addEventListener('click', function () { removeCardImage(idx); });
      tile.appendChild(img);
      tile.appendChild(name);
      tile.appendChild(del);
      box.appendChild(tile);
    });
    if (!images || !images.length) {
      box.innerHTML = '<p class="hint">还没有立绘，点上面导入</p>';
    }
  }

  function renderVoiceSelected(vs) {
    var el = $('cardVoiceSelected');
    if (!el) return;
    if (!vs || !vs.voice) {
      el.textContent = '未选择音色';
      return;
    }
    var v = vs.voice;
    el.textContent = '已选 · ' + (v.name || v.id) + (v.gender ? ' · ' + v.gender : '');
  }

  function filteredVoices() {
    var q = (($('cardVoiceSearch') && $('cardVoiceSearch').value) || '').trim().toLowerCase();
    var gender = ($('cardVoiceGender') && $('cardVoiceGender').value) || 'all';
    var all = [].concat(voiceCatalog.mine || [], voiceCatalog.public || []);
    return all.filter(function (v) {
      if (gender !== 'all' && String(v.gender || '') !== gender) return false;
      if (!q) return true;
      var blob = ((v.name || '') + ' ' + (v.description || '')).toLowerCase();
      return blob.indexOf(q) >= 0;
    });
  }

  function renderVoiceList() {
    var box = $('cardVoiceList');
    if (!box) return;
    box.innerHTML = '';
    var selectedId = '';
    try {
      var vs = safeJsonParse($('cardVoiceSettings') && $('cardVoiceSettings').value, null);
      selectedId = (vs && vs.voice && vs.voice.id) || '';
    } catch (_) {}
    var items = filteredVoices().slice(0, 80);
    if (!items.length) {
      box.innerHTML = '<p class="hint">无匹配音色（先点刷新，或放宽筛选）</p>';
      return;
    }
    items.forEach(function (v) {
      var card = document.createElement('div');
      card.className = 'voice-card' + (v.id === selectedId ? ' is-selected' : '');
      var av = document.createElement(v.avatarUrl ? 'img' : 'div');
      if (v.avatarUrl) {
        av.src = v.avatarUrl;
        av.alt = v.name || '';
      } else {
        av.className = 'voice-fallback';
        av.textContent = String(v.name || '?').charAt(0);
      }
      var meta = document.createElement('div');
      meta.className = 'voice-meta';
      meta.innerHTML =
        '<p class="voice-name"></p><p class="voice-sub"></p><div class="voice-actions"></div>';
      meta.querySelector('.voice-name').textContent = (v.mine ? '[我的] ' : '') + (v.name || v.id);
      meta.querySelector('.voice-sub').textContent =
        (v.gender || '未知') + (v.description ? ' · ' + v.description : '');
      var actions = meta.querySelector('.voice-actions');
      var playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn';
      playBtn.textContent = '试听';
      playBtn.disabled = !v.previewUrl;
      playBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!v.previewUrl) return;
        try {
          if (voiceAudio) { voiceAudio.pause(); }
          voiceAudio = new Audio(v.previewUrl);
          voiceAudio.play();
        } catch (_) {}
      });
      var pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = 'btn accent';
      pickBtn.textContent = '选用';
      pickBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        selectVoice(v);
      });
      actions.appendChild(playBtn);
      actions.appendChild(pickBtn);
      card.appendChild(av);
      card.appendChild(meta);
      box.appendChild(card);
    });
  }

  function safeJsonParse(text, fallback) {
    var raw = String(text || '').trim();
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function renderWorldBookEntries(entries) {
    var box = $('cardWbEntries');
    if (!box) return;
    box.innerHTML = '';
    (entries || []).forEach(function (ent, idx) {
      var wrap = document.createElement('div');
      wrap.className = 'wb-entry';
      wrap.dataset.idx = String(idx);
      wrap.innerHTML =
        '<div class="wb-entry-head"><strong>条目 ' + (idx + 1) + '</strong>' +
        '<button type="button" class="btn wb-del" data-idx="' + idx + '">删除</button></div>' +
        '<label><span>标题 name</span><input class="wb-name" type="text"></label>' +
        '<label><span>关键词 keys（逗号分隔；常驻可空）</span><input class="wb-keys" type="text"></label>' +
        '<label><span>正文 content</span><textarea class="wb-content" rows="4"></textarea></label>' +
        '<div class="wb-checks">' +
        '<label><input class="wb-enabled" type="checkbox"> 启用</label>' +
        '<label><input class="wb-constant" type="checkbox"> 常驻 constant</label>' +
        '</div>' +
        '<label><span>备注 comment</span><input class="wb-comment" type="text"></label>';
      box.appendChild(wrap);
      wrap.querySelector('.wb-name').value = ent.name || '';
      wrap.querySelector('.wb-keys').value = tagsToText(ent.keys || []);
      wrap.querySelector('.wb-content').value = ent.content || '';
      wrap.querySelector('.wb-enabled').checked = ent.enabled !== false;
      wrap.querySelector('.wb-constant').checked = !!ent.constant;
      wrap.querySelector('.wb-comment').value = (ent.extensions && ent.extensions.comment) || '';
      wrap.querySelector('.wb-del').addEventListener('click', function () {
        var list = collectWorldBookEntries();
        list.splice(idx, 1);
        renderWorldBookEntries(list);
        updateCardPreview();
      });
      wrap.querySelectorAll('input, textarea').forEach(function (field) {
        field.addEventListener('input', updateCardPreview);
        field.addEventListener('change', updateCardPreview);
      });
    });
  }

  function collectWorldBookEntries() {
    var box = $('cardWbEntries');
    if (!box) return [];
    var out = [];
    box.querySelectorAll('.wb-entry').forEach(function (wrap, idx) {
      var comment = (wrap.querySelector('.wb-comment').value || '').trim();
      out.push({
        id: idx + 1,
        name: wrap.querySelector('.wb-name').value.trim() || ('条目' + (idx + 1)),
        keys: textToTags(wrap.querySelector('.wb-keys').value),
        content: wrap.querySelector('.wb-content').value,
        enabled: !!wrap.querySelector('.wb-enabled').checked,
        constant: !!wrap.querySelector('.wb-constant').checked,
        insertion_order: idx,
        position: 4,
        priority: 100,
        extensions: comment ? { comment: comment } : {},
      });
    });
    return out;
  }

  function fillCardForm(card, localId, opts) {
    opts = opts || {};
    cardApplyingRemote = true;
    currentCard = card || null;
    currentCardId = localId || (card && card._meta && card._meta.localId) || '';
    currentCardFolder = (card && card._meta && card._meta.folder) || currentCardFolder || '';
    try {
      if (currentCardId) localStorage.setItem(CONSOLE_CARD_KEY, currentCardId);
    } catch (_) {}
    if (typeof opts.mtime === 'number') currentCardMtime = opts.mtime;
    else if (card && card._meta && card._meta.mtime) currentCardMtime = Number(card._meta.mtime) || currentCardMtime;
    var d = (card && card.data) || {};
    var brief = (card && card._meta && card._meta.brief) || '';
    var book = d.character_book || {};
    $('cardName').value = d.name || '';
    $('cardDescription').value = d.description || '';
    $('cardPersonality').value = d.personality || '';
    $('cardScenario').value = d.scenario || '';
    if ($('cardSystemPrompt')) $('cardSystemPrompt').value = d.system_prompt || '';
    $('cardFirstMes').value = d.first_mes || '';
    $('cardTags').value = tagsToText(d.tags);
    $('cardNotes').value = d.creator_notes || '';
    if ($('cardCreator')) $('cardCreator').value = d.creator || '';
    if ($('cardVersion')) $('cardVersion').value = d.character_version || '';
    if ($('cardBookName')) $('cardBookName').value = book.name || '世界设定';
    renderWorldBookEntries(Array.isArray(book.entries) ? book.entries : []);
    if ($('cardSuggestedReplies')) {
      $('cardSuggestedReplies').value = Array.isArray(d.suggested_replies) ? d.suggested_replies.join('\n') : '';
    }
    if ($('cardChatHistory')) {
      $('cardChatHistory').value = JSON.stringify(d.chat_history || [], null, 2);
    }
    if ($('cardAvatarUrl')) $('cardAvatarUrl').value = d.avatar_url || '';
    updateAvatarPreview(d.avatar_url || '');
    if ($('cardImageInfo')) $('cardImageInfo').value = JSON.stringify(d.image_info || [], null, 2);
    renderImageGallery(Array.isArray(d.image_info) ? d.image_info : []);
    if ($('cardVoiceSettings')) {
      $('cardVoiceSettings').value = d.voice_settings == null
        ? ''
        : JSON.stringify(d.voice_settings, null, 2);
    }
    renderVoiceSelected(d.voice_settings || null);
    renderVoiceList();
    if ($('cardBriefMain')) $('cardBriefMain').value = brief;
    if ($('cardBrief')) $('cardBrief').value = brief;
    if ($('cardFolderName') && currentCardId) $('cardFolderName').value = currentCardId;
    var wbCount = (book.entries && book.entries.length) || 0;
    $('cardStageMeta').textContent = (currentCardFolder || ('卡/' + currentCardId)) +
      ' · 世界书 ' + wbCount + ' 条';
    updateCardPreview();
    cardApplyingRemote = false;
    if (currentCardId) startCardPoll();
    updatePlayGate();
    // 换卡时退出试玩会话
    if (cardPlayMode && playState.cardId && playState.cardId !== currentCloudCardId()) {
      exitCardPlay({ keepPanel: false });
    }
  }

  function collectCardFromForm() {
    var base = currentCard && typeof currentCard === 'object'
      ? JSON.parse(JSON.stringify(currentCard))
      : {
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: {},
          _meta: { source: 'local-folder' },
        };
    if (!base.data || typeof base.data !== 'object') base.data = {};
    if (!base._meta || typeof base._meta !== 'object') base._meta = {};
    base.data.name = $('cardName').value.trim() || ($('cardFolderName') && $('cardFolderName').value.trim()) || '未命名角色';
    base.data.description = $('cardDescription').value;
    base.data.personality = $('cardPersonality').value;
    base.data.scenario = $('cardScenario').value;
    base.data.system_prompt = ($('cardSystemPrompt') && $('cardSystemPrompt').value) || '';
    base.data.first_mes = $('cardFirstMes').value;
    base.data.tags = textToTags($('cardTags').value);
    base.data.creator_notes = $('cardNotes').value;
    base.data.creator = ($('cardCreator') && $('cardCreator').value) || '';
    base.data.character_version = ($('cardVersion') && $('cardVersion').value) || '';
    base.data.character_book = {
      name: ($('cardBookName') && $('cardBookName').value.trim()) || '世界设定',
      entries: collectWorldBookEntries(),
      extensions: (base.data.character_book && base.data.character_book.extensions) || {},
    };
    base.data.suggested_replies = ($('cardSuggestedReplies') && $('cardSuggestedReplies').value || '')
      .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    base.data.chat_history = safeJsonParse($('cardChatHistory') && $('cardChatHistory').value, base.data.chat_history || []);
    base.data.avatar_url = ($('cardAvatarUrl') && $('cardAvatarUrl').value.trim()) || '';
    base.data.image_info = safeJsonParse($('cardImageInfo') && $('cardImageInfo').value, base.data.image_info || []);
    var voiceRaw = ($('cardVoiceSettings') && $('cardVoiceSettings').value || '').trim();
    base.data.voice_settings = voiceRaw ? safeJsonParse(voiceRaw, base.data.voice_settings || null) : null;
    base._meta.brief = getCardBrief();
    base.spec = base.spec || 'chara_card_v3';
    base.spec_version = base.spec_version || '3.0';
    return base;
  }

  function stopCardPoll() {
    if (cardPollTimer) {
      clearInterval(cardPollTimer);
      cardPollTimer = null;
    }
  }

  function startCardPoll() {
    stopCardPoll();
    if (!currentCardId) return;
    cardPollTimer = setInterval(async function () {
      if (!currentCardId || !isCardMode()) return;
      // 正在某个字段打字时不覆盖；失焦后立刻吃磁盘更新
      var ae = document.activeElement;
      var form = $('cardForm');
      if (form && ae && form.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return;
      }
      try {
        var data = await api(
          '/api/card/poll?id=' + encodeURIComponent(currentCardId) +
          '&since=' + encodeURIComponent(String(currentCardMtime || 0))
        );
        if (!data.ok || !data.changed || !data.card) return;
        fillCardForm(data.card, data.localId || currentCardId, { mtime: data.mtime || 0 });
        currentCardFolder = data.folder || currentCardFolder;
        setCardMsg('已同步本地文件 · ' + (data.localId || currentCardId), true);
      } catch (_) {}
    }, 700);
  }

  function stopCardListPoll() {
    if (cardListPollTimer) {
      clearInterval(cardListPollTimer);
      cardListPollTimer = null;
    }
    cardListPollBusy = false;
  }

  function listItemsSig(items, kind) {
    return (items || []).map(function (it) {
      if (kind === 'cloud') {
        return [
          it.cloudId, it.isDraft ? 1 : 0, it.name || '',
          it.isListed ? 1 : 0, it.isPendingReview ? 1 : 0,
          it.publishStatus || '', it.dbId || '', it.updatedAt || it.createdAt || ''
        ].join('\t');
      }
      return [
        it.localId, it.mtime || 0, it.updatedAt || '',
        it.cloudId || '', it.draftId || '',
        it.isListed ? 1 : 0, it.isPendingReview ? 1 : 0, it.publishStatus || '',
        it.name || ''
      ].join('\t');
    }).join('|');
  }

  async function tickCardLists() {
    if (consoleMode !== 'card' || cardListPollBusy) return;
    cardListPollBusy = true;
    cardListPollTick += 1;
    try {
      await refreshCardList({ quiet: true });
      // 多数轮询走轻量云端列表；每 4 次补一次上架状态
      var quick = (cardListPollTick % 4) !== 0;
      await refreshCloudCardList(false, { quiet: true, quick: quick, skipLocal: true });
    } catch (_) {
      // 静默：登录失效时不刷错误打扰编辑
    } finally {
      cardListPollBusy = false;
    }
  }

  function startCardListPoll() {
    stopCardListPoll();
    lastLocalListSig = '';
    lastCloudListSig = '';
    cardListPollTick = 0;
    tickCardLists();
    cardListPollTimer = setInterval(tickCardLists, 2500);
  }

  var _tokenEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  /** SillyTavern / GPT 常见估算：UTF-8 字节长度 ÷ 4 */
  function estimateTokens(text) {
    var s = text == null ? '' : String(text);
    if (!s) return 0;
    var bytes = _tokenEncoder ? _tokenEncoder.encode(s).length : unescape(encodeURIComponent(s)).length;
    return Math.ceil(bytes / 4);
  }

  function joinTokenParts(parts) {
    return (parts || []).filter(function (p) { return p != null && String(p).length; }).join('\n');
  }

  function worldBookEntryText(ent) {
    if (!ent || ent.enabled === false) return '';
    var keys = Array.isArray(ent.keys) ? ent.keys.join(', ') : '';
    return joinTokenParts([ent.name || '', keys, ent.content || '']);
  }

  function chatHistoryPlain(chat) {
    if (!Array.isArray(chat)) return '';
    var chunks = [];
    chat.forEach(function (seg) {
      if (!seg || typeof seg !== 'object') return;
      var msgs = seg.messages;
      if (!Array.isArray(msgs)) return;
      msgs.forEach(function (m) {
        if (m && m.content) chunks.push(String(m.content));
      });
    });
    return chunks.join('\n');
  }

  /**
   * 卡定义 token + 常规聊天发送 token（估算）。
   * 常驻发送 ≈ 每轮都会带上的人设；首轮 ≈ 常驻 + 开场白/开场对话 + 条件世界书全触发上限。
   */
  function computeCardTokenStats(card) {
    var d = (card && card.data) || {};
    var book = d.character_book && typeof d.character_book === 'object' ? d.character_book : {};
    var entries = Array.isArray(book.entries) ? book.entries : [];
    var enabled = entries.filter(function (e) { return e && e.enabled !== false; });
    var constant = enabled.filter(function (e) { return !!e.constant; });
    var conditional = enabled.filter(function (e) { return !e.constant; });

    var fields = {
      name: d.name || '',
      description: d.description || '',
      personality: d.personality || '',
      scenario: d.scenario || '',
      system_prompt: d.system_prompt || '',
      first_mes: d.first_mes || '',
      creator_notes: d.creator_notes || '',
      tags: Array.isArray(d.tags) ? d.tags.join(', ') : '',
      bookName: book.name || '',
      suggested: Array.isArray(d.suggested_replies) ? d.suggested_replies.join('\n') : '',
      chatHistory: chatHistoryPlain(d.chat_history),
      wbConstant: constant.map(worldBookEntryText).join('\n'),
      wbConditional: conditional.map(worldBookEntryText).join('\n'),
      wbAll: enabled.map(worldBookEntryText).join('\n'),
    };

    var tok = {};
    Object.keys(fields).forEach(function (k) { tok[k] = estimateTokens(fields[k]); });

    var cardDef = tok.name + tok.description + tok.personality + tok.scenario +
      tok.system_prompt + tok.first_mes + tok.creator_notes + tok.tags +
      tok.bookName + tok.suggested + tok.chatHistory + tok.wbAll;

    // 常规聊天每轮常驻：名称 + 简介/性格/场景/系统指令 + 常驻世界书
    var chatPermanent = tok.name + tok.description + tok.personality + tok.scenario +
      tok.system_prompt + tok.wbConstant;

    // 首轮额外：开场白（若对话流为空则用 first_mes）+ 开场对话 + 条件世界书全触发上限
    var opening = tok.chatHistory > 0 ? tok.chatHistory : tok.first_mes;
    var chatFirstRound = chatPermanent + opening + tok.wbConditional;

    return {
      cardDef: cardDef,
      chatPermanent: chatPermanent,
      chatFirstRound: chatFirstRound,
      opening: opening,
      wbConstant: tok.wbConstant,
      wbConditional: tok.wbConditional,
      firstMes: tok.first_mes,
      chatHistory: tok.chatHistory,
      breakdown: {
        description: tok.description,
        personality: tok.personality,
        scenario: tok.scenario,
        system_prompt: tok.system_prompt,
        first_mes: tok.first_mes,
        worldbook_constant: tok.wbConstant,
        worldbook_conditional: tok.wbConditional,
      },
      wbEnabled: enabled.length,
      wbConstantCount: constant.length,
      wbConditionalCount: conditional.length,
    };
  }

  function formatTok(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function tokPairHtml(label, num, en) {
    return '<span class="tok-label' + (en ? ' tok-en' : '') + '">' + label + '</span>' +
      '<span class="tok-num">' + formatTok(num) + '</span>';
  }

  function updateCardTokenStats() {
    var summary = $('cardTokenSummary');
    if (!summary) return;
    var card;
    try {
      card = collectCardFromForm();
    } catch (_) {
      summary.innerHTML = '<span class="tok-label tok-en">Token</span><span class="tok-num">—</span>';
      summary.removeAttribute('title');
      summary.classList.remove('warn', 'hot');
      return;
    }
    var st = computeCardTokenStats(card);
    summary.innerHTML =
      tokPairHtml('Token', st.cardDef, true) +
      '<span class="tok-sep">·</span>' +
      tokPairHtml('常驻', st.chatPermanent, false) +
      '<span class="tok-sep">·</span>' +
      tokPairHtml('首轮', st.chatFirstRound, false);
    summary.classList.remove('warn', 'hot');
    if (st.chatPermanent >= 3000 || st.cardDef >= 4000) summary.classList.add('hot');
    else if (st.chatPermanent >= 1800 || st.cardDef >= 2500) summary.classList.add('warn');

    var b = st.breakdown;
    summary.title =
      '卡定义 ' + formatTok(st.cardDef) +
      ' · 常驻发送 ' + formatTok(st.chatPermanent) +
      ' · 首轮约 ' + formatTok(st.chatFirstRound) +
      '\n简介' + formatTok(b.description) +
      ' / 性格' + formatTok(b.personality) +
      ' / 场景' + formatTok(b.scenario) +
      ' / 系统' + formatTok(b.system_prompt) +
      ' · 开场' + formatTok(st.opening) +
      ' · 世界书常驻' + formatTok(st.wbConstant) +
      '（' + st.wbConstantCount + '）' +
      ' / 条件≤' + formatTok(st.wbConditional) +
      '（' + st.wbConditionalCount + '）' +
      '\n估算 UTF-8÷4；卡定义=卡内全文；常驻≈人设+常驻世界书；首轮≈常驻+开场+条件世界书上限';
  }

  function updateCardPreview() {
    var name = $('cardName').value.trim() || '—';
    if ($('cardPreviewName')) $('cardPreviewName').textContent = name;
    var wb = collectWorldBookEntries();
    var parts = [];
    parts.push('分类对齐平台：基础 / 世界书 / 对话 / 图片音色');
    if ($('cardTags').value.trim()) parts.push('标签：' + $('cardTags').value.trim());
    parts.push('世界书条目：' + wb.length);
    if ($('cardSystemPrompt') && $('cardSystemPrompt').value.trim()) parts.push('已填系统指令');
    if ($('cardFirstMes').value.trim()) parts.push('已填开场白');
    var box = $('cardLivePreview');
    if (box) box.hidden = false;
    if ($('cardPreviewBody')) $('cardPreviewBody').textContent = parts.join('\n');
    updateCardTokenStats();
  }

  function setCardMsg(text, ok) {
    var el = $('cardMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok === false ? 'var(--bad)' : '';
    if (text) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  async function deleteLocalCard(localId) {
    if (!localId) return;
    if (!window.confirm('确定删除本地卡夹「' + localId + '」？此操作不可恢复。')) return;
    setBusy(true);
    try {
      var data = await api('/api/card/delete', {
        method: 'POST',
        body: JSON.stringify({ localId: localId }),
      });
      if (!data.ok) {
        showMsg(data.error || '删除失败', false);
        return;
      }
      if (currentCardId === localId) {
        currentCardId = '';
        currentCard = null;
        currentCardFolder = '';
        currentCardMtime = 0;
        stopCardPoll();
        try { localStorage.removeItem(CONSOLE_CARD_KEY); } catch (_) {}
        if ($('cardStageMeta')) $('cardStageMeta').textContent = '未打开卡';
        if ($('cardTokenSummary')) {
          $('cardTokenSummary').innerHTML =
            '<span class="tok-label tok-en">Token</span><span class="tok-num">—</span>';
          $('cardTokenSummary').classList.remove('warn', 'hot');
        }
      }
      await refreshCardList();
      showMsg('已删除本地卡 · ' + localId, true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCloudCard(it) {
    if (!it || !it.cloudId) return;
    if (!it.isDraft && it.isListed) {
      showMsg('已上架卡请到官网下架/处理，控制台不可下架', false);
      return;
    }
    var linkedId = it.characterId || it.dbId || null;
    var tip;
    var alsoHide;
    if (it.isDraft) {
      tip = '确定删除云端草稿「' + (it.name || it.cloudId) + '」？';
      alsoHide = false;
    } else {
      tip = '隐藏已保存卡「' + (it.name || it.cloudId) + '」？\n等同删除：公开页将不可访问，并清理同卡草稿。';
      alsoHide = true;
    }
    if (!window.confirm(tip)) return;
    setBusy(true);
    try {
      var data = await api('/api/card/cloud/delete', {
        method: 'POST',
        body: JSON.stringify({
          cloudId: it.cloudId,
          isDraft: !!it.isDraft,
          characterId: linkedId,
          alsoHidePublished: alsoHide,
          cascadeDrafts: true,
        }),
      });
      if (!data.ok) {
        showMsg(data.error || '云端删除失败', false);
        return;
      }
      showMsg(
        (it.isDraft ? '已删草稿' : '已隐藏（删除）') + ' · ' + it.cloudId,
        true
      );
      await refreshCloudCardList(false);
      await refreshCardList();
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  function localListedMap() {
    var map = {};
    (window.__localCardListed || []).forEach(function (it) {
      var id = parseInt(it.cloudId, 10);
      if (id > 0) map[id] = !!it.isListed;
    });
    return map;
  }

  function makeBadge(cls, text, title) {
    var el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  /** 三行：1 名字 2 状态标签 3 编号/时间 */
  function buildCardItemMeta(name, statusNodes, subText) {
    var meta = document.createElement('div');
    meta.className = 'card-item-meta';
    var n = document.createElement('p');
    n.className = 'card-item-name';
    n.textContent = name || '—';
    var status = document.createElement('div');
    status.className = 'card-item-status card-item-badges';
    (statusNodes || []).forEach(function (node) {
      if (node) status.appendChild(node);
    });
    if (!status.childNodes.length) {
      status.appendChild(makeBadge('badge-draft', '本地', '尚未同步云端'));
    }
    var s = document.createElement('p');
    s.className = 'card-item-sub';
    s.textContent = subText || '';
    meta.appendChild(n);
    meta.appendChild(status);
    meta.appendChild(s);
    return meta;
  }

  function filteredCloudItems() {
    var q = String(cloudCardSearch || '').trim().toLowerCase();
    return (cloudCardItems || []).filter(function (it) {
      if (cloudCardFilter === 'draft' && !it.isDraft) return false;
      if (cloudCardFilter === 'pub' && it.isDraft) return false;
      if (!q) return true;
      var name = String(it.name || '').toLowerCase();
      var id = String(it.cloudId || '');
      var db = String(it.dbId || it.characterId || '');
      return name.indexOf(q) >= 0 || id.indexOf(q) >= 0 || (db && db.indexOf(q) >= 0);
    });
  }

  function bindCloudListScroll() {
    var sc = $('cloudCardListScroll');
    if (!sc || sc.getAttribute('data-bound') === '1') return;
    sc.setAttribute('data-bound', '1');
    sc.addEventListener('scroll', function () {
      if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 48) return;
      var filtered = filteredCloudItems();
      if (cloudVisibleCount >= filtered.length) return;
      var keep = sc.scrollTop;
      cloudVisibleCount = Math.min(filtered.length, cloudVisibleCount + CLOUD_PAGE_SIZE);
      renderCloudCardList();
      sc.scrollTop = keep;
    });
  }

  function renderCloudCardList(opts) {
    opts = opts || {};
    if (opts.resetPage) cloudVisibleCount = CLOUD_PAGE_SIZE;
    var box = $('cloudCardBox');
    var list = $('cloudCardList');
    var more = $('cloudCardMore');
    if (!box || !list) return;
    bindCloudListScroll();
    list.innerHTML = '';
    var listedMap = localListedMap();
    var filtered = filteredCloudItems();
    if (cloudVisibleCount < CLOUD_PAGE_SIZE) cloudVisibleCount = CLOUD_PAGE_SIZE;
    if (cloudVisibleCount > filtered.length && filtered.length > 0) {
      cloudVisibleCount = filtered.length;
    }
    var items = filtered.slice(0, cloudVisibleCount);
    box.hidden = false;
    if (more) {
      if (!filtered.length) {
        more.textContent = cloudCardSearch.trim() ? '没有匹配的卡' : '云端列表为空';
      } else if (items.length < filtered.length) {
        more.textContent = '显示 ' + items.length + ' / ' + filtered.length + ' · 下拉加载更多';
      } else {
        more.textContent = '共 ' + filtered.length + ' 张';
      }
    }
    items.forEach(function (it) {
      var cid = parseInt(it.cloudId, 10);
      // 优先用云端真实 isPublic / publishStatus；本地 _meta 仅作兜底
      var isListed = !it.isDraft && !!(it.isListed || it.isPublic || listedMap[cid]);
      var isPending = !it.isDraft && !isListed && !!(
        it.isPendingReview ||
        it.publishStatus === 'pending' ||
        it.publishStatus === 'pending_notified'
      );
      it.isListed = isListed;
      it.isPendingReview = isPending;
      var li = document.createElement('li');
      if (it.isDraft) li.className = 'card-tone-draft';
      else if (isListed) li.className = 'card-tone-listed';
      else if (isPending) li.className = 'card-tone-pending';
      else li.className = 'card-tone-saved';
      var statusNodes = [];
      if (it.isDraft) {
        statusNodes.push(makeBadge('badge-draft', '草稿', '云端草稿，可删除'));
      } else if (isListed) {
        statusNodes.push(makeBadge('badge-listed', '上架到广场', '已上架 · 下架请去官网'));
      } else if (isPending) {
        statusNodes.push(makeBadge('badge-pending', '审核中', '已提交上架，等待审核'));
      } else {
        statusNodes.push(makeBadge('badge-saved', '已保存', '正式卡 · 上架请去官网'));
      }
      if (it.isGamefy) {
        statusNodes.push(makeBadge('badge-gamefy', '游戏卡', '不可拉到本地写卡'));
      }
      var idBits = '#' + it.cloudId;
      if (it.isDraft && it.dbId) idBits += ' → 正式卡 #' + it.dbId;
      if (it.createdAt) idBits += ' · ' + it.createdAt;
      var meta = buildCardItemMeta(it.name || String(it.cloudId), statusNodes, idBits);
      var actions = document.createElement('div');
      actions.className = 'card-item-actions';

      if (!it.isGamefy) {
        var pullBtn = document.createElement('button');
        pullBtn.type = 'button';
        pullBtn.className = 'btn';
        pullBtn.textContent = '拉到本地';
        pullBtn.addEventListener('click', async function () {
          setBusy(true);
          try {
            var pulled = await api('/api/card/pull', {
              method: 'POST',
              body: JSON.stringify({
                cloudId: it.cloudId,
                name: it.name || '',
                isDraft: !!it.isDraft,
              }),
            });
            if (!pulled.ok) {
              showMsg(pulled.error || '拉取失败', false);
              return;
            }
            fillCardForm(pulled.card, pulled.localId, { mtime: pulled.mtime || 0 });
            currentCardFolder = pulled.folder || pulled.path || '';
            setStageMode('card');
            setCardFullscreen(true);
            await refreshCardList();
            showMsg('已拉到 卡/' + pulled.localId + '/', true);
          } catch (err) {
            showMsg(String(err.message || err), false);
          } finally {
            setBusy(false);
          }
        });
        actions.appendChild(pullBtn);
      }

      if (it.isDraft || (!it.isDraft && !isListed && !isPending && !it.isGamefy)) {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn danger';
        delBtn.textContent = it.isDraft ? '删除' : '隐藏';
        delBtn.title = it.isDraft ? '删除云端草稿' : '隐藏已保存卡（等同删除）';
        delBtn.addEventListener('click', function () { deleteCloudCard(it); });
        actions.appendChild(delBtn);
      }

      li.appendChild(meta);
      li.appendChild(actions);
      list.appendChild(li);
    });
    if (!items.length) {
      list.innerHTML = '<li><div class="card-item-meta"><p class="card-item-name">没有匹配项</p><div class="card-item-status"></div><p class="card-item-sub"></p></div></li>';
    }
  }

  async function refreshCloudCardList(showToast, opts) {
    opts = opts || {};
    var qs = opts.quick ? '?quick=1' : '';
    var data = await api('/api/card/cloud' + qs);
    if (!data.ok) {
      if (showToast !== false && !opts.quiet) {
        showMsg(data.error || '云端列表失败（需已登录）', false);
      }
      // 轮询失败不强制藏列表；手动拉取仍隐藏
      if (!opts.quiet && $('cloudCardBox')) $('cloudCardBox').hidden = true;
      return data;
    }
    if (!opts.skipLocal) {
      try { await refreshCardList({ quiet: !!opts.quiet }); } catch (_) {}
    }
    var items = data.items || [];
    var sig = listItemsSig(items, 'cloud');
    // quick 轮询若与上次完整列表条数/id 一致则合并保留上架字段，避免绿标闪烁
    if (opts.quick && cloudCardItems.length && items.length === cloudCardItems.length) {
      var prevMap = {};
      cloudCardItems.forEach(function (it) {
        prevMap[(it.isDraft ? 'd' : 'p') + ':' + it.cloudId] = it;
      });
      items.forEach(function (it) {
        var prev = prevMap[(it.isDraft ? 'd' : 'p') + ':' + it.cloudId];
        if (!prev) return;
        if (it.isListed == null && prev.isListed != null) it.isListed = prev.isListed;
        if (it.isPendingReview == null && prev.isPendingReview != null) it.isPendingReview = prev.isPendingReview;
        if (!it.publishStatus && prev.publishStatus) it.publishStatus = prev.publishStatus;
        if (!it.isPublic && prev.isPublic) it.isPublic = prev.isPublic;
      });
      sig = listItemsSig(items, 'cloud');
    }
    if (opts.quiet && sig === lastCloudListSig) return data;
    lastCloudListSig = sig;
    cloudCardItems = items;
    renderCloudCardList();
    var drafts = cloudCardItems.filter(function (x) { return x.isDraft; }).length;
    var pubs = cloudCardItems.length - drafts;
    if (showToast !== false && !opts.quiet) {
      showMsg('云端 ' + cloudCardItems.length + ' 项 · 草稿 ' + drafts + ' · 已保存 ' + pubs, true);
    }
    return data;
  }

  async function refreshCardList(opts) {
    opts = opts || {};
    try {
      var data = await api('/api/card/list');
      var list = $('cardList');
      if (!list) return data;
      if (!data.ok) {
        if (!opts.quiet) setCardMsg(data.error || '列表失败', false);
        return data;
      }
      var items = data.items || [];
      var sig = listItemsSig(items, 'local');
      if (opts.quiet && sig === lastLocalListSig) return data;
      lastLocalListSig = sig;
      list.innerHTML = '';
      window.__localCardListed = items;
      if (!opts.quiet) {
        setCardMsg('本机 ' + items.length + ' 张 · ' + (data.cardsDir || '卡/'), true);
      }
      items.forEach(function (it) {
        var li = document.createElement('li');
        var statusNodes = [];
        var isPending = !!(it.isPendingReview || it.publishStatus === 'pending' || it.publishStatus === 'pending_notified');
        var isSaved = !!(it.published || (it.cloudId && Number(it.cloudId) > 0));
        if (it.isListed) {
          li.className = 'card-tone-listed';
          statusNodes.push(makeBadge('badge-listed', '上架到广场', '已上架 · #' + it.cloudId));
        } else if (isPending) {
          li.className = 'card-tone-pending';
          statusNodes.push(makeBadge('badge-pending', '审核中', '已提交上架 · #' + it.cloudId));
        } else if (isSaved) {
          li.className = 'card-tone-saved';
          statusNodes.push(makeBadge('badge-saved', '已保存', '正式卡 · #' + it.cloudId + ' · 上架请去官网'));
        } else if (it.draftId) {
          li.className = 'card-tone-draft';
          statusNodes.push(makeBadge('badge-draft', '草稿', 'draftId · ' + it.draftId));
        } else {
          li.className = 'card-tone-local';
          statusNodes.push(makeBadge('badge-draft', '本地', '尚未同步云端'));
        }
        var sub = '本地 · ' + it.localId;
        if (it.cloudId) sub += ' · #' + it.cloudId;
        else if (it.draftId) sub += ' · draft #' + it.draftId;
        if (it.updatedAt) sub += ' · ' + it.updatedAt;
        var meta = buildCardItemMeta(it.name || it.localId, statusNodes, sub);
        var actions = document.createElement('div');
        actions.className = 'card-item-actions';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = '打开';
        btn.addEventListener('click', function () { openLocalCard(it.localId); });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn danger';
        del.textContent = '删除';
        del.addEventListener('click', function () { deleteLocalCard(it.localId); });
        actions.appendChild(btn);
        actions.appendChild(del);
        li.appendChild(meta);
        li.appendChild(actions);
        list.appendChild(li);
      });
      return data;
    } catch (e) {
      if (!opts.quiet) setCardMsg(String(e.message || e), false);
      return { ok: false, error: String(e.message || e) };
    }
  }

  async function openLocalCard(localId) {
    setBusy(true);
    try {
      var data = await api('/api/card/get?id=' + encodeURIComponent(localId));
      if (!data.ok) {
        showMsg(data.error || '打开失败', false);
        return;
      }
      fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || '';
      setStageMode('card');
      setCardFullscreen(true);
      showMsg('已打开卡夹 · ' + (data.folder || data.localId || localId), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrentCard() {
    setBusy(true);
    showMsg('正在写入卡夹…', true);
    try {
      var card = collectCardFromForm();
      if (cardLooksEmpty(card) && currentCard && !cardLooksEmpty(currentCard)) {
        showMsg('表单几乎为空，已取消保存，避免覆盖本地已有内容。请先「重载当前」。', false);
        return;
      }
      var folderName = ($('cardFolderName') && $('cardFolderName').value.trim()) || currentCardId || card.data.name;
      var data = await api('/api/card/save', {
        method: 'POST',
        body: JSON.stringify({
          localId: folderName,
          brief: getCardBrief(),
          card: card,
        }),
      });
      if (!data.ok) {
        showMsg(data.error || '保存失败', false);
        return;
      }
      fillCardForm(data.card, data.localId, { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || '';
      await refreshCardList();
      showMsg('已写入 · ' + (data.folder || ('卡/' + data.localId)), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  function renderPull(job) {
    if (!job) return;
    var total = job.total || 0;
    var current = job.current || 0;
    var pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : (job.done ? 100 : 0);
    if (job.running && total === 0) pct = 8;
    $('pullBar').style.width = pct + '%';

    var failedPaths = job.failedPaths || [];
    var canRetry = !!(!job.running && (job.canRetryFailed || failedPaths.length > 0));
    var retryBtn = $('pullRetryBtn');
    var retryHint = $('pullRetryHint');
    if (retryBtn) retryBtn.hidden = !canRetry;
    if (retryHint) retryHint.hidden = !canRetry;

    var lines = [];
    if (job.message) lines.push(job.message);
    if (job.mode === 'retry') lines.push('模式: 只重拉失败文件');
    if (total) lines.push('进度 ' + current + '/' + total + ' · 成功 ' + (job.okCount || 0) + ' · 失败 ' + (job.failCount || 0));
    if (job.out) lines.push('输出目录: ' + job.out);
    if (job.error) lines.push('错误: ' + job.error);
    if (failedPaths.length && !job.running) {
      lines.push('失败文件 ' + failedPaths.length + ' 个（可点「重拉失败文件」）:');
      failedPaths.slice(0, 12).forEach(function (p) { lines.push('  - ' + p); });
      if (failedPaths.length > 12) lines.push('  … 另有 ' + (failedPaths.length - 12) + ' 个');
    }
    if (job.logs && job.logs.length) {
      lines.push('---');
      lines = lines.concat(job.logs.slice(-18));
    }
    $('pullLog').textContent = lines.join('\n') || '尚未开始';
  }

  function fillForm(status) {
    if (status.email && !$('email').value) $('email').value = status.email;
    if (status.characterId) $('characterId').value = status.characterId;
    if (status.projectPath) $('projectPath').value = status.projectPath;
    if (status.previewPort) $('previewPort').value = status.previewPort;
    var link = $('workbenchLink');
    if (status.workbenchUrl) {
      link.href = status.workbenchUrl;
      link.removeAttribute('aria-disabled');
    } else {
      link.href = '#';
    }
    var lamp = $('lamp');
    if (status.loggedIn) {
      lamp.className = 'lamp on';
      lamp.textContent = '已登录';
    } else {
      lamp.className = 'lamp off';
      lamp.textContent = '未登录';
    }
    $('statusBox').textContent = JSON.stringify({
      loggedIn: status.loggedIn,
      email: status.emailMasked || status.email,
      remainSec: status.remainSec,
      characterId: status.characterId,
      projectPath: status.projectPath || '(未设置)',
      previewPort: status.previewPort,
      workbenchUrl: status.workbenchUrl || '',
      kitRoot: status.kitRoot,
      hasPassword: status.hasPassword,
      error: status.error || '',
    }, null, 2);
    if (status.pull) renderPull(status.pull);
    if (status.preview) renderPreview(status.preview);
  }

  async function api(path, options) {
    var res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, options || {}));
    var data = await res.json().catch(function () { return { ok: false, error: '无效响应' }; });
    if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
    return data;
  }

  async function refresh() {
    var status = await api('/api/status');
    fillForm(status);
    return status;
  }

  function stopPullPoll() {
    if (pullTimer) {
      clearInterval(pullTimer);
      pullTimer = null;
    }
  }

  function startPullPoll() {
    stopPullPoll();
    pullTimer = setInterval(async function () {
      try {
        var data = await api('/api/pull');
        renderPull(data.job);
        if (data.job && !data.job.running && data.job.done) {
          stopPullPoll();
          setBusy(false);
          await refresh();
          if (data.job.error && !(data.job.result && data.job.result.ok)) {
            showMsg(data.job.error || data.job.message || '拉取结束（有失败）', false);
          } else {
            showMsg(data.job.message || '拉取完成', true);
          }
        }
      } catch (_) {}
    }, 800);
  }

  $('loginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    setBusy(true);
    showMsg('正在登录…', true);
    try {
      var data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          email: $('email').value.trim(),
          password: $('password').value,
          savePassword: $('savePassword').checked,
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          previewPort: $('previewPort').value,
        }),
      });
      if (data.status) fillForm(data.status);
      if (data.ok) {
        showMsg('登录成功 · 剩余约 ' + data.remainSec + 's', true);
        $('password').value = '';
      } else {
        showMsg(data.error || '登录失败', false);
      }
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('configForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    setBusy(true);
    try {
      var data = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          email: $('email').value.trim(),
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          previewPort: $('previewPort').value,
        }),
      });
      if (data.status) fillForm(data.status);
      showMsg(data.ok ? '配置已保存' : (data.error || '保存失败'), !!data.ok);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('logoutBtn').addEventListener('click', async function () {
    setBusy(true);
    try {
      var data = await api('/api/logout', { method: 'POST', body: '{}' });
      if (data.status) fillForm(data.status);
      showMsg('已清除本地登录 cookie', true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('pingBtn').addEventListener('click', async function () {
    setBusy(true);
    showMsg('正在连接编辑器…', true);
    try {
      var data = await api('/api/ping', { method: 'POST', body: '{}' });
      if (data.status) fillForm(data.status);
      if (data.ok) {
        showMsg('编辑器已连接 · gameId=' + data.gameId + ' · ' + (data.editorStatus || ''), true);
      } else {
        showMsg(data.error || '连接失败', false);
      }
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('previewStartBtn').addEventListener('click', async function () {
    setBusy(true);
    showMsg('正在启动本地预览…', true);
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          email: $('email').value.trim(),
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          previewPort: $('previewPort').value,
        }),
      });
      var data = await api('/api/preview/start', {
        method: 'POST',
        body: JSON.stringify({
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          previewPort: $('previewPort').value,
        }),
      });
      if (data.status) fillForm(data.status);
      else if (data.preview) renderPreview(data.preview);
      if (data.ok) {
        var url = data.url || (data.preview && data.preview.url) || '';
        showMsg('预览已启动 · ' + url, true);
        if (url) {
          $('previewLink').href = url;
          $('previewFrame').dataset.url = '';
          renderPreview(Object.assign({}, data.preview || {}, { running: true, url: url }));
          switchPanel('bridge');
          startBridgePoll();
        }
      } else {
        showMsg(data.error || '预览启动失败', false);
      }
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('previewStopBtn').addEventListener('click', async function () {
    setBusy(true);
    try {
      var data = await api('/api/preview/stop', { method: 'POST', body: '{}' });
      if (data.status) fillForm(data.status);
      else if (data.preview) renderPreview(data.preview);
      $('previewFrame').src = 'about:blank';
      $('previewFrame').dataset.url = '';
      setStageLive(false);
      stopBridgePoll();
      renderBridge(null, { running: false });
      showMsg('预览已停止', true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  });

  $('bridgeRefreshBtn').addEventListener('click', async function () {
    setBusy(true);
    try {
      var data = await refreshBridge();
      if (data && data.ok) showMsg('桥接状态已刷新', true);
      else showMsg((data && data.error) || '预览未启动', false);
    } finally {
      setBusy(false);
    }
  });

  $('publishBtn').addEventListener('click', function () {
    runPublish({ direct: false });
  });

  function bindCollapse(id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function () {
      setSidebarCollapsed(true);
    });
  }
  bindCollapse('sidebarCollapseBtn');
  bindCollapse('sidebarCollapseBtn2');

  function applyFabPos(left, top) {
    var dock = $('fabDock');
    if (!dock) return;
    var pad = 8;
    var rect = dock.getBoundingClientRect();
    var w = rect.width || 168;
    var h = rect.height || 168;
    var maxL = Math.max(pad, window.innerWidth - w - pad);
    var maxT = Math.max(pad, window.innerHeight - h - pad);
    var l = Math.min(maxL, Math.max(pad, left));
    var t = Math.min(maxT, Math.max(pad, top));
    dock.style.left = l + 'px';
    dock.style.top = t + 'px';
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    return { left: l, top: t };
  }

  function restoreFabPos() {
    try {
      var raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) return;
      var pos = JSON.parse(raw);
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        applyFabPos(pos.left, pos.top);
      }
    } catch (_) {}
  }

  function bindFabHover() {
    var dock = $('fabDock');
    if (!dock) return;
    var leaveTimer = null;
    function openFab() {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      dock.classList.add('is-open');
    }
    function scheduleClose() {
      if (leaveTimer) clearTimeout(leaveTimer);
      // 稍延迟再收起，方便鼠标滑到卫星键
      leaveTimer = setTimeout(function () {
        dock.classList.remove('is-open');
        leaveTimer = null;
      }, 160);
    }
    dock.addEventListener('pointerenter', openFab);
    dock.addEventListener('pointerleave', scheduleClose);
    // 触屏：点中心附近也可保持展开一会儿
    dock.addEventListener('pointerdown', function () {
      openFab();
    });
  }

  function bindFabDrag() {
    var dock = $('fabDock');
    var handle = $('fabPublish');
    if (!dock || !handle) return;

    var dragging = false;
    var moved = false;
    var startX = 0;
    var startY = 0;
    var origL = 0;
    var origT = 0;

    function onMove(clientX, clientY) {
      if (!dragging) return;
      var dx = clientX - startX;
      var dy = clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      applyFabPos(origL + dx, origT + dy);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('is-dragging');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      if (moved) {
        var rect = dock.getBoundingClientRect();
        var pos = applyFabPos(rect.left, rect.top);
        try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(pos)); } catch (_) {}
      }
    }

    function onPointerMove(ev) {
      onMove(ev.clientX, ev.clientY);
    }

    function onPointerUp() {
      onUp();
    }

    handle.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      var rect = dock.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      origL = rect.left;
      origT = rect.top;
      dock.classList.add('is-dragging');
      try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      ev.preventDefault();
    });

    handle.addEventListener('click', function (ev) {
      if (moved) {
        ev.preventDefault();
        ev.stopPropagation();
        moved = false;
        return;
      }
      runPublish({ direct: true });
    });
  }

  bindFabHover();
  bindFabDrag();
  // 展开侧栏时不必清位置；下次收起继续用
  var _setCollapsed = setSidebarCollapsed;
  setSidebarCollapsed = function (collapsed) {
    _setCollapsed(collapsed);
    if (collapsed) {
      // 下一帧再恢复，确保尺寸已渲染
      requestAnimationFrame(restoreFabPos);
    }
  };

  $('previewReloadBtn').addEventListener('click', function () {
    reloadPreviewOnly();
  });

  var fabExpand = $('fabExpand');
  if (fabExpand) {
    fabExpand.addEventListener('click', function () {
      setSidebarCollapsed(false);
    });
  }

  var fabReload = $('fabReload');
  if (fabReload) {
    fabReload.addEventListener('click', function () {
      reloadPreviewOnly();
    });
  }

  function setFabSyncState(mode, text) {
    var btn = $('fabSync');
    if (!btn) return;
    btn.classList.remove('is-run', 'is-ok', 'is-err');
    if (mode) btn.classList.add('is-' + mode);
    if (text) btn.textContent = text;
    else if (mode === 'run') btn.textContent = '…';
    else if (mode === 'ok') btn.textContent = '完成';
    else if (mode === 'err') btn.textContent = '失败';
    else btn.textContent = '同步';
  }

  var syncTimer = null;

  function stopSyncPoll() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function applySyncJob(job) {
    if (!job) return;
    if (job.running) {
      var short = job.total ? (job.current + '/' + job.total) : '…';
      setFabSyncState('run', short.length > 6 ? '…' : short);
      var prog = job.total
        ? ('同步 ' + job.current + '/' + job.total)
        : (job.message || '同步中…');
      showMsg(prog, true);
      return;
    }
    if (job.done) {
      stopSyncPoll();
      setBusy(false);
      if (job.error || job.failCount) {
        setFabSyncState('err', '失败');
        showMsg(job.error || job.message || '同步失败', false);
        setTimeout(function () { setFabSyncState('', '同步'); }, 2200);
      } else {
        setFabSyncState('ok', '完成');
        showMsg(job.message || ('已同步 ' + (job.okCount || 0) + ' 个文件'), true);
        setTimeout(function () { setFabSyncState('', '同步'); }, 1600);
      }
    }
  }

  function startSyncPoll() {
    stopSyncPoll();
    var tick = async function () {
      try {
        var data = await api('/api/sync');
        applySyncJob(data.job);
      } catch (_) {}
    };
    tick();
    syncTimer = setInterval(tick, 1000);
  }

  async function runFabSync() {
    setBusy(true, { keepEnabled: { fabSync: true, fabExpand: true, fabReload: true } });
    setFabSyncState('run', '…');
    showMsg('正在启动同步…', true);
    try {
      var data = await api('/api/sync', {
        method: 'POST',
        body: JSON.stringify({
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          message: 'sync from local console',
        }),
      });
      if (!data.ok) {
        setBusy(false);
        setFabSyncState('err', '失败');
        showMsg(data.error || '同步失败', false);
        setTimeout(function () { setFabSyncState('', '同步'); }, 2200);
        return;
      }
      applySyncJob(data.job);
      startSyncPoll();
    } catch (e) {
      setBusy(false);
      setFabSyncState('err', '失败');
      showMsg(String(e.message || e), false);
      setTimeout(function () { setFabSyncState('', '同步'); }, 2200);
    }
  }

  var fabSync = $('fabSync');
  if (fabSync) {
    fabSync.addEventListener('click', function () {
      runFabSync();
    });
  }

  async function startPullRequest(path, busyText) {
    setBusy(true);
    showMsg(busyText, true);
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          email: $('email').value.trim(),
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
          previewPort: $('previewPort').value,
        }),
      });
      var data = await api(path, {
        method: 'POST',
        body: JSON.stringify({
          characterId: $('characterId').value,
          projectPath: $('projectPath').value.trim(),
        }),
      });
      if (data.job) renderPull(data.job);
      if (data.status) fillForm(data.status);
      if (data.ok) {
        showMsg(busyText.replace('正在启动', '进行中').replace('正在', '') || '进行中…', true);
        startPullPoll();
      } else {
        showMsg(data.error || '无法开始', false);
        setBusy(false);
      }
    } catch (e) {
      showMsg(String(e.message || e), false);
      setBusy(false);
    }
  }

  $('pullBtn').addEventListener('click', async function () {
    if (!confirm('将从云端容器拉取完整项目到本地路径（覆盖同名文件）。继续？')) return;
    startPullRequest('/api/pull', '正在启动全量拉取…');
  });

  $('pullRetryBtn').addEventListener('click', async function () {
    if (!confirm('只重新下载上次失败的文件（不全量拉取）。继续？')) return;
    startPullRequest('/api/pull/retry', '正在重试失败文件…');
  });

  document.querySelectorAll('.mode-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchConsoleMode(btn.getAttribute('data-mode'));
    });
  });
  document.querySelectorAll('.menu-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchPanel(btn.getAttribute('data-panel'));
    });
  });

  ['cardName', 'cardDescription', 'cardPersonality', 'cardScenario', 'cardFirstMes', 'cardTags', 'cardNotes', 'cardBriefMain', 'cardBrief', 'cardSystemPrompt', 'cardCreator', 'cardVersion', 'cardBookName', 'cardSuggestedReplies', 'cardChatHistory'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', updateCardPreview);
  });
  updateCardTokenStats();

  document.querySelectorAll('.card-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-card-tab');
      document.querySelectorAll('.card-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.card-tab-panel').forEach(function (panel) {
        var match = panel.getAttribute('data-card-panel') === name;
        panel.classList.toggle('active', match);
        if (match) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      });
    });
  });

  if ($('cardWbAddBtn')) {
    $('cardWbAddBtn').addEventListener('click', function () {
      var list = collectWorldBookEntries();
      list.push({
        id: list.length + 1,
        name: '条目' + (list.length + 1),
        keys: [],
        content: '',
        enabled: true,
        constant: false,
        insertion_order: list.length,
        position: 4,
        priority: 100,
        extensions: {},
      });
      renderWorldBookEntries(list);
      updateCardPreview();
    });
  }

  if ($('cardAvatarUrl')) {
    $('cardAvatarUrl').addEventListener('input', function () {
      updateAvatarPreview($('cardAvatarUrl').value);
    });
  }

  function currentCardLocalId() {
    return currentCardId
      || ($('cardFolderName') && $('cardFolderName').value.trim())
      || ($('cardName') && $('cardName').value.trim())
      || '';
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsDataURL(file);
    });
  }

  async function importAvatarFile(file) {
    var localId = currentCardLocalId();
    if (!localId) throw new Error('请先创建/打开卡夹');
    if (!/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
    if (file.size > 12 * 1024 * 1024) throw new Error('图片太大（上限 12MB）');
    var dataUrl = await readFileAsDataUrl(file);
    var data = await api('/api/card/avatar', {
      method: 'POST',
      body: JSON.stringify({
        localId: localId,
        filename: file.name || 'avatar.png',
        mime: file.type || '',
        dataBase64: dataUrl,
      }),
    });
    if (!data.ok) throw new Error(data.error || '导入失败');
    fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
    currentCardFolder = data.folder || data.path || currentCardFolder;
    await refreshCardList();
    showMsg('头像已保存 · ' + (data.rel || 'assets/avatar'), true);
  }

  async function importImageFiles(fileList) {
    var localId = currentCardLocalId();
    if (!localId) throw new Error('请先创建/打开卡夹');
    var files = Array.isArray(fileList) ? fileList.slice() : Array.prototype.slice.call(fileList || []);
    if (!files.length) throw new Error('未选择图片');
    var last = null;
    var imported = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file) continue;
      // 部分浏览器 type 为空，按扩展名放行
      var okType = /^image\//.test(file.type || '');
      var okExt = /\.(png|jpe?g|webp|gif)$/i.test(file.name || '');
      if (!okType && !okExt) continue;
      if (file.size > 12 * 1024 * 1024) throw new Error(file.name + ' 超过 12MB');
      showMsg('正在导入立绘 ' + (imported + 1) + '/' + files.length + ' · ' + (file.name || ''), true);
      var dataUrl = await readFileAsDataUrl(file);
      last = await api('/api/card/image', {
        method: 'POST',
        body: JSON.stringify({
          localId: localId,
          filename: file.name || ('image_' + i + '.png'),
          mime: file.type || '',
          name: (file.name || '').replace(/\.[^.]+$/, ''),
          dataBase64: dataUrl,
        }),
      });
      if (!last.ok) throw new Error(last.error || '立绘导入失败');
      imported += 1;
    }
    if (!last || !imported) throw new Error('没有可导入的图片（请选 png/jpg/webp/gif）');
    fillCardForm(last.card, last.localId || localId, { mtime: last.mtime || 0 });
    currentCardFolder = last.folder || last.path || currentCardFolder;
    await refreshCardList();
    showMsg('立绘已导入 ' + imported + ' 张 · 当前共 ' + ((last.card.data && last.card.data.image_info) || []).length + ' 张', true);
  }

  async function removeCardImage(index) {
    var localId = currentCardLocalId();
    if (!localId) {
      showMsg('请先打开卡夹', false);
      return;
    }
    setBusy(true);
    try {
      var data = await api('/api/card/image', {
        method: 'POST',
        body: JSON.stringify({ localId: localId, action: 'remove', index: index }),
      });
      if (!data.ok) {
        showMsg(data.error || '删除失败', false);
        return;
      }
      fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
      showMsg('已删除立绘 #' + (index + 1), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function refreshVoiceCatalog() {
    setBusy(true);
    if ($('cardVoiceMsg')) $('cardVoiceMsg').textContent = '正在拉取平台音色库…';
    try {
      var data = await api('/api/card/voices');
      if (!data.ok) {
        if ($('cardVoiceMsg')) $('cardVoiceMsg').textContent = data.error || '拉取失败（需登录）';
        showMsg(data.error || '音色库拉取失败', false);
        return;
      }
      voiceCatalog = { public: data.public || [], mine: data.mine || [] };
      if ($('cardVoiceMsg')) {
        $('cardVoiceMsg').textContent =
          '公共 ' + voiceCatalog.public.length + ' · 我的 ' + voiceCatalog.mine.length +
          '（显示前 80 条筛选结果）';
      }
      renderVoiceList();
      showMsg('音色库已刷新', true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function selectVoice(v) {
    var localId = currentCardLocalId();
    if (!localId) {
      showMsg('请先打开卡夹再选音色', false);
      return;
    }
    setBusy(true);
    try {
      var data = await api('/api/card/voice', {
        method: 'POST',
        body: JSON.stringify({
          localId: localId,
          voice: {
            id: v.id,
            name: v.name,
            avatar_url: v.avatarUrl || null,
            preview_url: v.previewUrl || null,
            gender: v.gender || '',
          },
        }),
      });
      if (!data.ok) {
        showMsg(data.error || '选用失败', false);
        return;
      }
      fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
      showMsg('已选用音色 · ' + (v.name || v.id), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  if ($('cardAvatarFile')) {
    $('cardAvatarFile').addEventListener('change', async function () {
      var file = $('cardAvatarFile').files && $('cardAvatarFile').files[0];
      $('cardAvatarFile').value = '';
      if (!file) return;
      setBusy(true);
      showMsg('正在导入本地头像…', true);
      try {
        await importAvatarFile(file);
      } catch (e) {
        showMsg(String(e.message || e), false);
      } finally {
        setBusy(false);
      }
    });
  }

  if ($('cardImageFile')) {
    $('cardImageFile').addEventListener('change', async function () {
      // 必须先拷成数组：清空 value 会让 FileList 立刻变空
      var files = Array.prototype.slice.call(($('cardImageFile').files) || []);
      $('cardImageFile').value = '';
      if (!files.length) return;
      setBusy(true);
      showMsg('正在导入立绘 ' + files.length + ' 张…', true);
      try {
        await importImageFiles(files);
      } catch (e) {
        showMsg(String(e.message || e), false);
      } finally {
        setBusy(false);
      }
    });
  }

  if ($('cardVoiceRefreshBtn')) {
    $('cardVoiceRefreshBtn').addEventListener('click', refreshVoiceCatalog);
  }
  if ($('cardVoiceClearBtn')) {
    $('cardVoiceClearBtn').addEventListener('click', async function () {
      var localId = currentCardLocalId();
      if (!localId) {
        showMsg('请先打开卡夹', false);
        return;
      }
      setBusy(true);
      try {
        var data = await api('/api/card/voice', {
          method: 'POST',
          body: JSON.stringify({ localId: localId, clear: true }),
        });
        if (!data.ok) {
          showMsg(data.error || '清除失败', false);
          return;
        }
        fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
        showMsg('已清除音色', true);
      } catch (e) {
        showMsg(String(e.message || e), false);
      } finally {
        setBusy(false);
      }
    });
  }
  if ($('cardVoiceSearch')) {
    $('cardVoiceSearch').addEventListener('input', renderVoiceList);
  }
  if ($('cardVoiceGender')) {
    $('cardVoiceGender').addEventListener('change', renderVoiceList);
  }

  function getCardBrief() {
    var main = ($('cardBriefMain') && $('cardBriefMain').value) || '';
    var side = ($('cardBrief') && $('cardBrief').value) || '';
    return (main || side).trim();
  }

  async function runCardAiWrite() {
    var name = ($('cardFolderName') && $('cardFolderName').value.trim())
      || ($('cardName') && $('cardName').value.trim())
      || '';
    var brief = getCardBrief();
    if (!name && brief.length < 2) {
      showMsg('请先填卡名（或创意简述）', false);
      setCardMsg('请先填卡名（或创意简述）', false);
      return;
    }
    if ($('cardBrief')) $('cardBrief').value = brief;
    if ($('cardBriefMain')) $('cardBriefMain').value = brief;
    setBusy(true);
    showMsg('正在创建本地卡夹…', true);
    setCardMsg('正在创建本地卡夹…', true);
    try {
      var data = await api('/api/card/ai', {
        method: 'POST',
        body: JSON.stringify({ name: name, brief: brief }),
      });
      if (!data.ok) {
        showMsg(data.error || '创建卡夹失败', false);
        setCardMsg(data.error || '创建卡夹失败', false);
        return;
      }
      fillCardForm(data.card, data.localId || '', { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || '';
      if ($('cardFolderName')) $('cardFolderName').value = data.localId || name;
      setStageMode('card');
      setCardFullscreen(true);
      await refreshCardList();
      // 创建并监听后：自动复制「写这张卡」的开聊提示词
      var copied = await runCopyChatPrompt({
        name: data.localId || name,
        brief: brief,
        auto: true,
      });
      if (!copied) {
        var fallback = '已监听 · ' + (data.localId || currentCardFolder)
          + '（开聊提示词未复制成功，可点「复制开聊提示词」）';
        showMsg(fallback, true);
        setCardMsg(fallback, true);
      }
    } catch (e) {
      showMsg(String(e.message || e), false);
      setCardMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function runCardNew() {
    var name = window.prompt('请输入新卡名称（必填）', '');
    if (name === null) return; // 取消
    name = String(name || '').trim();
    if (!name) {
      showMsg('必须填写卡名才能新建', false);
      return;
    }
    setBusy(true);
    try {
      // 空白新建：用弹窗卡名，简述清空，不沿用上一张
      if ($('cardBrief')) $('cardBrief').value = '';
      if ($('cardBriefMain')) $('cardBriefMain').value = '';
      var data = await api('/api/card/new', {
        method: 'POST',
        body: JSON.stringify({ name: name, brief: '', blank: true }),
      });
      if (!data.ok) {
        showMsg(data.error || '新建失败', false);
        return;
      }
      fillCardForm(data.card, data.localId, { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || '';
      if ($('cardName')) $('cardName').value = name;
      if ($('cardFolderName')) $('cardFolderName').value = data.localId || name;
      if ($('cardBrief')) $('cardBrief').value = '';
      if ($('cardBriefMain')) $('cardBriefMain').value = '';
      setStageMode('card');
      setCardFullscreen(true);
      await refreshCardList();
      showMsg('已新建空白卡夹 · ' + (data.folder || data.localId), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (_) {
        /* fall through to execCommand */
      }
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
    if (!ok) throw new Error('浏览器拒绝写入剪贴板，请手动复制');
  }

  function resolveChatPromptContext(opts) {
    opts = opts || {};
    var name = (opts.name || '').trim()
      || currentCardId
      || ($('cardFolderName') && $('cardFolderName').value.trim())
      || ($('cardName') && $('cardName').value.trim())
      || '';
    var brief = (opts.brief != null ? String(opts.brief) : getCardBrief()).trim();
    if (!brief && currentCard && currentCard._meta && currentCard._meta.brief) {
      brief = String(currentCard._meta.brief || '').trim();
    }
    return { name: name, brief: brief };
  }

  async function runCopyChatPrompt(opts) {
    opts = opts || {};
    var ctx = resolveChatPromptContext(opts);
    var name = ctx.name;
    var brief = ctx.brief;
    var manageBusy = !opts.auto;
    if (manageBusy) setBusy(true);
    setCardMsg('正在生成「' + (name || '未命名') + '」开聊提示词…', true);
    try {
      if (!name) {
        var needName = '请先填写卡名，或点「创建卡夹并监听」后再复制';
        setCardMsg(needName, false);
        showMsg(needName, false);
        return false;
      }
      var q = '/api/card/chat-prompt?name=' + encodeURIComponent(name)
        + '&brief=' + encodeURIComponent(brief);
      var data = await api(q);
      if (!data.ok || !data.text) {
        var err = data.error || '读取开聊提示词失败';
        if (err === '无效响应' || /HTTP 404/i.test(err)) {
          err = '开聊提示词接口不可用，请重启控制台（python console.py）后重试';
        }
        setCardMsg(err, false);
        showMsg(err, false);
        return false;
      }
      await copyTextToClipboard(data.text);
      var hint = opts.auto
        ? ('已创建并监听「' + name + '」，开聊提示词已复制 · 粘贴到新对话即可开始写这张卡')
        : ('已复制开聊提示词 · 创作「' + name + '」');
      if (!opts.auto && data.filledBrief) hint += '（含简述）';
      setCardMsg(hint, true);
      showMsg(hint, true);
      return true;
    } catch (e) {
      var msg = String(e.message || e);
      setCardMsg(msg, false);
      showMsg(msg, false);
      return false;
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  if ($('cardAiBtn')) $('cardAiBtn').addEventListener('click', runCardAiWrite);
  if ($('cardCopyPromptBtn')) $('cardCopyPromptBtn').addEventListener('click', function () { runCopyChatPrompt(); });
  if ($('cardNewBtn2')) $('cardNewBtn2').addEventListener('click', runCardNew);
  if ($('cardMenuBtn')) {
    $('cardMenuBtn').addEventListener('click', function () {
      setSidebarCollapsed(false);
    });
  }
  if ($('cardBrief') && $('cardBriefMain')) {
    $('cardBrief').addEventListener('input', function () {
      $('cardBriefMain').value = $('cardBrief').value;
    });
    $('cardBriefMain').addEventListener('input', function () {
      $('cardBrief').value = $('cardBriefMain').value;
    });
  }

  if ($('cardSaveBtn')) {
    $('cardSaveBtn').addEventListener('click', function () { saveCurrentCard(); });
  }
  if ($('cardExportPngBtn')) {
    $('cardExportPngBtn').addEventListener('click', async function () {
      var localId = currentCardLocalId();
      if (!localId) {
        showMsg('请先打开或保存一张本地卡', false);
        return;
      }
      setBusy(true);
      showMsg('正在打包 PNG 卡（封面=第一张图）…', true);
      try {
        // 先落盘，保证导出内容最新
        await saveCurrentCard();
        localId = currentCardLocalId() || localId;
        var a = document.createElement('a');
        a.href = '/api/card/export-png?id=' + encodeURIComponent(localId) + '&t=' + Date.now();
        a.download = localId + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showMsg('已导出 PNG 卡 · 卡/' + localId + '/export/', true);
      } catch (e) {
        showMsg(String(e.message || e), false);
      } finally {
        setBusy(false);
      }
    });
  }

  function cardLooksEmpty(card) {
    if (!card || !card.data) return true;
    var d = card.data;
    var text = [
      d.description, d.personality, d.scenario, d.system_prompt, d.first_mes, d.creator_notes
    ].join('');
    var hasImg = !!(d.avatar_url || (d.image_info && d.image_info.length));
    return text.replace(/\s+/g, '').length < 20 && !hasImg;
  }

  async function saveToCloud(asDraft) {
    var localId = currentCardLocalId();
    if (!localId) {
      showMsg('请先打开/创建卡夹', false);
      return;
    }
    var card = collectCardFromForm();
    if (cardLooksEmpty(card)) {
      showMsg('表单几乎为空，已取消，避免把本地卡写空。请先「重载当前」或打开卡夹。', false);
      return;
    }
    setBusy(true);
    showMsg(asDraft ? '正在保存云端草稿…' : '正在保存到云端（含图片上传）…', true);
    try {
      var savedLocal = await api('/api/card/save', {
        method: 'POST',
        body: JSON.stringify({
          localId: localId,
          brief: getCardBrief(),
          card: card,
        }),
      });
      if (!savedLocal.ok) {
        showMsg(savedLocal.error || '本地保存失败', false);
        return;
      }
      fillCardForm(savedLocal.card, savedLocal.localId || localId, { mtime: savedLocal.mtime || 0 });
      localId = savedLocal.localId || localId;

      var data = await api('/api/card/publish', {
        method: 'POST',
        body: JSON.stringify({
          localId: localId,
          draft: !!asDraft,
          brief: getCardBrief(),
        }),
      });
      if (!data.ok) {
        showMsg(data.error || (asDraft ? '云端草稿失败' : '云端保存失败'), false);
        return;
      }
      fillCardForm(data.card, data.localId || localId, { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || currentCardFolder;
      await refreshCardList();
      if (asDraft || data.mode === 'draft') {
        showMsg('草稿已保存 · id=' + (data.cloudId || ''), true);
      } else {
        showMsg(
          '已保存 · #' + data.cloudId + '（上架请去官网）' +
            (data.characterUrl ? (' · ' + data.characterUrl) : ''),
          true
        );
      }
      updatePlayGate();
      refreshCloudCardList(false);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  if ($('cardPublishBtn')) $('cardPublishBtn').addEventListener('click', function () { saveToCloud(false); });
  if ($('cardDraftBtn')) $('cardDraftBtn').addEventListener('click', function () { saveToCloud(true); });

  function currentCloudCardId() {
    if (!currentCard) return 0;
    var d = currentCard.data || {};
    var meta = currentCard._meta || {};
    if (meta.source === 'cloud-draft' || meta.isDraft) return 0;
    var id = parseInt(d.db_id || meta.cloudId || 0, 10);
    return id > 0 ? id : 0;
  }

  function updatePlayGate() {
    var btn = $('cardPlayBtn');
    if (!btn) return;
    var cid = currentCloudCardId();
    btn.disabled = !cid || cardPlayMode;
    btn.title = cid
      ? ('试玩云端卡 #' + cid)
      : '需先「保存到云端」得到正式卡 ID（草稿不可试玩）';
  }

  function setCardPlayMode(on) {
    cardPlayMode = !!on;
    var stage = $('cardStage');
    if (stage) stage.classList.toggle('is-play', cardPlayMode);
    if ($('cardForm')) {
      $('cardForm').hidden = cardPlayMode;
      // 双保险：退出试玩时清掉可能残留的内联样式
      if (!cardPlayMode) $('cardForm').style.removeProperty('display');
    }
    if ($('cardPlayPanel')) $('cardPlayPanel').hidden = !cardPlayMode;
    // 试玩时顶部只保留菜单 + 返回写卡；写卡界面绝不显示返回写卡
    ['cardNewBtn2', 'cardSaveBtn', 'cardExportPngBtn', 'cardPublishBtn', 'cardDraftBtn', 'cardPlayBtn', 'cardReloadBtn'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (cardPlayMode) el.setAttribute('hidden', '');
      else el.removeAttribute('hidden');
    });
    if ($('cardPlayBackBtn')) {
      if (cardPlayMode) $('cardPlayBackBtn').removeAttribute('hidden');
      else $('cardPlayBackBtn').setAttribute('hidden', '');
    }
    if ($('cardStageTitle')) $('cardStageTitle').textContent = cardPlayMode ? '角色卡试玩' : '角色卡编辑';
    updatePlayGate();
  }

  function exitCardPlay(opts) {
    opts = opts || {};
    if (!opts.keepSession) {
      playState.chatId = '';
      playState.messages = [];
      playState.sending = false;
      playState.charName = '';
    }
    if (!opts.keepPanel) setCardPlayMode(false);
    if ($('playStatus')) $('playStatus').textContent = playState.chatId ? ('会话 ' + playState.chatId.slice(0, 8) + '…') : '未开始';
  }

  function formatContextLabel(maxContext) {
    var n = Number(maxContext) || 0;
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n || '');
  }

  /** 官网：模型按 series 分组，上下文长度 = 同组 contexts[] 不同 internalName */
  function parseModelGroups(modelsPayload) {
    var root = modelsPayload || {};
    var cats = root.categories || [];
    var groups = [];
    var seen = {};
    if (Array.isArray(cats)) {
      cats.forEach(function (c) {
        var catName = (c && (c.name || c.title || c.key)) || '';
        var list = (c && c.modelGroups) || [];
        if (!Array.isArray(list)) return;
        list.forEach(function (g, idx) {
          var contexts = Array.isArray(g.contexts) ? g.contexts.filter(function (x) {
            return x && (x.internalName || x.id);
          }) : [];
          if (!contexts.length) return;
          var series = String(g.seriesKey || g.displayName || contexts[0].displayName || ('model-' + idx));
          var key = String(g.categoryKey || catName || 'cat') + '::' + series;
          if (seen[key]) return;
          seen[key] = 1;
          groups.push({
            key: key,
            seriesKey: series,
            category: catName,
            thinkingSupported: !!g.thinkingSupported,
            contexts: contexts.map(function (ctx) {
              return {
                id: String(ctx.internalName || ctx.id),
                label: formatContextLabel(ctx.maxContext) || String(ctx.displayName || ctx.internalName),
                maxContext: Number(ctx.maxContext) || 0,
                displayName: ctx.displayName || '',
                isRecommended: !!ctx.isRecommended,
              };
            }),
          });
        });
      });
    }
    return { groups: groups, defaultModel: root.defaultModel || '' };
  }

  function findPlayGroup(key) {
    var list = playState.modelGroups || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i];
    }
    return null;
  }

  function findGroupByModelId(modelId) {
    var id = String(modelId || '');
    var list = playState.modelGroups || [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      for (var j = 0; j < g.contexts.length; j++) {
        if (g.contexts[j].id === id) return g;
      }
    }
    return null;
  }

  function pickContextForGroup(group, preferId) {
    if (!group || !group.contexts.length) return null;
    if (preferId) {
      for (var i = 0; i < group.contexts.length; i++) {
        if (group.contexts[i].id === preferId) return group.contexts[i];
      }
    }
    // 官网默认偏 16K（推荐）；否则取最小上下文
    var rec = null;
    var smallest = group.contexts[0];
    group.contexts.forEach(function (c) {
      if (c.isRecommended && (!rec || c.maxContext < rec.maxContext)) rec = c;
      if (c.maxContext && c.maxContext < (smallest.maxContext || Infinity)) smallest = c;
    });
    return rec || smallest || group.contexts[0];
  }

  function renderPlayContextPills() {
    var wrap = $('playContextLength');
    if (!wrap) return;
    wrap.innerHTML = '';
    var group = findPlayGroup(playState.selectedGroupKey);
    if (!group) {
      wrap.textContent = '—';
      return;
    }
    group.contexts.forEach(function (ctx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'play-context-pill' + (ctx.id === playState.selectedModel ? ' is-active' : '');
      btn.textContent = ctx.label;
      btn.title = ctx.displayName || ctx.id;
      btn.addEventListener('click', function () {
        playState.selectedModel = ctx.id;
        renderPlayContextPills();
        if (playState.chatId) {
          patchPlaySettings({ model: ctx.id }).catch(function () {});
        }
      });
      wrap.appendChild(btn);
    });
  }

  function populatePlayModelSelect(parsed) {
    var sel = $('playModelSelect');
    if (!sel) return;
    playState.modelGroups = parsed.groups || [];
    playState.defaultModel = parsed.defaultModel || '';
    sel.innerHTML = '';
    if (!playState.modelGroups.length) {
      sel.innerHTML = '<option value="">（无可用模型）</option>';
      playState.selectedGroupKey = '';
      playState.selectedModel = '';
      renderPlayContextPills();
      return;
    }
    playState.modelGroups.forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g.key;
      opt.textContent = g.category ? (g.seriesKey + ' · ' + g.category) : g.seriesKey;
      sel.appendChild(opt);
    });
    var group = findGroupByModelId(playState.selectedModel || playState.defaultModel)
      || findPlayGroup(playState.selectedGroupKey)
      || playState.modelGroups[0];
    playState.selectedGroupKey = group.key;
    sel.value = group.key;
    var ctx = pickContextForGroup(group, playState.selectedModel || playState.defaultModel);
    playState.selectedModel = ctx ? ctx.id : '';
    renderPlayContextPills();
  }

  function onPlayModelGroupChange() {
    var sel = $('playModelSelect');
    if (!sel) return;
    var group = findPlayGroup(sel.value);
    if (!group) return;
    playState.selectedGroupKey = group.key;
    // 切换系列时尽量保留同档上下文（如仍选 16K）
    var prev = null;
    var old = findGroupByModelId(playState.selectedModel);
    if (old) {
      for (var i = 0; i < old.contexts.length; i++) {
        if (old.contexts[i].id === playState.selectedModel) {
          prev = old.contexts[i].maxContext;
          break;
        }
      }
    }
    var matched = null;
    if (prev) {
      for (var j = 0; j < group.contexts.length; j++) {
        if (group.contexts[j].maxContext === prev) {
          matched = group.contexts[j];
          break;
        }
      }
    }
    var ctx = matched || pickContextForGroup(group, null);
    playState.selectedModel = ctx ? ctx.id : '';
    renderPlayContextPills();
    if (playState.chatId && playState.selectedModel) {
      patchPlaySettings({ model: playState.selectedModel }).catch(function () {});
    }
  }

  async function loadPlayControls() {
    if ($('playStatus')) $('playStatus').textContent = '加载模型/预设…';
    try {
      var modelsRes = await api('/api/card/play/models');
      if (modelsRes.ok) {
        populatePlayModelSelect(parseModelGroups(modelsRes.models || {}));
        playState.modelsLoaded = true;
      }
    } catch (e) {
      if ($('playModelSelect')) {
        $('playModelSelect').innerHTML = '<option value="">模型加载失败</option>';
      }
    }
    try {
      var pre = await api('/api/card/play/presets');
      var list = (pre && pre.presets) || [];
      var active = (pre && pre.activePresetIds) || [];
      playState.presetCatalog = Array.isArray(list) ? list.slice() : [];
      if (!playState.selectedPresetIds.length && Array.isArray(active) && active.length) {
        playState.selectedPresetIds = active.map(String);
      }
      playState.presetsLoaded = true;
      // 官网规则：{{user}} = 登录用户 fullName（非邮箱、非手动填）
      var dn = (pre && pre.displayName) || '';
      if (dn) playState.userName = String(dn).trim();
      updatePlayPresetBtn();
      updatePlayUserLabel();
      if (cardPlayMode) renderPlayMessages();
    } catch (_) {}
    if ($('playStatus')) {
      $('playStatus').textContent = playState.chatId
        ? ('会话 ' + String(playState.chatId).slice(0, 8) + '…')
        : '就绪';
    }
  }

  function selectedPresetIds() {
    return (playState.selectedPresetIds || []).slice();
  }

  function updatePlayPresetBtn() {
    var btn = $('playPresetBtn');
    if (!btn) return;
    var n = selectedPresetIds().length;
    btn.textContent = n ? ('预设 · ' + n) : '预设';
  }

  function updatePlayUserLabel() {
    var el = $('playUserLabel');
    if (!el) return;
    var name = playUserName();
    el.textContent = '{{user}} · ' + name;
    el.title = '开场白与显示中的 {{user}} = 登录用户名（' + name + '）';
  }

  function openPlayPresetModal() {
    var modal = $('playPresetModal');
    var list = $('playPresetList');
    if (!modal || !list) return;
    list.innerHTML = '';
    var catalog = playState.presetCatalog || [];
    var selected = {};
    selectedPresetIds().forEach(function (id) { selected[id] = 1; });
    if (!catalog.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '账号暂无预设';
      list.appendChild(empty);
    } else {
      catalog.forEach(function (p) {
        var id = String(p.id || '');
        if (!id) return;
        var label = document.createElement('label');
        label.className = 'play-preset-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = id;
        cb.checked = !!selected[id];
        var body = document.createElement('span');
        var name = document.createElement('span');
        name.className = 'play-preset-name';
        name.textContent = p.name || p.title || id;
        body.appendChild(name);
        var desc = p.description || p.desc || '';
        if (desc) {
          var d = document.createElement('span');
          d.className = 'play-preset-desc';
          d.textContent = String(desc).slice(0, 80);
          body.appendChild(d);
        }
        label.appendChild(cb);
        label.appendChild(body);
        list.appendChild(label);
      });
    }
    modal.hidden = false;
  }

  function closePlayPresetModal() {
    if ($('playPresetModal')) $('playPresetModal').hidden = true;
  }

  function applyPlayPresetModal() {
    var list = $('playPresetList');
    if (!list) return;
    var ids = [];
    list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (cb.checked && cb.value) ids.push(cb.value);
    });
    playState.selectedPresetIds = ids;
    updatePlayPresetBtn();
    closePlayPresetModal();
  }

  function playCharName() {
    return (
      playState.charName ||
      ($('cardName') && $('cardName').value.trim()) ||
      ($('cardFolderName') && $('cardFolderName').value.trim()) ||
      '角色'
    );
  }

  function playUserName() {
    return (playState.userName || '').trim() || '用户';
  }

  function applyPlayMacros(text) {
    var s = text == null ? '' : String(text);
    if (!s) return s;
    var user = playUserName();
    var char = playCharName();
    return s
      .replace(/\{\{user\}\}/gi, user)
      .replace(/\{\{char\}\}/gi, char)
      .replace(/<USER>/gi, user)
      .replace(/<BOT>/gi, char)
      .replace(/<CHAR>/gi, char);
  }

  function appendHighlightedText(parent, text) {
    var s = text == null ? '' : String(text);
    if (!s) return;
    if (!playState.enableHighlight) {
      parent.appendChild(document.createTextNode(s));
      return;
    }
    // 高亮中文引号内重点（官网「开启高亮」同类本地显示）
    var re = /([「『])([^」』]+)([」』])/g;
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      parent.appendChild(document.createTextNode(m[1]));
      var mark = document.createElement('mark');
      mark.className = 'play-hl';
      mark.textContent = m[2];
      parent.appendChild(mark);
      parent.appendChild(document.createTextNode(m[3]));
      last = m.index + m[0].length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }

  /** 角色卡惯例：*旁白* → 斜体显示（不露出星号）；**粗体** 同理 */
  function appendPlayFormatted(parent, text) {
    var s = text == null ? '' : String(text);
    if (!s) return;
    var re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) {
        appendHighlightedText(parent, s.slice(last, m.index));
      }
      if (m[1] != null) {
        var strong = document.createElement('strong');
        if (playState.enableHighlight) strong.className = 'play-hl';
        strong.textContent = m[1];
        parent.appendChild(strong);
      } else {
        var em = document.createElement('em');
        em.className = 'play-narration';
        em.textContent = m[2];
        parent.appendChild(em);
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) {
      appendHighlightedText(parent, s.slice(last));
    }
  }

  function readLocalPlayPrefs() {
    try {
      playState.enableHighlight = localStorage.getItem('chat_enable_highlight') === 'true';
    } catch (_) {
      playState.enableHighlight = false;
    }
    try {
      playState.classicUi = localStorage.getItem('dzmm.playClassicUi') === 'true';
    } catch (_) {
      playState.classicUi = false;
    }
  }

  function applyPlayPanelChrome() {
    var panel = $('cardPlayPanel');
    if (!panel) return;
    panel.classList.toggle('is-highlight', !!playState.enableHighlight);
    panel.classList.toggle('is-classic', !!playState.classicUi);
  }

  function applyPlayChatSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (settings.title != null) playState.title = String(settings.title || '会话');
    if (settings.style) playState.style = String(settings.style);
    if (settings.maxTokens != null && settings.maxTokens !== '') {
      var mt = parseInt(settings.maxTokens, 10);
      if (!isNaN(mt)) playState.maxTokens = mt;
    }
    if (settings.imageGenerationModel) {
      playState.imageGenerationModel = String(settings.imageGenerationModel);
    }
    if (settings.model) {
      playState.selectedModel = String(settings.model);
      var g = findGroupByModelId(playState.selectedModel);
      if (g) {
        playState.selectedGroupKey = g.key;
        if ($('playModelSelect')) $('playModelSelect').value = g.key;
        renderPlayContextPills();
      }
    }
    if ($('playDeepThinking') && typeof settings.deepThinking === 'boolean') {
      $('playDeepThinking').checked = settings.deepThinking;
    }
    if ($('playMemoryEnhance') && typeof settings.enableMemoryEnhance === 'boolean') {
      $('playMemoryEnhance').checked = settings.enableMemoryEnhance;
    }
    applyPlayPanelChrome();
  }

  async function patchPlaySettings(partial) {
    if (!playState.chatId || !partial || typeof partial !== 'object') return null;
    var res = await api('/api/card/play/settings', {
      method: 'POST',
      body: JSON.stringify({ chatId: playState.chatId, settings: partial }),
    });
    if (res && res.ok && res.settings) {
      applyPlayChatSettings(res.settings);
    }
    return res;
  }

  function fillPlaySettingsForm() {
    if ($('playSetHighlight')) $('playSetHighlight').checked = !!playState.enableHighlight;
    if ($('playSetClassic')) $('playSetClassic').checked = !!playState.classicUi;
    if ($('playSetTitle')) $('playSetTitle').value = playState.title || '会话';
    if ($('playSetStyle')) $('playSetStyle').value = playState.style || 'standard';
    if ($('playSetMaxTokens')) $('playSetMaxTokens').value = String(playState.maxTokens || 2500);
    if ($('playSetImageModel')) {
      $('playSetImageModel').value = playState.imageGenerationModel || 'anime';
    }
  }

  function openPlaySettingsModal() {
    fillPlaySettingsForm();
    if ($('playSettingsModal')) $('playSettingsModal').hidden = false;
  }

  function closePlaySettingsModal() {
    if ($('playSettingsModal')) $('playSettingsModal').hidden = true;
  }

  async function savePlaySettingsModal() {
    var highlight = !!($('playSetHighlight') && $('playSetHighlight').checked);
    var classic = !!($('playSetClassic') && $('playSetClassic').checked);
    playState.enableHighlight = highlight;
    playState.classicUi = classic;
    try {
      localStorage.setItem('chat_enable_highlight', highlight ? 'true' : 'false');
      localStorage.setItem('dzmm.playClassicUi', classic ? 'true' : 'false');
    } catch (_) {}
    applyPlayPanelChrome();

    var title = ($('playSetTitle') && $('playSetTitle').value.trim()) || '会话';
    var style = ($('playSetStyle') && $('playSetStyle').value) || 'standard';
    var maxTokens = parseInt(($('playSetMaxTokens') && $('playSetMaxTokens').value) || '2500', 10);
    if (isNaN(maxTokens) || maxTokens < 0) maxTokens = 2500;
    var imageModel = ($('playSetImageModel') && $('playSetImageModel').value) || 'anime';

    playState.title = title;
    playState.style = style;
    playState.maxTokens = maxTokens;
    playState.imageGenerationModel = imageModel;

    if (playState.chatId) {
      setBusy(true);
      try {
        var res = await patchPlaySettings({
          title: title,
          style: style,
          maxTokens: maxTokens,
          imageGenerationModel: imageModel,
        });
        if (!res || !res.ok) {
          showMsg((res && res.error) || '设置保存失败', false);
          return;
        }
        showMsg('会话设置已保存', true);
      } catch (e) {
        showMsg(String(e.message || e), false);
        return;
      } finally {
        setBusy(false);
      }
    }
    renderPlayMessages();
    closePlaySettingsModal();
  }

  function renderPlayMessages() {
    var box = $('playMessages');
    if (!box) return;
    box.innerHTML = '';
    var charLabel = playCharName();
    var userLabel = playUserName();
    (playState.messages || []).forEach(function (m) {
      var div = document.createElement('div');
      var role = m.role === 'user' ? 'user' : 'assistant';
      div.className = 'play-msg ' + role + (m.streaming ? ' streaming' : '');
      var label = document.createElement('span');
      label.className = 'play-role';
      label.textContent = role === 'user' ? userLabel : charLabel;
      div.appendChild(label);
      var body = document.createElement('div');
      body.className = 'play-msg-body';
      appendPlayFormatted(body, applyPlayMacros(m.content || ''));
      div.appendChild(body);
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderPlaySuggest(replies) {
    var wrap = $('playSuggest');
    if (!wrap) return;
    wrap.innerHTML = '';
    var list = Array.isArray(replies) ? replies : [];
    if (!list.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    list.slice(0, 5).forEach(function (r) {
      var text = typeof r === 'string' ? r : (r && (r.content || r.text)) || '';
      if (!text) return;
      var shown = applyPlayMacros(text);
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = shown;
      b.addEventListener('click', function () {
        if ($('playInput')) $('playInput').value = shown;
        sendPlayMessage();
      });
      wrap.appendChild(b);
    });
  }

  async function enterCardPlay() {
    var cardId = currentCloudCardId();
    if (!cardId) {
      showMsg('请先「保存到云端」得到正式卡，再试玩（草稿不可用）', false);
      return;
    }
    setBusy(true);
    showMsg('正在创建平台会话…', true);
    try {
      setCardPlayMode(true);
      readLocalPlayPrefs();
      applyPlayPanelChrome();
      await loadPlayControls();
      if (!playState.charName) {
        playState.charName =
          ($('cardName') && $('cardName').value.trim()) ||
          ($('cardFolderName') && $('cardFolderName').value.trim()) ||
          '';
      }
      updatePlayUserLabel();
      // 同卡续聊
      if (playState.chatId && playState.cardId === cardId) {
        try {
          var contSet = await api('/api/card/play/settings?chatId=' + encodeURIComponent(playState.chatId));
          if (contSet.ok) applyPlayChatSettings(contSet.settings || {});
        } catch (_) {}
        renderPlayMessages();
        if ($('playStatus')) $('playStatus').textContent = '继续会话';
        showMsg('已进入试玩（沿用会话）', true);
        return;
      }
      var meta = await api('/api/card/play/meta?cardId=' + encodeURIComponent(cardId));
      var historyIndex = null;
      if (meta.ok && meta.preview && meta.preview.chatHistoryIndex != null) {
        historyIndex = meta.preview.chatHistoryIndex;
      }
      playState.charName =
        (meta.ok && meta.forChat && meta.forChat.name) ||
        ($('cardName') && $('cardName').value.trim()) ||
        ($('cardFolderName') && $('cardFolderName').value.trim()) ||
        '';
      updatePlayUserLabel();
      var start = await api('/api/card/play/start', {
        method: 'POST',
        body: JSON.stringify({ cardId: cardId, chatHistoryIndex: historyIndex }),
      });
      if (!start.ok) {
        setCardPlayMode(false);
        showMsg(start.error || '创建会话失败', false);
        return;
      }
      playState.chatId = start.chatId;
      playState.cardId = cardId;
      playState.messages = Array.isArray(start.messages) ? start.messages.slice() : [];
      if (start.settings) applyPlayChatSettings(start.settings);
      // 若会话尚无消息，用 quick preview 开场
      if (!playState.messages.length && meta.ok && meta.preview && meta.preview.firstMessage) {
        playState.messages.push({ role: 'assistant', content: meta.preview.firstMessage });
      }
      renderPlayMessages();
      renderPlaySuggest(
        (meta.ok && meta.preview && meta.preview.suggestedReplies) ||
        (meta.ok && meta.forChat && meta.forChat.suggestedReplies) ||
        []
      );
      if ($('playStatus')) $('playStatus').textContent = '会话已创建';
      showMsg('试玩已开始 · chat=' + String(start.chatId).slice(0, 10) + '…', true);
    } catch (e) {
      setCardPlayMode(false);
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
      updatePlayGate();
    }
  }

  function parsePlaySseBuffer(buf, onEvent) {
    var parts = buf.split('\n');
    var rest = parts.pop() || '';
    parts.forEach(function (line) {
      line = line.replace(/\r$/, '');
      if (!line.startsWith('data: ')) return;
      try {
        var obj = JSON.parse(line.slice(6));
        onEvent(obj);
      } catch (_) {}
    });
    return rest;
  }

  async function sendPlayMessage(textOverride) {
    if (playState.sending) return;
    var text = (textOverride != null ? textOverride : (($('playInput') && $('playInput').value) || '')).trim();
    if (!text) return;
    if (!playState.chatId || !playState.cardId) {
      showMsg('会话未就绪，请重新点试玩', false);
      return;
    }
    playState.sending = true;
    if ($('playSendBtn')) $('playSendBtn').disabled = true;
    if ($('playInput')) $('playInput').value = '';
    playState.messages.push({ role: 'user', content: text });
    var aiMsg = { role: 'assistant', content: '', streaming: true };
    playState.messages.push(aiMsg);
    renderPlayMessages();
    if ($('playStatus')) $('playStatus').textContent = '生成中…';
    if ($('playSuggest')) $('playSuggest').hidden = true;

    var prompts = playState.messages.slice(0, -1).map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content || '' };
    });
    var deep = !!($('playDeepThinking') && $('playDeepThinking').checked);
    var mem = !!($('playMemoryEnhance') && $('playMemoryEnhance').checked);
    var body = {
      chatId: playState.chatId,
      cardId: playState.cardId,
      content: text,
      // 上下文长度体现在 model internalName；maxTokens = 最大回复 Token（设置里可改）
      model: playState.selectedModel || playState.defaultModel || '',
      maxTokens: playState.maxTokens || (deep ? 3500 : 2500),
      deepThinking: deep,
      enableMemoryEnhance: mem,
      style: playState.style || 'standard',
      imageGenerationModel: playState.imageGenerationModel || 'anime',
      presetIds: selectedPresetIds(),
      playerInfo: playUserName(),
      prompts: prompts,
    };

    try {
      var res = await fetch('/api/card/play/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        var errText = await res.text();
        var errMsg = errText;
        try {
          var ej = JSON.parse(errText);
          errMsg = ej.error || ej.message || errText;
        } catch (_) {}
        aiMsg.content = '（生成失败）' + errMsg;
        aiMsg.streaming = false;
        renderPlayMessages();
        showMsg(String(errMsg).slice(0, 200), false);
        return;
      }
      var reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) {
        var raw = await res.text();
        aiMsg.content = raw || '（空响应）';
        aiMsg.streaming = false;
        renderPlayMessages();
        return;
      }
      var dec = new TextDecoder();
      var buf = '';
      var content = '';
      while (true) {
        var step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        buf = parsePlaySseBuffer(buf, function (obj) {
          var typ = obj && obj.type;
          var data = obj && obj.data;
          if (typ === 'token') {
            var chunk = typeof data === 'string' ? data : '';
            content += chunk;
            aiMsg.content = content;
            renderPlayMessages();
          } else if (typ === 'step' && data && data.content != null) {
            content = String(data.content);
            aiMsg.content = content;
            renderPlayMessages();
          } else if (typ === 'complete') {
            if (data && data.content != null) content = String(data.content);
            else if (data && data.message != null) content = String(data.message);
            aiMsg.content = content || aiMsg.content;
            aiMsg.streaming = false;
            renderPlayMessages();
          } else if (typ === 'error') {
            var msg = (data && (data.message || data.error)) || '生成错误';
            aiMsg.content = (content ? content + '\n' : '') + '（错误）' + msg;
            aiMsg.streaming = false;
            renderPlayMessages();
            showMsg(String(msg).slice(0, 200), false);
          }
        });
      }
      // 尾部
      if (buf) {
        parsePlaySseBuffer(buf + '\n', function () {});
      }
      aiMsg.streaming = false;
      if (!aiMsg.content) aiMsg.content = '（无内容）';
      renderPlayMessages();
      if ($('playStatus')) $('playStatus').textContent = '就绪';
    } catch (e) {
      aiMsg.content = '（网络错误）' + String(e.message || e);
      aiMsg.streaming = false;
      renderPlayMessages();
      showMsg(String(e.message || e), false);
    } finally {
      playState.sending = false;
      if ($('playSendBtn')) $('playSendBtn').disabled = false;
    }
  }

  if ($('cardPlayBtn')) $('cardPlayBtn').addEventListener('click', enterCardPlay);
  if ($('cardPlayBackBtn')) {
    $('cardPlayBackBtn').addEventListener('click', function () {
      exitCardPlay({ keepSession: true });
    });
  }
  if ($('playModelSelect')) {
    $('playModelSelect').addEventListener('change', onPlayModelGroupChange);
  }
  if ($('playRefreshMetaBtn')) {
    $('playRefreshMetaBtn').addEventListener('click', function () { loadPlayControls(); });
  }
  if ($('playPresetBtn')) {
    $('playPresetBtn').addEventListener('click', openPlayPresetModal);
  }
  if ($('playSettingsBtn')) {
    $('playSettingsBtn').addEventListener('click', openPlaySettingsModal);
  }
  if ($('playSettingsCloseBtn')) {
    $('playSettingsCloseBtn').addEventListener('click', closePlaySettingsModal);
  }
  if ($('playSettingsApplyBtn')) {
    $('playSettingsApplyBtn').addEventListener('click', function () { savePlaySettingsModal(); });
  }
  if ($('playSettingsModal')) {
    $('playSettingsModal').addEventListener('click', function (e) {
      if (e.target === $('playSettingsModal')) closePlaySettingsModal();
    });
  }
  if ($('playDeepThinking')) {
    $('playDeepThinking').addEventListener('change', function () {
      var on = !!$('playDeepThinking').checked;
      // 官网：切换深度思考时同步 maxTokens 3500/2500
      playState.maxTokens = on ? 3500 : 2500;
      if (playState.chatId) {
        patchPlaySettings({ deepThinking: on, maxTokens: playState.maxTokens }).catch(function () {});
      }
    });
  }
  if ($('playMemoryEnhance')) {
    $('playMemoryEnhance').addEventListener('change', function () {
      if (!playState.chatId) return;
      patchPlaySettings({
        enableMemoryEnhance: !!$('playMemoryEnhance').checked,
      }).catch(function () {});
    });
  }
  if ($('playPresetCloseBtn')) {
    $('playPresetCloseBtn').addEventListener('click', closePlayPresetModal);
  }
  if ($('playPresetApplyBtn')) {
    $('playPresetApplyBtn').addEventListener('click', applyPlayPresetModal);
  }
  if ($('playPresetClearBtn')) {
    $('playPresetClearBtn').addEventListener('click', function () {
      var list = $('playPresetList');
      if (!list) return;
      list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
    });
  }
  if ($('playPresetModal')) {
    $('playPresetModal').addEventListener('click', function (e) {
      if (e.target === $('playPresetModal')) closePlayPresetModal();
    });
  }
  if ($('playSendBtn')) $('playSendBtn').addEventListener('click', function () { sendPlayMessage(); });
  if ($('playInput')) {
    $('playInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        sendPlayMessage();
      }
    });
  }
  updatePlayGate();
  if ($('cardRefreshBtn')) {
    $('cardRefreshBtn').addEventListener('click', function () { refreshCardList(); });
  }
  if ($('cardReloadBtn')) {
    $('cardReloadBtn').addEventListener('click', function () {
      if (!currentCardId) {
        showMsg('当前没有已保存的卡可重载', false);
        return;
      }
      openLocalCard(currentCardId);
    });
  }
  if ($('cardCloudBtn')) {
    $('cardCloudBtn').addEventListener('click', async function () {
      setBusy(true);
      showMsg('正在拉取云端角色/草稿列表…', true);
      try {
        await refreshCloudCardList(true);
      } catch (e) {
        showMsg(String(e.message || e), false);
      } finally {
        setBusy(false);
      }
    });
  }
  function bindCloudFilter(id, mode) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function () {
      cloudCardFilter = mode;
      renderCloudCardList({ resetPage: true });
      var sc = $('cloudCardListScroll');
      if (sc) sc.scrollTop = 0;
    });
  }
  bindCloudFilter('cardCloudFilterAll', 'all');
  bindCloudFilter('cardCloudFilterDraft', 'draft');
  bindCloudFilter('cardCloudFilterPub', 'pub');
  if ($('cardCloudSearch')) {
    $('cardCloudSearch').addEventListener('input', function () {
      cloudCardSearch = $('cardCloudSearch').value || '';
      if (cloudSearchTimer) clearTimeout(cloudSearchTimer);
      cloudSearchTimer = setTimeout(function () {
        renderCloudCardList({ resetPage: true });
        var sc = $('cloudCardListScroll');
        if (sc) sc.scrollTop = 0;
      }, 120);
    });
  }

  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarCollapsed(true);
    else setSidebarCollapsed(false);
  } catch (_) {
    setSidebarCollapsed(false);
  }
  setFabProgress(0, 'idle');

  // 刷新后内存态丢失：强制退出试玩叠层，避免空表单+试玩条并存
  setCardPlayMode(false);
  try {
    var savedMode = localStorage.getItem(CONSOLE_MODE_KEY);
    var savedCardId = '';
    try { savedCardId = localStorage.getItem(CONSOLE_CARD_KEY) || ''; } catch (_) {}
    if (savedMode === 'card' || savedMode === 'game') {
      switchConsoleMode(savedMode);
    } else {
      // 首次使用：游戏卡 + 账号登录
      switchConsoleMode('game', { panel: 'login' });
    }
    // 角色卡模式：恢复上次打开的卡夹（刷新后不再是空白错误页）
    if ((savedMode === 'card' || consoleMode === 'card') && savedCardId) {
      openLocalCard(savedCardId).catch(function () {});
    }
  } catch (_) {
    switchConsoleMode('game', { panel: 'login' });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isSidebarCollapsed()) {
      setSidebarCollapsed(false);
    }
  });

  refresh().then(function (status) {
    if (status && status.pull && status.pull.running) {
      setBusy(true);
      startPullPoll();
      switchConsoleMode('game', { skipPanel: true });
      switchPanel('pull');
    }
    if (status && status.sync && status.sync.running) {
      setBusy(true, { keepEnabled: { fabSync: true, fabExpand: true, fabReload: true } });
      applySyncJob(status.sync);
      startSyncPoll();
    }
    if (status && status.preview && status.preview.running) {
      setStageLive(true);
      startBridgePoll();
    } else {
      renderBridge(null, status && status.preview);
    }
  }).catch(function (e) {
    showMsg(String(e.message || e), false);
  });
}());
