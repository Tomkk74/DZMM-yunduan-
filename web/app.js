(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pullTimer = null;
  var bridgeTimer = null;
  var publishTimer = null;
  var SIDEBAR_KEY = 'dzmm-console-sidebar-collapsed';
  var CONSOLE_MODE_KEY = 'dzmm-console-mode';
  var consoleMode = 'game'; // game | card
  var lastGamePanel = 'bridge';
  var FAB_POS_KEY = 'dzmm-console-fab-pos';
  var FAB_CIRC = 2 * Math.PI * 20; // r=20
  var currentCardId = '';
  var currentCard = null;
  var currentCardMtime = 0;
  var currentCardFolder = '';
  var cardPollTimer = null;
  var cardApplyingRemote = false;
  var voiceCatalog = { public: [], mine: [] };
  var voiceAudio = null;
  var cloudCardItems = [];
  var cloudCardFilter = 'all'; // all | draft | pub

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
    ['loginBtn', 'logoutBtn', 'pingBtn', 'pullBtn', 'pullRetryBtn', 'previewStartBtn', 'previewStopBtn', 'previewReloadBtn', 'publishBtn', 'bridgeRefreshBtn', 'fabPublish', 'fabReload', 'fabSync', 'fabExpand', 'cardAiBtn', 'cardAiBtn2', 'cardNewBtn', 'cardNewBtn2', 'cardSaveBtn', 'cardRefreshBtn', 'cardCloudBtn', 'cardReloadBtn', 'cardMenuBtn', 'cardVoiceRefreshBtn', 'cardVoiceClearBtn', 'cardPublishBtn', 'cardDraftBtn', 'cardDeleteLocalBtn', 'cardCloudFilterAll', 'cardCloudFilterDraft', 'cardCloudFilterPub'].forEach(function (id) {
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
      refreshCardList();
      if ($('cardBrief') && $('cardBriefMain') && !$('cardBriefMain').value) {
        $('cardBriefMain').value = $('cardBrief').value || '';
      }
      if (currentCardId) startCardPoll();
    } else {
      lastGamePanel = name;
      stopCardPoll();
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
      switchPanel(opts.panel || lastGamePanel || 'bridge');
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

  function renderCloudCardList() {
    var box = $('cloudCardBox');
    var list = $('cloudCardList');
    if (!box || !list) return;
    list.innerHTML = '';
    var listedMap = localListedMap();
    var items = (cloudCardItems || []).filter(function (it) {
      if (cloudCardFilter === 'draft') return !!it.isDraft;
      if (cloudCardFilter === 'pub') return !it.isDraft;
      return true;
    });
    box.hidden = false;
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

  async function refreshCloudCardList(showToast) {
    var data = await api('/api/card/cloud');
    if (!data.ok) {
      if (showToast !== false) showMsg(data.error || '云端列表失败（需已登录）', false);
      if ($('cloudCardBox')) $('cloudCardBox').hidden = true;
      return data;
    }
    // 先刷新本地列表，便于合并「已上架」标记
    try { await refreshCardList(); } catch (_) {}
    cloudCardItems = data.items || [];
    renderCloudCardList();
    var drafts = cloudCardItems.filter(function (x) { return x.isDraft; }).length;
    var pubs = cloudCardItems.length - drafts;
    if (showToast !== false) {
      showMsg('云端 ' + cloudCardItems.length + ' 项 · 草稿 ' + drafts + ' · 已保存 ' + pubs, true);
    }
    return data;
  }

  async function refreshCardList() {
    try {
      var data = await api('/api/card/list');
      var list = $('cardList');
      list.innerHTML = '';
      if (!data.ok) {
        setCardMsg(data.error || '列表失败', false);
        return;
      }
      var items = data.items || [];
      window.__localCardListed = items;
      setCardMsg('本机 ' + items.length + ' 张 · ' + (data.cardsDir || '卡/'), true);
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
    } catch (e) {
      setCardMsg(String(e.message || e), false);
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
      return;
    }
    if ($('cardBrief')) $('cardBrief').value = brief;
    if ($('cardBriefMain')) $('cardBriefMain').value = brief;
    setBusy(true);
    showMsg('正在创建本地卡夹…', true);
    try {
      var data = await api('/api/card/ai', {
        method: 'POST',
        body: JSON.stringify({ name: name, brief: brief }),
      });
      if (!data.ok) {
        showMsg(data.error || '创建卡夹失败', false);
        return;
      }
      fillCardForm(data.card, data.localId || '', { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || '';
      setStageMode('card');
      setCardFullscreen(true);
      await refreshCardList();
      showMsg(data.hint || ('已监听 · ' + currentCardFolder), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  async function runCardNew() {
    setBusy(true);
    try {
      var name = ($('cardFolderName') && $('cardFolderName').value.trim()) || '未命名角色';
      var data = await api('/api/card/new', {
        method: 'POST',
        body: JSON.stringify({ name: name, brief: getCardBrief() }),
      });
      if (!data.ok) {
        showMsg(data.error || '新建失败', false);
        return;
      }
      fillCardForm(data.card, data.localId, { mtime: data.mtime || 0 });
      currentCardFolder = data.folder || data.path || '';
      setStageMode('card');
      setCardFullscreen(true);
      await refreshCardList();
      showMsg('已新建卡夹 · ' + (data.folder || data.localId), true);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  if ($('cardAiBtn')) $('cardAiBtn').addEventListener('click', runCardAiWrite);
  if ($('cardAiBtn2')) $('cardAiBtn2').addEventListener('click', runCardAiWrite);
  if ($('cardNewBtn')) $('cardNewBtn').addEventListener('click', runCardNew);
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
      refreshCloudCardList(false);
    } catch (e) {
      showMsg(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  }

  if ($('cardPublishBtn')) $('cardPublishBtn').addEventListener('click', function () { saveToCloud(false); });
  if ($('cardDraftBtn')) $('cardDraftBtn').addEventListener('click', function () { saveToCloud(true); });
  if ($('cardDeleteLocalBtn')) {
    $('cardDeleteLocalBtn').addEventListener('click', function () {
      var id = currentCardLocalId();
      if (!id) {
        showMsg('当前没有打开的本地卡', false);
        return;
      }
      deleteLocalCard(id);
    });
  }
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
      renderCloudCardList();
    });
  }
  bindCloudFilter('cardCloudFilterAll', 'all');
  bindCloudFilter('cardCloudFilterDraft', 'draft');
  bindCloudFilter('cardCloudFilterPub', 'pub');

  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarCollapsed(true);
    else setSidebarCollapsed(false);
  } catch (_) {
    setSidebarCollapsed(false);
  }
  setFabProgress(0, 'idle');

  try {
    var savedMode = localStorage.getItem(CONSOLE_MODE_KEY);
    if (savedMode === 'card' || savedMode === 'game') {
      switchConsoleMode(savedMode);
    }
  } catch (_) {}

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
