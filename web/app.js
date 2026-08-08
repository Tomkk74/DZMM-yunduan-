(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pullTimer = null;
  var bridgeTimer = null;
  var publishTimer = null;
  var SIDEBAR_KEY = 'dzmm-console-sidebar-collapsed';
  var FAB_POS_KEY = 'dzmm-console-fab-pos';
  var FAB_CIRC = 2 * Math.PI * 20; // r=20

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
  }

  function setBusy(busy) {
    ['loginBtn', 'logoutBtn', 'pingBtn', 'pullBtn', 'pullRetryBtn', 'previewStartBtn', 'previewStopBtn', 'previewReloadBtn', 'publishBtn', 'bridgeRefreshBtn', 'fabPublish', 'fabReload'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !!busy;
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

  function setSidebarCollapsed(collapsed) {
    var app = $('appShell');
    var fab = $('fabDock');
    if (!app) return;
    if (collapsed) {
      app.classList.add('is-collapsed');
      if (fab) fab.hidden = false;
      try { localStorage.setItem(SIDEBAR_KEY, '1'); } catch (_) {}
    } else {
      app.classList.remove('is-collapsed');
      if (fab) fab.hidden = true;
      try { localStorage.setItem(SIDEBAR_KEY, '0'); } catch (_) {}
      setFabProgress(0, 'idle');
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

  function switchPanel(name) {
    document.querySelectorAll('.menu-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-panel') === name);
    });
    document.querySelectorAll('.sidebar-scroll .panel').forEach(function (panel) {
      var match = panel.getAttribute('data-panel') === name;
      panel.classList.toggle('active', match);
      if (match) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
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

  $('fabPublish').addEventListener('click', function () {
    runPublish({ direct: true });
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
    var w = rect.width || 80;
    var h = rect.height || 120;
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

  function bindFabDrag() {
    var dock = $('fabDock');
    var handle = $('fabExpand');
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
      setSidebarCollapsed(false);
    });
  }

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

  var fabReload = $('fabReload');
  if (fabReload) {
    fabReload.addEventListener('click', function () {
      reloadPreviewOnly();
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

  document.querySelectorAll('.menu-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchPanel(btn.getAttribute('data-panel'));
    });
  });

  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarCollapsed(true);
    else setSidebarCollapsed(false);
  } catch (_) {
    setSidebarCollapsed(false);
  }
  setFabProgress(0, 'idle');

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isSidebarCollapsed()) {
      setSidebarCollapsed(false);
    }
  });

  refresh().then(function (status) {
    if (status && status.pull && status.pull.running) {
      setBusy(true);
      startPullPoll();
      switchPanel('pull');
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
