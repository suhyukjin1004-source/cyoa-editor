/* ===========================================================
   CYOA 에디터 (editor.js) — engine.js(window.CYOA) 의존
   3분할: 트리 / 캔버스(편집·미리보기) / 인스펙터
   =========================================================== */
(function () {
  "use strict";
  var C = window.CYOA;
  var AUTO_KEY = "cyoa_editor_autosave";
  var HELP_KEY = "cyoa_help_seen_v1";   // 첫 실행 시작 가이드 1회 자동 표시 여부

  var project = null;
  var sel = { type: null, id: null };   // 현재 편집 대상: page|row|choice|link
  var editPageId = null;                // 캔버스에 표시 중인 페이지
  var previewOpen = false;              // 우측 플레이어 미리보기 패널 표시
  var previewStarted = false;           // 오프닝을 지나 실제 플레이에 진입했는지
  var pstate = null;                    // 미리보기용 재생 상태
  var PREVIEW_DEVICE_KEY = "cyoa_editor_preview_device";
  var previewDevice = loadPreviewDevice();

  var $tree, $canvas, $canvasWrap, $inspector, $banner;

  /* ---------------- 유틸 ---------------- */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove("show"); }, 1700);
  }
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "application/octet-stream" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  /* ---------------- 영속 (자동저장) ----------------
     자동저장은 이미지(데이터 URL)를 포함해 커질 수 있어 localStorage(~5MB)를 넘기기 쉽다.
     → IndexedDB(수백 MB급)를 우선 쓰고, 미지원 환경에선 localStorage로 폴백한다.
     설정성 소형 키(패널 폭·미리보기 기기·도움말)는 그대로 localStorage. */
  var IDB_DB = "cyoa_editor", IDB_STORE = "kv", _idbPromise = null;
  function idbOpen() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no-indexeddb")); return; }
      var req = window.indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("idb-open")); };
    });
    return _idbPromise;
  }
  function idbPut(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("idb-abort")); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  var _autosaveWarned = false;
  var _autoTimer = null, _autoPending = null;
  // 자동저장 쓰기(디바운스 300ms) — IDB 성공 시 옛 localStorage 사본 정리, 실패 시 localStorage 폴백.
  function persistAutosave(str) {
    _autoPending = str;
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(flushAutosave, 300);
  }
  function flushAutosave() {
    clearTimeout(_autoTimer); _autoTimer = null;
    var str = _autoPending; if (str == null) return;
    _autoPending = null;
    idbPut(AUTO_KEY, str).then(function () {
      _autosaveWarned = false;
      try { localStorage.removeItem(AUTO_KEY); } catch (e) {} // 용량 확보
    }).catch(function () {
      try { localStorage.setItem(AUTO_KEY, str); _autosaveWarned = false; }
      catch (e) {
        if (!_autosaveWarned) { _autosaveWarned = true; toast("⚠ 자동 저장 실패 — 저장 공간이 부족합니다. 이미지 용량을 줄이거나 '내보내기'로 백업하세요."); }
      }
    });
  }
  function autosave() {
    scheduleUndoSnapshot(); // 모든 변경이 autosave 를 지나므로 여기가 undo 스냅샷의 단일 후킹 지점
    persistAutosave(JSON.stringify(project));
  }
  // 탭을 닫기 직전 대기 중인 자동저장을 밀어넣는다(디바운스로 인한 최근 편집 유실 최소화).
  window.addEventListener("beforeunload", function () { if (_autoPending != null) flushAutosave(); });
  // IDB 우선 로드 + 옛 localStorage 자동저장 1회 이관(하위호환). 실패 시 localStorage 직접.
  function loadAutosaveState() {
    return idbGet(AUTO_KEY).then(function (val) {
      if (val != null) { try { return JSON.parse(val); } catch (e) { return null; } }
      var raw = null; try { raw = localStorage.getItem(AUTO_KEY); } catch (e) {}
      if (raw) {
        try { var p = JSON.parse(raw); idbPut(AUTO_KEY, raw).then(function () { try { localStorage.removeItem(AUTO_KEY); } catch (e) {} }, function () {}); return p; }
        catch (e) {}
      }
      return null;
    }, function () {
      var raw = null; try { raw = localStorage.getItem(AUTO_KEY); } catch (e) {}
      if (raw) { try { return JSON.parse(raw); } catch (e) {} }
      return null;
    });
  }

  /* ---------------- 되돌리기 / 다시 실행 (undo/redo) ----------------
     스냅샷 기반: 변경 후 500ms 잠잠해지면(디바운스) 이전 상태를 undo 스택에 push.
     연속 타이핑은 한 단계로 묶이고, 삭제·재정렬·프로젝트 교체까지 모두 잡힌다. */
  var UNDO_MAX = 30;                 // 이미지(데이터 URL) 포함 대형 프로젝트의 메모리 고려
  var _undoStack = [], _redoStack = [];
  var _lastSnap = null, _snapTimer = null, _restoring = false;
  function scheduleUndoSnapshot() {
    if (_restoring) return;
    clearTimeout(_snapTimer);
    _snapTimer = setTimeout(commitUndoSnapshot, 500);
    updateUndoButtons();
  }
  function commitUndoSnapshot() {
    clearTimeout(_snapTimer); _snapTimer = null;
    var snap = JSON.stringify(project);
    if (_lastSnap === null) { _lastSnap = snap; updateUndoButtons(); return; } // 최초 기준선
    if (snap === _lastSnap) { updateUndoButtons(); return; }
    _undoStack.push(_lastSnap);
    if (_undoStack.length > UNDO_MAX) _undoStack.shift();
    _redoStack.length = 0;
    _lastSnap = snap;
    updateUndoButtons();
  }
  function resetUndoBaseline() {
    clearTimeout(_snapTimer); _snapTimer = null;
    _lastSnap = JSON.stringify(project);
    updateUndoButtons();
  }
  function undo() {
    if (_snapTimer) commitUndoSnapshot(); // 대기 중 변경 먼저 확정
    if (!_undoStack.length) { toast("되돌릴 작업이 없습니다."); return; }
    _redoStack.push(_lastSnap);
    _lastSnap = _undoStack.pop();
    applySnapshot(_lastSnap);
    toast("↩ 되돌렸습니다.");
  }
  function redo() {
    if (_snapTimer) commitUndoSnapshot();
    if (!_redoStack.length) { toast("다시 실행할 작업이 없습니다."); return; }
    _undoStack.push(_lastSnap);
    if (_undoStack.length > UNDO_MAX) _undoStack.shift();
    _lastSnap = _redoStack.pop();
    applySnapshot(_lastSnap);
    toast("↪ 다시 실행했습니다.");
  }
  function applySnapshot(snap) {
    _restoring = true;
    try {
      project = JSON.parse(snap);
      normalize();
      // 복원 상태를 그대로 영속화(스냅샷 재스케줄 없이 — _restoring 가드)
      persistAutosave(snap);
      // 사라진 페이지를 가리키는 편집 상태 폴백(선택 요소는 renderInspector 의 기존 폴백이 처리)
      if (!C.findPage(project, editPageId)) {
        editPageId = (project.settings && project.settings.startPageId) || (project.pages[0] || {}).id;
      }
      applyLiveTheme();
      renderAll();
      if (previewOpen) renderPreviewPanel({ preserveScroll: true });
    } finally { _restoring = false; }
    updateUndoButtons();
  }
  function updateUndoButtons() {
    var u = document.getElementById("btnUndo"), r = document.getElementById("btnRedo");
    if (u) u.disabled = !_undoStack.length && !_snapTimer;
    if (r) r.disabled = !_redoStack.length;
  }

  /* ---------------- 미리보기 기기 ---------------- */
  function previewPreset(mode) {
    return {
      current: { label: "현재", width: 0, height: 0 },
      mobile: { label: "모바일", width: 390, height: 844 },
      tablet: { label: "태블릿", width: 768, height: 1024 },
      pc: { label: "PC", width: 1366, height: 768 },
      custom: { label: "사용자", width: 390, height: 844 }
    }[mode] || null;
  }
  function clampDim(v, min, max, fallback) {
    v = Number(v);
    if (!isFinite(v)) v = fallback;
    return Math.round(Math.max(min, Math.min(max, v)));
  }
  function normalizePreviewDevice(raw) {
    raw = raw || {};
    var mode = previewPreset(raw.mode) ? raw.mode : "current";
    var customWidth = clampDim(raw.customWidth || raw.width, 320, 1920, 390);
    var customHeight = clampDim(raw.customHeight || raw.height, 320, 1600, 844);
    if (mode === "current") return { mode: "current", width: 0, height: 0, customWidth: customWidth, customHeight: customHeight };
    if (mode === "custom") return { mode: "custom", width: customWidth, height: customHeight, customWidth: customWidth, customHeight: customHeight };
    var p = previewPreset(mode);
    return {
      mode: mode,
      width: clampDim(raw.width, 320, 1920, p.width),
      height: clampDim(raw.height, 320, 1600, p.height),
      customWidth: customWidth,
      customHeight: customHeight
    };
  }
  function loadPreviewDevice() {
    try {
      if (typeof localStorage === "undefined") return normalizePreviewDevice();
      return normalizePreviewDevice(JSON.parse(localStorage.getItem(PREVIEW_DEVICE_KEY) || "{}"));
    } catch (e) {
      return normalizePreviewDevice();
    }
  }
  function savePreviewDevice() {
    previewDevice = normalizePreviewDevice(previewDevice);
    try { localStorage.setItem(PREVIEW_DEVICE_KEY, JSON.stringify(previewDevice)); } catch (e) {}
  }
  function setPreviewDeviceMode(mode) {
    var cur = normalizePreviewDevice(previewDevice);
    if (mode === "current") {
      previewDevice = { mode: "current", width: 0, height: 0, customWidth: cur.customWidth, customHeight: cur.customHeight };
    } else if (mode === "custom") {
      previewDevice = { mode: "custom", width: cur.customWidth, height: cur.customHeight, customWidth: cur.customWidth, customHeight: cur.customHeight };
    } else {
      var p = previewPreset(mode);
      previewDevice = { mode: mode, width: p.width, height: p.height, customWidth: cur.customWidth, customHeight: cur.customHeight };
    }
    savePreviewDevice();
  }
  function setPreviewDeviceSize(width, height) {
    var cur = normalizePreviewDevice(previewDevice);
    var w = clampDim(width, 320, 1920, cur.customWidth || 390);
    var h = clampDim(height, 320, 1600, cur.customHeight || 844);
    previewDevice = { mode: "custom", width: w, height: h, customWidth: w, customHeight: h };
    savePreviewDevice();
  }
  function rotatePreviewDevice() {
    var cur = normalizePreviewDevice(previewDevice);
    if (cur.mode === "current") return;
    previewDevice = { mode: cur.mode, width: cur.height, height: cur.width, customWidth: cur.customWidth, customHeight: cur.customHeight };
    if (cur.mode === "custom") {
      previewDevice.customWidth = cur.height;
      previewDevice.customHeight = cur.width;
    }
    savePreviewDevice();
  }
  function previewDeviceConfig() {
    var cur = normalizePreviewDevice(previewDevice);
    var p = previewPreset(cur.mode);
    return { mode: cur.mode, label: p.label, width: cur.width, height: cur.height };
  }
  function previewViewportClasses(width) {
    var classes = [];
    if (width <= 460) classes.push("is-choice-narrow");
    else if (width <= 820) classes.push("is-choice-mid");
    if (width <= 600) classes.push("is-layout-narrow");
    if (width <= 700) classes.push("is-start-narrow");
    return classes.join(" ");
  }
  function appendPreviewDeviceControls(parent) {
    var cfg = previewDeviceConfig();
    var controls = el("span", "preview-device-controls");
    var select = el("select", "preview-device-select");
    [
      ["current", "현재"], ["mobile", "모바일"], ["tablet", "태블릿"], ["pc", "PC"], ["custom", "사용자"]
    ].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0]; o.textContent = opt[1];
      if (cfg.mode === opt[0]) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", function () { setPreviewDeviceMode(select.value); rerenderPreviewDevice(); });
    controls.appendChild(select);

    if (cfg.mode === "custom") {
      var w = el("input", "preview-device-size");
      w.type = "number"; w.min = "320"; w.max = "1920"; w.value = cfg.width;
      w.title = "viewport 폭";
      var h = el("input", "preview-device-size");
      h.type = "number"; h.min = "320"; h.max = "1600"; h.value = cfg.height;
      h.title = "viewport 높이";
      function applyCustomSize() { setPreviewDeviceSize(w.value, h.value); rerenderPreviewDevice(); }
      w.addEventListener("change", applyCustomSize);
      h.addEventListener("change", applyCustomSize);
      controls.appendChild(w);
      controls.appendChild(el("span", "preview-device-x", "×"));
      controls.appendChild(h);
    }

    var rotate = el("button", "btn btn-sm", "↔");
    rotate.type = "button";
    rotate.title = "가로/세로 전환";
    rotate.disabled = cfg.mode === "current";
    rotate.addEventListener("click", function () { rotatePreviewDevice(); rerenderPreviewDevice(); });
    controls.appendChild(rotate);
    parent.appendChild(controls);
  }
  function rerenderPreviewDevice() {
    if (previewOpen) renderPreviewPanel({ preserveScroll: true });
  }
  function scalePreviewShell(shell) {
    var frame = shell.querySelector(".preview-device-frame");
    if (!frame) return;
    var available = Math.max(180, shell.clientWidth - 20);
    var scale = Math.min(1, available / Math.max(frame.offsetWidth, 1));
    scale = Math.max(0.16, scale);
    shell.style.setProperty("--preview-scale", scale);
    shell.style.setProperty("--preview-scaled-height", Math.ceil(frame.offsetHeight * scale) + "px");
    shell.setAttribute("data-scale", String(scale));
    var scaleLabel = shell.querySelector(".preview-device-scale");
    if (scaleLabel) scaleLabel.textContent = Math.round(scale * 100) + "%";
  }
  function rescalePreviewFrames() {
    document.querySelectorAll(".preview-device-shell").forEach(scalePreviewShell);
  }
  function previewInteractionScale(node) {
    var shell = node && node.closest ? node.closest(".preview-device-shell") : null;
    var scale = shell ? Number(shell.getAttribute("data-scale")) : 1;
    return scale > 0 ? scale : 1;
  }
  function renderPreviewSurface(mountEl, builder) {
    var cfg = previewDeviceConfig();
    clear(mountEl);
    if (cfg.mode === "current") {
      builder(mountEl);
      return mountEl;
    }
    var shell = el("div", "preview-device-shell preview-device-" + cfg.mode);
    var sizer = el("div", "preview-device-sizer");
    var frame = el("div", "preview-device-frame");
    frame.style.width = cfg.width + "px";
    var frameHead = el("div", "preview-device-toolbar");
    frameHead.appendChild(el("span", "preview-device-name", cfg.label + " " + cfg.width + "×" + cfg.height));
    frameHead.appendChild(el("span", "preview-device-scale", "100%"));
    var viewport = el("div", "preview-device-viewport " + previewViewportClasses(cfg.width));
    viewport.style.width = cfg.width + "px";
    viewport.style.height = cfg.height + "px";
    frame.appendChild(frameHead);
    frame.appendChild(viewport);
    sizer.appendChild(frame);
    shell.appendChild(sizer);
    mountEl.appendChild(shell);
    builder(viewport);
    requestAnimationFrame(function () { scalePreviewShell(shell); });
    return viewport;
  }

  /* ---------------- 위치 찾기 ---------------- */
  function pageOfRow(rowId) {
    var pid = null;
    project.pages.forEach(function (p) { (p.rows || []).forEach(function (r) { if (r.id === rowId) pid = p.id; }); });
    return pid;
  }
  function pageOfChoice(choiceId) {
    var pid = null;
    project.pages.forEach(function (p) { (p.rows || []).forEach(function (r) { (r.choices || []).forEach(function (c) { if (c.id === choiceId) pid = p.id; }); }); });
    return pid;
  }
  function rowOfChoice(choiceId) { return C.findRowOfChoice(project, choiceId); }
  function findRow(rowId) {
    var res = null;
    project.pages.forEach(function (p) {
      (p.rows || []).forEach(function (r) { if (r.id === rowId) res = r; });
    });
    return res;
  }
  function findLink(linkUid) {
    var res = null;
    project.pages.forEach(function (p) { (p.links || []).forEach(function (l) { if (l._uid === linkUid) res = { page: p, link: l }; }); });
    return res;
  }
  function ensureBlockLayout(obj, kind) {
    if (!obj) return C.defaultBlockLayout(kind || "page");
    obj.layout = C.normalizeBlockLayout(obj.layout, kind || "page");
    return obj.layout;
  }
  function attrSelector(name, value) {
    return "[" + name + "=\"" + String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"]";
  }
  function directChild(root, className) {
    if (!root) return null;
    for (var i = 0; i < root.children.length; i++) {
      if (root.children[i].classList && root.children[i].classList.contains(className)) return root.children[i];
    }
    return null;
  }
  function selectedBlockTarget(mount) {
    if (sel.type === "page") {
      var page = C.findPage(project, sel.id);
      if (!page) return null;
      return { kind: "page", obj: page, layout: ensureBlockLayout(page, "page"), root: mount.querySelector(".cyoa-page" + attrSelector("data-page-id", sel.id)) };
    }
    if (sel.type === "row") {
      var row = findRow(sel.id);
      if (!row) return null;
      return { kind: "row", obj: row, layout: ensureBlockLayout(row, "row"), root: mount.querySelector(".cyoa-row" + attrSelector("data-row-id", sel.id)) };
    }
    return null;
  }

  /* ---------------- 선택 ---------------- */
  function select(type, id) {
    sel = { type: type, id: id };
    if (type === "start") editPageId = null;
    else if (type === "page") editPageId = id;
    else if (type === "row") editPageId = pageOfRow(id);
    else if (type === "choice") editPageId = pageOfChoice(id);
    else if (type === "link") { var f = findLink(id); if (f) editPageId = f.page.id; }
    renderAll();
  }

  /* ---------------- 전체 렌더 ---------------- */
  function renderAll() { renderTree(); renderCanvas(); renderInspector(); }
  function softRefresh() { renderTree(); renderCanvas(); autosave(); }  // 인스펙터는 유지(포커스 보존)

  /* =========================================================
     트리
     ========================================================= */
  function treeNode(label, typeLabel, active, onClick) {
    var n = el("div", "tree-node" + (active ? " active" : ""));
    n.appendChild(el("span", "node-label", C.escapeHtml(label)));
    if (typeLabel) n.appendChild(el("span", "node-type", typeLabel));
    n.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return n;
  }
  function ctrlRow(items) {
    var w = el("div", "tree-ctrl");
    items.forEach(function (it) { w.appendChild(it); });
    return w;
  }
  function miniBtn(label, title, onClick) {
    var b = el("button", "btn btn-sm ghost", label);
    b.title = title || ""; b.style.padding = "1px 7px";
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }
  function moveInArray(arr, idx, dir) {
    var j = idx + dir;
    if (j < 0 || j >= arr.length) return false;
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp; return true;
  }
  function reorderHandle(tag) {
    var h = el(tag || "button", "reorder-handle", "⋮⋮");
    if (!tag || tag === "button") h.type = "button";
    h.title = "드래그해서 순서 변경";
    h.setAttribute("aria-label", "순서 변경");
    return h;
  }
  function clearReorderMarkers(scope) {
    (scope || document).querySelectorAll(".reorder-dragging, .reorder-drop-before, .reorder-drop-after, .drag-over").forEach(function (n) {
      n.classList.remove("reorder-dragging", "reorder-drop-before", "reorder-drop-after", "drag-over");
    });
  }
  function dropIndexFromPointer(items, pointerX, pointerY, horizontal) {
    var idx = items.length;
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      var mid = horizontal ? (r.left + r.width / 2) : (r.top + r.height / 2);
      var pos = horizontal ? pointerX : pointerY;
      if (pos < mid) { idx = i; break; }
    }
    return idx;
  }
  function markDrop(items, idx, horizontal) {
    items.forEach(function (n) { n.classList.remove("reorder-drop-before", "reorder-drop-after"); });
    if (!items.length) return;
    if (idx >= items.length) items[items.length - 1].classList.add("reorder-drop-after");
    else items[idx].classList.add("reorder-drop-before");
  }
  function dropIndexFromRects(items, pointerX, pointerY) {
    if (!items.length) return 0;
    var rows = [];
    items.forEach(function (node, index) {
      var r = node.getBoundingClientRect();
      var row = rows.find(function (x) { return Math.abs(x.top - r.top) < 8; });
      if (!row) {
        row = { top: r.top, bottom: r.bottom, items: [] };
        rows.push(row);
      }
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
      row.items.push({ index: index, rect: r });
    });
    rows.sort(function (a, b) { return a.top - b.top; });
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      row.items.sort(function (a, b) { return a.rect.left - b.rect.left; });
      if (pointerY < row.top) return row.items[0].index;
      if (pointerY <= row.bottom) {
        for (var ii = 0; ii < row.items.length; ii++) {
          var item = row.items[ii];
          if (pointerX < item.rect.left + item.rect.width / 2) return item.index;
        }
        return row.items[row.items.length - 1].index + 1;
      }
    }
    return items.length;
  }
  function applyReorder(arr, fromIndex, dropIndex) {
    if (!arr || fromIndex < 0 || fromIndex >= arr.length) return false;
    var item = arr.splice(fromIndex, 1)[0];
    var toIndex = Math.max(0, Math.min(arr.length, dropIndex));
    arr.splice(toIndex, 0, item);
    return true;
  }
  var treeDragState = null;
  function finishReorderSelection(type, id) {
    select(type, id);
    autosave();
  }
  function makeTreeReorderable(node, arr, index, type, id) {
    var grip = reorderHandle();
    node.insertBefore(grip, node.firstChild);
    // 계획대로: 노드 전체를 드래그 대상으로 쓰되, 시작은 핸들(⋮⋮)에서만 허용.
    node.draggable = false;
    grip.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); });
    function armDrag() {
      node.draggable = true;
      var reset = function () { node.draggable = false; document.removeEventListener("mouseup", reset); document.removeEventListener("touchend", reset); };
      document.addEventListener("mouseup", reset);
      document.addEventListener("touchend", reset);
    }
    grip.addEventListener("mousedown", armDrag);
    grip.addEventListener("touchstart", armDrag, { passive: true });
    node.addEventListener("dragstart", function (e) {
      if (!node.draggable) { e.preventDefault(); return; }   // 핸들 외 영역에서 시작 차단
      e.stopPropagation();
      treeDragState = { arr: arr, fromIndex: index, type: type, id: id };
      node.classList.add("reorder-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", type + ":" + id);
      }
    });
    node.addEventListener("dragend", function () {
      node.draggable = false;
      treeDragState = null;
      clearReorderMarkers($tree);
    });
    node.addEventListener("dragover", function (e) {
      if (!treeDragState || treeDragState.arr !== arr) return;
      e.preventDefault();
      $tree.querySelectorAll(".reorder-drop-before, .reorder-drop-after, .drag-over").forEach(function (n) {
        n.classList.remove("reorder-drop-before", "reorder-drop-after", "drag-over");
      });
      var r = node.getBoundingClientRect();
      node.classList.toggle("reorder-drop-before", e.clientY < r.top + r.height / 2);
      node.classList.toggle("reorder-drop-after", e.clientY >= r.top + r.height / 2);
    });
    node.addEventListener("dragleave", function () {
      node.classList.remove("reorder-drop-before", "reorder-drop-after");
    });
    node.addEventListener("drop", function (e) {
      if (!treeDragState || treeDragState.arr !== arr) return;
      e.preventDefault();
      if (index === treeDragState.fromIndex) {
        treeDragState = null;
        clearReorderMarkers($tree);
        return;
      }
      var r = node.getBoundingClientRect();
      var after = e.clientY >= r.top + r.height / 2;
      var dropIndex = index;
      if (index > treeDragState.fromIndex) dropIndex -= 1;
      if (after) dropIndex += 1;
      var moved = applyReorder(arr, treeDragState.fromIndex, dropIndex);
      var drag = treeDragState;
      treeDragState = null;
      clearReorderMarkers($tree);
      if (moved) finishReorderSelection(drag.type, drag.id);
    });
    return node;
  }
  function attachCanvasReorderItem(node, arr, index, type, id, getItems) {
    var grip = reorderHandle(type === "link" ? "span" : "button");
    node.appendChild(grip);
    grip.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      var started = false;
      var dropIndex = index;
      var sx = e.clientX, sy = e.clientY;
      function currentTargets() {
        return getItems().filter(function (item) { return item !== node; });
      }
      function mv(ev) {
        if (!started && Math.max(Math.abs(ev.clientX - sx), Math.abs(ev.clientY - sy)) < 4) return;
        started = true;
        node.classList.add("reorder-dragging");
        var targets = currentTargets();
        dropIndex = dropIndexFromRects(targets, ev.clientX, ev.clientY);
        markDrop(targets, dropIndex);
      }
      function up() {
        document.removeEventListener("pointermove", mv);
        document.removeEventListener("pointerup", up);
        clearReorderMarkers($canvas);
        if (!started) return;
        if (applyReorder(arr, index, dropIndex)) finishReorderSelection(type, id);
      }
      document.addEventListener("pointermove", mv);
      document.addEventListener("pointerup", up);
    });
  }
  function attachCanvasReorderEditor(mount) {
    var pageId = editPageId || (project.settings && project.settings.startPageId);
    var page = C.findPage(project, pageId);
    if (!page) return;
    var pageRoot = mount.querySelector(".cyoa-page" + attrSelector("data-page-id", page.id));
    if (!pageRoot) return;

    function rowNodes() {
      return Array.prototype.slice.call(pageRoot.querySelectorAll(".cyoa-row[data-row-id]"));
    }
    if (page.rows && page.rows.length) {
      rowNodes().forEach(function (rowNode) {
        var rowId = rowNode.dataset.rowId;
        var rowIndex = page.rows.findIndex(function (r) { return r.id === rowId; });
        if (rowIndex >= 0) attachCanvasReorderItem(rowNode, page.rows, rowIndex, "row", rowId, rowNodes);

        var row = page.rows[rowIndex];
        if (!row) return;
        function choiceNodes() {
          return Array.prototype.slice.call(rowNode.querySelectorAll(".choice[data-choice-id]"));
        }
        choiceNodes().forEach(function (choiceNode) {
          var choiceId = choiceNode.dataset.choiceId;
          var choiceIndex = (row.choices || []).findIndex(function (c) { return c.id === choiceId; });
          if (choiceIndex >= 0) attachCanvasReorderItem(choiceNode, row.choices, choiceIndex, "choice", choiceId, choiceNodes);
        });
      });
    }

    function linkNodes() {
      return Array.prototype.slice.call(pageRoot.querySelectorAll(".nav-link[data-link-uid]"));
    }
    linkNodes().forEach(function (linkNode) {
      var uid = linkNode.dataset.linkUid;
      var linkIndex = (page.links || []).findIndex(function (l) { return l._uid === uid; });
      if (linkIndex >= 0) attachCanvasReorderItem(linkNode, page.links, linkIndex, "link", uid, linkNodes);
    });
  }

  function renderTree() {
    clear($tree);
    var startNode = treeNode("오프닝", "시작", sel.type === "start", function () { select("start", null); });
    $tree.appendChild(startNode);

    var addPageBtn = el("span", "tree-add", "＋ 페이지 추가");
    addPageBtn.addEventListener("click", addPage);
    $tree.appendChild(addPageBtn);

    project.pages.forEach(function (page, pi) {
      var node = treeNode(page.title || "(페이지)", page.type === "build" ? "빌드" : "서사",
        sel.type === "page" && sel.id === page.id, function () { select("page", page.id); });
      makeTreeReorderable(node, project.pages, pi, "page", page.id);
      $tree.appendChild(node);
      // 페이지 컨트롤
      $tree.appendChild(ctrlRow([
        miniBtn("↑", "위로", function () { if (moveInArray(project.pages, pi, -1)) softRefresh(); }),
        miniBtn("↓", "아래로", function () { if (moveInArray(project.pages, pi, 1)) softRefresh(); }),
        miniBtn("🗑", "삭제", function () { deletePage(page.id); })
      ]));

      var children = el("div", "tree-children");
      // 행(선택지 묶음)은 서사·빌드 페이지 모두 — 유형과 무관하게 추가/편집
      (page.rows || []).forEach(function (row, ri) {
        var rn = treeNode(row.title || "(행)", "행", sel.type === "row" && sel.id === row.id, function () { select("row", row.id); });
        makeTreeReorderable(rn, page.rows, ri, "row", row.id);
        children.appendChild(rn);
        children.appendChild(ctrlRow([
          miniBtn("↑", "위로", function () { if (moveInArray(page.rows, ri, -1)) softRefresh(); }),
          miniBtn("↓", "아래로", function () { if (moveInArray(page.rows, ri, 1)) softRefresh(); }),
          miniBtn("🗑", "삭제", function () { if (confirm("행을 삭제할까요?")) { page.rows.splice(ri, 1); select("page", page.id); autosave(); } })
        ]));
        var gchildren = el("div", "tree-children");
        (row.choices || []).forEach(function (ch, ci) {
          var cn = treeNode(ch.title || "(선택지)", "선택", sel.type === "choice" && sel.id === ch.id, function () { select("choice", ch.id); });
          makeTreeReorderable(cn, row.choices, ci, "choice", ch.id);
          gchildren.appendChild(cn);
          gchildren.appendChild(ctrlRow([
            miniBtn("↑", "위로", function () { if (moveInArray(row.choices, ci, -1)) softRefresh(); }),
            miniBtn("↓", "아래로", function () { if (moveInArray(row.choices, ci, 1)) softRefresh(); }),
            miniBtn("🗑", "삭제", function () { row.choices.splice(ci, 1); select("row", row.id); autosave(); })
          ]));
        });
        var addCh = el("span", "tree-add", "＋ 선택지");
        addCh.addEventListener("click", function () { addChoice(row); });
        gchildren.appendChild(addCh);
        children.appendChild(gchildren);
      });
      var addRowBtn = el("span", "tree-add", "＋ 행 추가");
      addRowBtn.addEventListener("click", function () { addRow(page); });
      children.appendChild(addRowBtn);

      // 링크(페이지 이동)
      (page.links || []).forEach(function (lnk, li) {
        if (!lnk._uid) lnk._uid = C.genId("lnk");
        var ln = treeNode("→ " + (lnk.label || "(링크)"), "이동", sel.type === "link" && sel.id === lnk._uid, function () { select("link", lnk._uid); });
        makeTreeReorderable(ln, page.links, li, "link", lnk._uid);
        children.appendChild(ln);
        children.appendChild(ctrlRow([
          miniBtn("↑", "위로", function () { if (moveInArray(page.links, li, -1)) softRefresh(); }),
          miniBtn("↓", "아래로", function () { if (moveInArray(page.links, li, 1)) softRefresh(); }),
          miniBtn("🗑", "삭제", function () { page.links.splice(li, 1); select("page", page.id); autosave(); })
        ]));
      });
      var addLinkBtn = el("span", "tree-add", "＋ 이동 링크");
      addLinkBtn.addEventListener("click", function () { addLink(page); });
      children.appendChild(addLinkBtn);

      $tree.appendChild(children);
    });
  }

  /* =========================================================
     캔버스
     ========================================================= */
  // 미리보기 BGM
  var _pvAudio = null, _pvSrc = null, _pvMuted = false;
  function updatePreviewAudio() {
    if (!previewOpen || !previewStarted) { if (_pvAudio) _pvAudio.pause(); return; }
    if (!_pvAudio) { _pvAudio = new Audio(); _pvAudio.loop = true; _pvAudio.volume = 0.6; }
    var a = C.pageAudio(project, pstate);
    if (a.action === "stop") { _pvAudio.pause(); _pvSrc = null; return; }
    if (a.action === "play") {
      if (a.src !== _pvSrc) { _pvSrc = a.src; _pvAudio.src = a.src; if (!_pvMuted) _pvAudio.play().catch(function () {}); }
      else if (!_pvMuted && _pvAudio.paused) _pvAudio.play().catch(function () {});
      return;
    }
    if (!_pvMuted && _pvAudio.src && _pvAudio.paused) _pvAudio.play().catch(function () {});
  }

  function ensureStartLayout() {
    if (!project.start) project.start = {};
    project.start.layout = C.normalizeStartLayout(project.start.layout);
    return project.start.layout;
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function startLayoutVarName(key) {
    return {
      cardX: "--start-card-x", cardY: "--start-card-y", cardWidth: "--start-card-width",
      paddingX: "--start-padding-x", paddingY: "--start-padding-y",
      gapImageTitle: "--start-gap-image-title", gapTitleSubtitle: "--start-gap-title-subtitle",
      gapSubtitleText: "--start-gap-subtitle-text", gapTextActions: "--start-gap-text-actions",
      gapActionsHint: "--start-gap-actions-hint"
    }[key];
  }
  function setStartLayoutVar(screen, key, value) {
    var css = startLayoutVarName(key);
    if (!css) return;
    var unit = (key === "cardX" || key === "cardY") ? "%" : "px";
    screen.style.setProperty(css, value + unit);
  }
  function startPresetLayout(name) {
    var L = C.defaultStartLayout();
    if (name === "top-title") {
      L.cardY = 30; L.cardWidth = 720; L.paddingY = 34; L.gapTextActions = 22;
    } else if (name === "bottom-bg") {
      L.cardY = 72; L.cardWidth = 680; L.paddingY = 34; L.gapTextActions = 22;
    } else if (name === "image-card") {
      L.cardWidth = 680; L.paddingX = 34; L.paddingY = 36; L.gapImageTitle = 30; L.gapTextActions = 24;
    }
    L.preset = name;
    return L;
  }
  function applyStartPreset(name) {
    if (!project.start) project.start = {};
    project.start.layout = startPresetLayout(name);
    if (name === "bottom-bg" && project.start.image) project.start.imageMode = "background";
    if (name === "image-card" && project.start.image) project.start.imageMode = "card";
    renderInspector();
    softRefresh();
  }
  /* ===== 정렬 가이드 + 스냅 엔진 (Canva식) =====
     좌표 공간은 호출자가 정함(보통 캔버스-로컬 px). 순수 기하 → 단위테스트 가능. */
  function uniqNum(arr) {
    var out = [];
    arr.forEach(function (v) { if (!out.some(function (x) { return Math.abs(x - v) < 0.5; })) out.push(v); });
    return out;
  }
  // moving/others/container: { left, top, width, height }
  // 반환: { dx, dy, vLines:[x..], hLines:[y..] } — moving 위치에 dx,dy 더하면 정렬에 스냅
  function computeSnap(moving, others, container, threshold) {
    threshold = threshold || 6;
    var candX = [], candY = [];
    var sources = others.slice();
    if (container) sources.push(container);
    sources.forEach(function (s) {
      candX.push(s.left, s.left + s.width / 2, s.left + s.width);
      candY.push(s.top, s.top + s.height / 2, s.top + s.height);
    });
    var mX = [moving.left, moving.left + moving.width / 2, moving.left + moving.width];
    var mY = [moving.top, moving.top + moving.height / 2, moving.top + moving.height];
    var bestX = null, bestY = null;
    mX.forEach(function (e) { candX.forEach(function (c) { var d = c - e; if (Math.abs(d) <= threshold && (bestX === null || Math.abs(d) < Math.abs(bestX))) bestX = d; }); });
    mY.forEach(function (e) { candY.forEach(function (c) { var d = c - e; if (Math.abs(d) <= threshold && (bestY === null || Math.abs(d) < Math.abs(bestY))) bestY = d; }); });
    var dx = bestX || 0, dy = bestY || 0;
    var vLines = [], hLines = [];
    if (bestX !== null) { var me = mX.map(function (e) { return e + dx; }); candX.forEach(function (c) { if (me.some(function (e) { return Math.abs(e - c) < 0.5; })) vLines.push(c); }); }
    if (bestY !== null) { var me2 = mY.map(function (e) { return e + dy; }); candY.forEach(function (c) { if (me2.some(function (e) { return Math.abs(e - c) < 0.5; })) hLines.push(c); }); }
    return { dx: dx, dy: dy, vLines: uniqNum(vLines), hLines: uniqNum(hLines) };
  }
  // 캔버스 위에 가이드선 그리기/지우기 (overlay: position:relative 컨테이너, 좌표는 그 안의 px)
  function drawAlignGuides(overlay, vLines, hLines) {
    clearAlignGuides(overlay);
    vLines.forEach(function (x) { var g = el("div", "align-guide align-v"); g.style.left = x + "px"; overlay.appendChild(g); });
    hLines.forEach(function (y) { var g = el("div", "align-guide align-h"); g.style.top = y + "px"; overlay.appendChild(g); });
  }
  function clearAlignGuides(overlay) {
    Array.prototype.slice.call(overlay.querySelectorAll(".align-guide")).forEach(function (g) { g.remove(); });
  }

  function rectLocal(elm, screen, scale) {
    var sr = screen.getBoundingClientRect(), r = elm.getBoundingClientRect();
    return { left: (r.left - sr.left) / scale, top: (r.top - sr.top) / scale, width: r.width / scale, height: r.height / scale };
  }
  function attachStartFreeEditor(mount, screen) {
    var hint = el("div", "start-layout-hint", "컴포넌트를 드래그해 배치 · 다른 요소·중앙에 맞으면 가이드선");
    screen.appendChild(hint);
    var comps = Array.prototype.slice.call(screen.querySelectorAll(".start-comp"));
    comps.forEach(function (compEl) {
      compEl.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        var scale = previewInteractionScale(compEl);
        var sr = screen.getBoundingClientRect();
        var screenW = sr.width / scale, screenH = sr.height / scale;
        var mr = rectLocal(compEl, screen, scale);
        var startLeft = mr.left, startTop = mr.top, wpx = mr.width, hpx = mr.height;
        var others = comps.filter(function (c) { return c !== compEl; }).map(function (c) { return rectLocal(c, screen, scale); });
        var container = { left: 0, top: 0, width: screenW, height: screenH };
        var sx = e.clientX, sy = e.clientY;
        var key = compEl.getAttribute("data-comp");
        var L = ensureStartLayout(); if (!L.items) L.items = {}; if (!L.items[key]) L.items[key] = {};
        compEl.classList.add("dragging");
        function mv(ev) {
          var nx = startLeft + (ev.clientX - sx) / scale;
          var ny = startTop + (ev.clientY - sy) / scale;
          var snap = computeSnap({ left: nx, top: ny, width: wpx, height: hpx }, others, container, 6);
          nx = clamp(nx + snap.dx, 0, Math.max(0, screenW - wpx));
          ny = clamp(ny + snap.dy, 0, Math.max(0, screenH - hpx));
          L.items[key].x = round1(nx / screenW * 100);
          L.items[key].y = round1(ny / screenH * 100);
          compEl.style.left = L.items[key].x + "%";
          compEl.style.top = L.items[key].y + "%";
          drawAlignGuides(screen, snap.vLines, snap.hLines);
          autosave();
        }
        function up() {
          compEl.classList.remove("dragging");
          clearAlignGuides(screen);
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
    });
  }

  function attachStartLayoutEditor(mount) {
    var screen = mount.querySelector(".start-screen");
    if (!screen) return;
    var L0 = ensureStartLayout();
    if (L0.free) { attachStartFreeEditor(mount, screen); return; }
    var card = mount.querySelector(".start-card");
    if (!card) return;
    var L = L0;
    var hint = el("div", "start-layout-hint", "카드 드래그 · 점선 드래그로 간격 조정");
    screen.appendChild(hint);

    function positionBounds() {
      var sr = screen.getBoundingClientRect();
      var cr = card.getBoundingClientRect();
      var minX = clamp((cr.width / 2 + 12) / Math.max(sr.width, 1) * 100, 5, 50);
      var minY = clamp((cr.height / 2 + 12) / Math.max(sr.height, 1) * 100, 5, 50);
      return { minX: minX, maxX: 100 - minX, minY: minY, maxY: 100 - minY };
    }
    card.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || e.target.closest(".start-gap-handle")) return;
      if (e.target.closest(".start-actions .btn")) return;
      e.preventDefault();
      var sr = screen.getBoundingClientRect();
      var b = positionBounds();
      var sx = e.clientX, sy = e.clientY, startX = L.cardX, startY = L.cardY;
      card.classList.add("dragging");
      function mv(ev) {
        L.cardX = round1(clamp(startX + ((ev.clientX - sx) / Math.max(sr.width, 1)) * 100, b.minX, b.maxX));
        L.cardY = round1(clamp(startY + ((ev.clientY - sy) / Math.max(sr.height, 1)) * 100, b.minY, b.maxY));
        L.preset = "custom";
        setStartLayoutVar(screen, "cardX", L.cardX);
        setStartLayoutVar(screen, "cardY", L.cardY);
        autosave();
        positionGapHandles();
      }
      function up() {
        card.classList.remove("dragging");
        document.removeEventListener("pointermove", mv);
        document.removeEventListener("pointerup", up);
        renderInspector();
      }
      document.addEventListener("pointermove", mv);
      document.addEventListener("pointerup", up);
    });

    var handles = [];
    function addGapHandle(key, label, a, b, max) {
      if (!a || !b) return;
      var h = el("div", "start-gap-handle");
      h.setAttribute("data-label", label);
      h._gap = { key: key, a: a, b: b, max: max || 160 };
      h.addEventListener("pointerdown", function (e) {
        e.preventDefault(); e.stopPropagation();
        var start = Number(L[key]) || 0, sy = e.clientY;
        var pointerScale = previewInteractionScale(h);
        function mv(ev) {
          L[key] = Math.round(clamp(start + (ev.clientY - sy) / pointerScale, 0, h._gap.max));
          L.preset = "custom";
          setStartLayoutVar(screen, key, L[key]);
          autosave();
          positionGapHandles();
        }
        function up() {
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          renderInspector();
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
      card.appendChild(h);
      handles.push(h);
    }
    function positionGapHandles() {
      var frameScale = previewInteractionScale(card);
      handles.forEach(function (h) {
        var cr = card.getBoundingClientRect();
        var ar = h._gap.a.getBoundingClientRect();
        var br = h._gap.b.getBoundingClientRect();
        h.style.top = (((ar.bottom + br.top) / 2 - cr.top) / frameScale) + "px";
      });
    }
    var image = card.querySelector(".start-image");
    var title = card.querySelector(".start-title");
    var author = card.querySelector(".start-author");
    var desc = card.querySelector(".start-desc");
    var actions = card.querySelector(".start-actions");
    var hintEl = card.querySelector(".start-hint");
    addGapHandle("gapImageTitle", "이미지-제목", image, title, 140);
    addGapHandle("gapTitleSubtitle", "제목-부제목", title, author, 120);
    addGapHandle("gapSubtitleText", author ? "부제목-본문" : "제목-본문", author || title, desc, 140);
    addGapHandle("gapTextActions", desc ? "본문-버튼" : author ? "부제목-버튼" : "제목-버튼", desc || author || title, actions, 160);
    addGapHandle("gapActionsHint", "버튼-힌트", actions, hintEl, 120);
    positionGapHandles();
    if (image && !image.complete) image.addEventListener("load", positionGapHandles, { once: true });
  }

  function setBlockLayoutValue(target, key, value) {
    target.layout[key] = value;
    target.obj.layout = C.normalizeBlockLayout(target.layout, target.kind);
    target.layout = target.obj.layout;
  }
  function blockAlignMargins(align) {
    if (align === "left") return { left: "0", right: "auto" };
    if (align === "right") return { left: "auto", right: "0" };
    return { left: "auto", right: "auto" };
  }
  function blockContentEl(root, kind, media) {
    if (media) return directChild(media, "lay-content") || directChild(media, "story-text") || directChild(media, "row-head");
    return kind === "page" ? directChild(root, "story-text") : directChild(root, "row-head");
  }
  function blockSideBySide(layout) {
    return layout.imagePos === "left" || layout.imagePos === "right";
  }
  function applyTextBoxLive(content, L, sideBySide) {
    if (!content) return;
    content.classList.add("layout-text-box");
    content.style.textAlign = L.textAlign || "left";
    if (sideBySide) {
      content.style.width = "";
      content.style.marginLeft = "";
      content.style.marginRight = "";
      return;
    }
    var m = blockAlignMargins(L.textBoxAlign);
    content.style.width = L.textWidth + "%";
    content.style.marginLeft = m.left;
    content.style.marginRight = m.right;
  }
  function applyBlockLayoutLive(target) {
    var root = target.root, L = target.layout;
    if (!root) return;
    root.style.setProperty("--block-gap", L.blockGap + "px");
    var media = directChild(root, "lay");
    var content = blockContentEl(root, target.kind, media);
    applyTextBoxLive(content, L, media && blockSideBySide(L));
    if (media) {
      media.style.gap = L.imageGap + "px";
      var iw = directChild(media, "img-wrap");
      if (!iw) return;
      var img = iw.querySelector("img.el-img");
      iw.style.margin = "0";
      if (blockSideBySide(L)) {
        iw.style.width = "";
        iw.style.flex = "0 0 " + L.imageWidth + "%";
        iw.style.maxWidth = L.imageWidth + "%";
        iw.style.marginLeft = "";
        iw.style.marginRight = "";
      } else {
        iw.style.flex = "";
        iw.style.maxWidth = "";
        iw.style.width = L.imageWidth + "%";
        iw.style.marginLeft = L.imageAlign === "left" ? "0" : "auto";
        iw.style.marginRight = L.imageAlign === "right" ? "0" : "auto";
      }
      if (img) {
        if (L.imageHeight > 0) {
          img.style.height = L.imageHeight + "px";
          img.style.objectFit = "cover";
        } else {
          img.style.height = "";
          img.style.objectFit = "";
        }
      }
    }
  }
  function attachBlockLayoutEditor(mount) {
    var target = selectedBlockTarget(mount);
    if (!target || !target.root) return;
    var root = target.root;
    var handles = [];
    var media = directChild(root, "lay");

    function firstContentAfterTitle() {
      var title = directChild(root, "page-title");
      if (!title) return null;
      for (var i = 0; i < root.children.length; i++) {
        var child = root.children[i];
        if (child === title) continue;
        if (child.classList && (child.classList.contains("layout-gap-handle") || child.classList.contains("layout-drag-hint"))) continue;
        return child;
      }
      return null;
    }
    function blockGapElements() {
      if (target.kind === "page") return { a: directChild(root, "page-title"), b: firstContentAfterTitle() };
      return { a: media || directChild(root, "row-head"), b: directChild(root, "choice-grid") };
    }
    function positionHandle(h) {
      var a = h._layout.a, b = h._layout.b;
      if (!a || !b || !a.isConnected || !b.isConnected) return;
      var rr = root.getBoundingClientRect();
      var ar = a.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      var scale = previewInteractionScale(root);
      if (h._layout.axis === "x") {
        var first = ar.left <= br.left ? ar : br;
        var second = ar.left <= br.left ? br : ar;
        var cx = (first.right + second.left) / 2;
        var top = Math.min(ar.top, br.top), height = Math.max(ar.bottom, br.bottom) - top;
        h.style.left = ((cx - rr.left) / scale - 5) + "px";
        h.style.top = ((top - rr.top) / scale) + "px";
        h.style.width = "10px";
        h.style.height = Math.max(24, height / scale) + "px";
      } else {
        var upper = ar.top <= br.top ? ar : br;
        var lower = ar.top <= br.top ? br : ar;
        var cy = (upper.bottom + lower.top) / 2;
        var left = Math.min(ar.left, br.left), width = Math.max(ar.right, br.right) - left;
        h.style.left = ((left - rr.left) / scale) + "px";
        h.style.top = ((cy - rr.top) / scale - 5) + "px";
        h.style.width = Math.max(36, width / scale) + "px";
        h.style.height = "10px";
      }
    }
    function positionHandles() {
      handles.forEach(positionHandle);
    }
    function alignCandidates(skip) {
      var scale = previewInteractionScale(root);
      var list = [];
      var iw = media && directChild(media, "img-wrap");
      var content = blockContentEl(root, target.kind, media);
      [iw, content].forEach(function (node) {
        if (node && node !== skip && node.isConnected) list.push(rectLocal(node, root, scale));
      });
      return list;
    }
    function alignForRect(rect, container) {
      var center = rect.left + rect.width / 2;
      if (center < container.width * 0.34) return "left";
      if (center > container.width * 0.66) return "right";
      return "center";
    }
    function dragBoxAlign(handle, box, key, label) {
      handle.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var scale = previewInteractionScale(handle);
        var sr = root.getBoundingClientRect();
        var container = { left: 0, top: 0, width: sr.width / scale, height: sr.height / scale };
        var start = rectLocal(box, root, scale);
        var sx = e.clientX;
        root.classList.add("layout-dragging");
        root.setAttribute("data-layout-drop", label + " " + (target.layout[key] || "center"));
        function mv(ev) {
          var moving = { left: start.left + (ev.clientX - sx) / scale, top: start.top, width: start.width, height: start.height };
          var snap = computeSnap(moving, alignCandidates(box), container, 8);
          moving.left = clamp(moving.left + snap.dx, 0, Math.max(0, container.width - moving.width));
          setBlockLayoutValue(target, key, alignForRect(moving, container));
          root.setAttribute("data-layout-drop", label + " " + target.layout[key]);
          applyBlockLayoutLive(target);
          drawAlignGuides(root, snap.vLines, snap.hLines);
          autosave();
          positionHandles();
        }
        function up() {
          root.classList.remove("layout-dragging");
          root.removeAttribute("data-layout-drop");
          clearAlignGuides(root);
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          renderInspector();
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
    }
    function addTextHandles(content) {
      if (!content || (media && blockSideBySide(target.layout))) return;
      var move = el("button", "layout-drag-handle text-move", "↔");
      move.type = "button";
      move.title = "텍스트 상자 정렬";
      var resize = el("button", "layout-drag-handle text-resize", "");
      resize.type = "button";
      resize.title = "텍스트 상자 폭 변경";
      content.appendChild(move);
      content.appendChild(resize);
      dragBoxAlign(move, content, "textBoxAlign", "텍스트");

      resize.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var scale = previewInteractionScale(resize);
        var startW = Number(target.layout.textWidth) || 100;
        var ref = root.getBoundingClientRect().width / scale;
        var sx = e.clientX;
        root.classList.add("layout-dragging");
        function mv(ev) {
          var dx = (ev.clientX - sx) / scale;
          setBlockLayoutValue(target, "textWidth", round1(clamp(startW + (dx / Math.max(ref, 1)) * 100, 20, 100)));
          applyBlockLayoutLive(target);
          autosave();
          positionHandles();
        }
        function up() {
          root.classList.remove("layout-dragging");
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          renderInspector();
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
    }
    function addGapHandle(key, label, a, b, axis, max) {
      if (!a || !b) return;
      var h = el("div", "layout-gap-handle is-" + axis);
      h.setAttribute("data-label", label);
      h._layout = { key: key, a: a, b: b, axis: axis, max: max || 180 };
      h.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var scale = previewInteractionScale(h);
        var start = Number(target.layout[key]) || 0;
        var sx = e.clientX, sy = e.clientY;
        root.classList.add("layout-dragging");
        function mv(ev) {
          var delta = axis === "x" ? (ev.clientX - sx) / scale : (ev.clientY - sy) / scale;
          setBlockLayoutValue(target, key, Math.round(clamp(start + delta, 0, h._layout.max)));
          applyBlockLayoutLive(target);
          autosave();
          positionHandles();
        }
        function up() {
          root.classList.remove("layout-dragging");
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          renderInspector();
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
      root.appendChild(h);
      handles.push(h);
    }
    function addImageHandles(iw) {
      var move = el("button", "layout-drag-handle image-move", "↕");
      move.type = "button";
      move.title = "이미지 위치 변경";
      var align = el("button", "layout-drag-handle image-align", "↔");
      align.type = "button";
      align.title = "이미지 가로 정렬";
      var resize = el("button", "layout-drag-handle image-resize", "");
      resize.type = "button";
      resize.title = "이미지 크기 변경";
      iw.appendChild(move);
      if (!blockSideBySide(target.layout)) iw.appendChild(align);
      iw.appendChild(resize);
      dragBoxAlign(align, iw, "imageAlign", "이미지");

      move.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var sx = e.clientX, sy = e.clientY, nextPos = target.layout.imagePos;
        root.classList.add("layout-dragging");
        root.setAttribute("data-layout-drop", nextPos);
        function mv(ev) {
          var dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (Math.max(Math.abs(dx), Math.abs(dy)) >= 14) {
            nextPos = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "top" : "bottom");
            root.setAttribute("data-layout-drop", nextPos);
          }
        }
        function up() {
          root.classList.remove("layout-dragging");
          root.removeAttribute("data-layout-drop");
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          if (nextPos !== target.layout.imagePos) {
            setBlockLayoutValue(target, "imagePos", nextPos);
            if ((nextPos === "left" || nextPos === "right") && target.layout.imageWidth >= 90) setBlockLayoutValue(target, "imageWidth", 45);
            if ((nextPos === "top" || nextPos === "bottom") && target.layout.imageWidth < 90) setBlockLayoutValue(target, "imageWidth", 100);
            softRefresh();
            renderInspector();
          }
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });

      resize.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var scale = previewInteractionScale(resize);
        var startW = Number(target.layout.imageWidth) || 100;
        var startH = Number(target.layout.imageHeight) || 0;
        var img = iw.querySelector("img.el-img");
        var imgH = img ? img.getBoundingClientRect().height / scale : 0;
        var ref = (media || root).getBoundingClientRect().width / scale;
        var sx = e.clientX, sy = e.clientY;
        root.classList.add("layout-dragging");
        function mv(ev) {
          var dx = (ev.clientX - sx) / scale;
          var dy = (ev.clientY - sy) / scale;
          var sign = 1;
          setBlockLayoutValue(target, "imageWidth", round1(clamp(startW + (dx * sign / Math.max(ref, 1)) * 100, 5, 100)));
          if (startH > 0 || Math.abs(dy) > Math.abs(dx) + 12) {
            setBlockLayoutValue(target, "imageHeight", Math.round(clamp((startH || imgH) + dy, 0, 2000)));
          }
          applyBlockLayoutLive(target);
          autosave();
          positionHandles();
        }
        function up() {
          root.classList.remove("layout-dragging");
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          renderInspector();
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
    }

    var hint = el("div", "layout-drag-hint", target.kind === "page" ? "페이지 이미지/간격 드래그" : "행 이미지/간격 드래그");
    root.appendChild(hint);
    var block = blockGapElements();
    var content = blockContentEl(root, target.kind, media);
    addGapHandle("blockGap", target.kind === "page" ? "제목-콘텐츠" : "콘텐츠-선택지", block.a, block.b, "y", 180);
    addTextHandles(content);
    if (media) {
      var iw = directChild(media, "img-wrap");
      if (iw) addImageHandles(iw);
      if (iw && content) addGapHandle("imageGap", "이미지-텍스트", iw, content, (target.layout.imagePos === "left" || target.layout.imagePos === "right") ? "x" : "y", 160);
      var img = iw && iw.querySelector("img.el-img");
      if (img && !img.complete) img.addEventListener("load", positionHandles, { once: true });
    }
    positionHandles();
  }

  function renderCanvas() {
    $canvasWrap.classList.add("edit-mode");
    $banner.textContent = "편집 모드 — 캔버스의 요소를 클릭하면 오른쪽에서 편집할 수 있어요.";
    if (sel.type === "start") {
      $banner.textContent = (project.start && project.start.layout && project.start.layout.free)
        ? "오프닝 자유 배치 — 각 요소를 드래그해 정렬(가이드선·스냅)하세요."
        : "편집 모드 — 오프닝 카드와 간격을 드래그로 조정할 수 있어요.";
      var startHint = (project.pages || []).some(function (p) { return p.bgm; }) ? "🔊 배경 음악이 포함되어 있어요" : "";
      C.renderStartScreen(project, $canvas, { mode: "preview", inline: true, hint: startHint });
      attachStartLayoutEditor($canvas);
      return;
    }
    if (!project.pages.length) { clear($canvas); $canvas.appendChild(el("p", "empty-inspector", "페이지가 없습니다. 왼쪽에서 추가하세요.")); return; }
    var dummy = C.newState(project);
    C.renderStage(project, dummy, $canvas, {
      mode: "edit",
      pageId: editPageId || project.pages[0].id,
      editSelectedId: sel.id,
      onEditSelect: function (type, id) { sel = { type: type, id: id }; renderTree(); renderCanvas(); renderInspector(); }
    });
    attachBlockLayoutEditor($canvas);
    attachCanvasReorderEditor($canvas);
  }

  /* =========================================================
     우측 플레이어 미리보기
     ========================================================= */
  var _pvPackOpen = false;              // 미리보기 백팩 오버레이 표시
  function previewUsesStartScreen() {
    return !(project.settings && project.settings.startScreen === false);
  }
  function hasPreviewBgm() {
    return !!(project && (project.pages || []).some(function (p) { return p.bgm; }));
  }
  function previewHasProgress() {
    if (!pstate) return false;
    var counts = pstate.counts || {};
    var hasCounts = Object.keys(counts).some(function (k) { return counts[k] > 0; });
    var startId = project.settings && project.settings.startPageId;
    return !!((pstate.selected || []).length || hasCounts || (pstate.history || []).length ||
      (pstate.currentPageId && startId && pstate.currentPageId !== startId));
  }
  function initPreviewState() {
    pstate = C.newState(project);
    previewStarted = !previewUsesStartScreen();
    _pvSrc = null;
    if (_pvAudio) _pvAudio.pause();
  }
  function previewScrollEl() {
    return $inspector.querySelector(".preview-device-viewport") || $inspector.querySelector(".preview-panel-body");
  }
  function capturePreviewScroll() {
    var node = previewScrollEl();
    return node ? node.scrollTop : 0;
  }
  function restorePreviewScroll(top) {
    requestAnimationFrame(function () {
      var node = previewScrollEl();
      if (node) node.scrollTop = Math.max(0, Number(top) || 0);
    });
  }
  function beginPreviewPlay() {
    previewStarted = true;
    renderPreviewPanel({ scrollTop: 0, animatePage: true });
  }
  function resetPreviewToStartPage() {
    pstate = C.newState(project);
    previewStarted = true;
    _pvSrc = null;
    if (_pvAudio) _pvAudio.pause();
    renderPreviewPanel({ scrollTop: 0, animatePage: true });
  }
  function copyPreviewBuildCode() {
    var code = C.encodeBuildCode(pstate);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(function () { toast("미리보기 빌드코드 복사됨"); }, function () {
        prompt("현재 미리보기 빌드코드", code);
      });
    } else {
      prompt("현재 미리보기 빌드코드", code);
    }
  }
  function renderPreviewTopbar(shell) {
    var topbar = el("div", "preview-view-topbar");
    topbar.appendChild(el("span", "title", C.escapeHtml((project.meta && project.meta.title) || "CYOA")));
    var cur = el("div", "currency-bar");
    cur.innerHTML = C.currencyBadgesHTML(project, pstate);
    topbar.appendChild(cur);
    var tools = el("div", "preview-view-tools");
    if (hasPreviewBgm()) {
      var mute = el("button", "btn btn-sm", _pvMuted ? "🔇" : "🔊");
      mute.title = "배경 음악 켜기/끄기";
      mute.addEventListener("click", function () {
        _pvMuted = !_pvMuted;
        if (_pvMuted && _pvAudio) _pvAudio.pause();
        renderPreviewPanel({ preserveScroll: true });
      });
      tools.appendChild(mute);
    }
    var pack = el("button", "btn btn-sm", "🎒");
    pack.title = "백팩 (선택 요약)";
    if (_pvPackOpen) pack.classList.add("primary");
    pack.addEventListener("click", function () { _pvPackOpen = !_pvPackOpen; renderPreviewPanel({ preserveScroll: true }); });
    tools.appendChild(pack);
    var image = el("button", "btn btn-sm", "🖼");
    image.title = "결과 이미지";
    image.addEventListener("click", function () {
      image.disabled = true;
      C.saveResultImage(project, pstate, (project.meta && project.meta.title) || "cyoa").then(function (type) {
        image.disabled = false;
        toast(type === "webp" ? "결과 이미지(WebP) 저장됨" : type === "png" ? "WebP 미지원 → PNG 저장됨" : "이미지 생성 불가");
      }).catch(function () { image.disabled = false; toast("이미지 생성 오류"); });
    });
    tools.appendChild(image);
    if (project.settings && project.settings.enableBuildCode) {
      var code = el("button", "btn btn-sm", "빌드코드");
      code.title = "빌드코드 복사";
      code.addEventListener("click", copyPreviewBuildCode);
      tools.appendChild(code);
    }
    var reset = el("button", "btn btn-sm", "처음으로");
    reset.addEventListener("click", function () {
      if (confirm("미리보기 진행 상황을 초기화할까요?")) resetPreviewToStartPage();
    });
    tools.appendChild(reset);
    topbar.appendChild(tools);
    shell.appendChild(topbar);
  }
  function renderPreviewViewer(surface, panelOpts) {
    panelOpts = panelOpts || {};
    surface.classList.add("preview-view-surface");
    if (!pstate) initPreviewState();
    if (!previewStarted && previewUsesStartScreen()) {
      C.renderStartScreen(project, surface, {
        mode: "play",
        inline: true,
        hasSaved: previewHasProgress(),
        onStart: beginPreviewPlay,
        onResume: beginPreviewPlay,
        onNew: function () { pstate = C.newState(project); beginPreviewPlay(); },
        hint: hasPreviewBgm() ? "🔊 배경 음악이 포함되어 있어요" : ""
      });
      return;
    }
    var shell = el("div", "preview-view-shell");
    surface.appendChild(shell);
    renderPreviewTopbar(shell);
    var stageMount = el("div", "preview-view-stage");
    shell.appendChild(stageMount);
    C.renderStage(project, pstate, stageMount, {
      mode: "play",
      onToggle: function (id) {
        var top = capturePreviewScroll();
        C.toggleChoice(project, pstate, id);
        renderPreviewPanel({ scrollTop: top });
      },
      onCount: function (id, delta) {
        var top = capturePreviewScroll();
        C.changeCount(project, pstate, id, delta);
        renderPreviewPanel({ scrollTop: top });
      },
      onNavigate: function (link) {
        C.navigate(project, pstate, link);
        renderPreviewPanel({ scrollTop: 0, animatePage: true });
      },
      onBack: function () {
        C.goBack(pstate);
        renderPreviewPanel({ scrollTop: 0, animatePage: true });
      },
      onRoll: function (row) {
        var top = capturePreviewScroll();
        var id = C.rollRandomChoice(project, pstate, row);
        renderPreviewPanel({ scrollTop: top });
        if (!id) toast("굴릴 수 있는 선택지가 없습니다.");
      },
      animatePage: !!panelOpts.animatePage
    });
    if (_pvPackOpen) {
      var bp = el("div", "preview-backpack");
      var bh = el("div", "backpack-head");
      bh.appendChild(el("strong", null, "🎒 내 선택"));
      var bx = el("button", "btn btn-sm", "✕");
      bx.addEventListener("click", function () { _pvPackOpen = false; renderPreviewPanel({ preserveScroll: true }); });
      bh.appendChild(bx);
      bp.appendChild(bh);
      var bm = el("div", "backpack-body");
      C.renderBackpackPanel(project, pstate, bm, {
        onRemove: function (id) {
          var top = capturePreviewScroll();
          C.toggleChoice(project, pstate, id);
          renderPreviewPanel({ scrollTop: top });
        }
      });
      bp.appendChild(bm);
      shell.appendChild(bp);
    }
  }
  function renderPreviewPanel(opts) {
    opts = opts || {};
    if (!previewOpen) return;
    var top = Object.prototype.hasOwnProperty.call(opts, "scrollTop") ? opts.scrollTop : capturePreviewScroll();
    $inspector.classList.add("preview-active");
    clear($inspector);
    var panel = el("div", "preview-panel");
    var head = el("div", "preview-panel-head");
    head.appendChild(el("strong", "preview-panel-title", "플레이어 미리보기"));
    appendPreviewDeviceControls(head);
    var close = el("button", "btn btn-sm", "✕");
    close.title = "미리보기 닫기";
    close.addEventListener("click", togglePreview);
    head.appendChild(close);
    panel.appendChild(head);
    var body = el("div", "preview-panel-body");
    panel.appendChild(body);
    $inspector.appendChild(panel);
    renderPreviewSurface(body, function (surface) { renderPreviewViewer(surface, opts); });
    restorePreviewScroll(top);
    updatePreviewAudio();
  }

  /* =========================================================
     인스펙터
     ========================================================= */
  function field(labelText, inputEl) {
    var f = el("div", "field");
    if (labelText) f.appendChild(el("label", null, labelText));
    f.appendChild(inputEl);
    return f;
  }
  function textInput(value, oninput, placeholder) {
    var i = el("input"); i.type = "text"; i.value = value || ""; if (placeholder) i.placeholder = placeholder;
    i.addEventListener("input", function () { oninput(i.value); });
    return i;
  }
  function numInput(value, oninput) {
    var i = el("input"); i.type = "number"; i.value = (value == null ? "" : value);
    i.addEventListener("input", function () { oninput(i.value === "" ? 0 : Number(i.value)); });
    return i;
  }
  function textArea(value, oninput) {
    var t = el("textarea"); t.value = value || "";
    t.addEventListener("input", function () { oninput(t.value); });
    return t;
  }
  function selectInput(options, value, oninput) {
    var s = el("select");
    options.forEach(function (o) {
      var op = el("option", null, C.escapeHtml(o.label)); op.value = o.value;
      if (o.value === value) op.selected = true; s.appendChild(op);
    });
    s.addEventListener("change", function () { oninput(s.value); });
    return s;
  }
  /* ===== 이미지 편집 (크롭·리사이즈·회전) ===== */
  // 순수 헬퍼
  function clampCrop(crop, W, H) {
    var c = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    c.w = Math.max(8, Math.min(c.w, W));
    c.h = Math.max(8, Math.min(c.h, H));
    c.x = Math.max(0, Math.min(c.x, W - c.w));
    c.y = Math.max(0, Math.min(c.y, H - c.h));
    return c;
  }
  function applyAspect(crop, aspect, W, H) {
    if (!aspect) return clampCrop(crop, W, H);
    var c = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    c.h = c.w / aspect;
    if (c.y + c.h > H) { c.h = H - c.y; c.w = c.h * aspect; }
    if (c.x + c.w > W) { c.w = W - c.x; c.h = c.w / aspect; }
    return clampCrop(c, W, H);
  }
  function outDims(crop, maxWidth) {
    var outW = Math.min(maxWidth || crop.w, crop.w);
    return { w: Math.round(outW), h: Math.round(outW * (crop.h / crop.w)) };
  }
  function webpSupported() {
    var c = document.createElement("canvas"); c.width = c.height = 1;
    return c.toDataURL("image/webp").indexOf("data:image/webp") === 0;
  }
  function dataUrlKB(url) { var i = url.indexOf(","); return Math.round((url.length - i - 1) * 0.75 / 1024); }
  function encodeImage(work, crop, opts) {
    var d = outDims(crop, opts.maxWidth);
    var c = document.createElement("canvas"); c.width = d.w; c.height = d.h;
    c.getContext("2d").drawImage(work, crop.x, crop.y, crop.w, crop.h, 0, 0, d.w, d.h);
    var mime = opts.format || "image/png";
    var url = c.toDataURL(mime, mime !== "image/png" ? (opts.quality || 0.85) : undefined);
    if (mime === "image/webp" && url.indexOf("data:image/webp") !== 0) url = c.toDataURL("image/png");
    return url;
  }

  function openImageEditor(src, onApply) {
    var img = new Image();
    img.onload = function () { build(); };
    img.onerror = function () { toast("이미지를 불러올 수 없습니다."); };
    img.src = src;

    function build() {
      var work = document.createElement("canvas");
      work.width = img.naturalWidth; work.height = img.naturalHeight;
      work.getContext("2d").drawImage(img, 0, 0);

      var hasWebp = webpSupported();
      var aspect = null;
      var crop = { x: 0, y: 0, w: work.width, h: work.height };
      var opts = { maxWidth: Math.min(work.width, 1600), format: hasWebp ? "image/webp" : "image/png", quality: 0.85 };
      var dispScale = 1, dispW = 0, dispH = 0;

      var back = el("div", "modal-backdrop open");
      var m = el("div", "modal modal-wide");
      m.appendChild(el("h2", null, "이미지 편집"));

      var stage = el("div", "ie-stage");
      var dispCanvas = el("canvas"); stage.appendChild(dispCanvas);
      var cropEl = el("div", "ie-crop");
      ["nw", "ne", "sw", "se"].forEach(function (cn) { var h = el("div", "ie-handle ie-" + cn); h.setAttribute("data-corner", cn); cropEl.appendChild(h); });
      stage.appendChild(cropEl);
      m.appendChild(stage);

      // 툴바
      var tb = el("div", "ie-toolbar");
      // 종횡비
      var aspWrap = el("div", "field"); aspWrap.appendChild(el("label", null, "종횡비"));
      var aspRow = el("div", "ie-btnrow");
      [["자유", null], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9], ["원본", "orig"]].forEach(function (a) {
        var b = el("button", "btn btn-sm", a[0]);
        b.addEventListener("click", function () {
          aspect = a[1] === "orig" ? (work.width / work.height) : a[1];
          crop = applyAspect(crop, aspect, work.width, work.height); positionCrop(); schedule();
        });
        aspRow.appendChild(b);
      });
      aspWrap.appendChild(aspRow); tb.appendChild(aspWrap);
      // 회전/반전
      var rotWrap = el("div", "field"); rotWrap.appendChild(el("label", null, "회전 / 반전"));
      var rotRow = el("div", "ie-btnrow");
      [["↺", function () { rotate(-1); }], ["↻", function () { rotate(1); }], ["⇆ 좌우", function () { flip(true); }], ["⇅ 상하", function () { flip(false); }]].forEach(function (r) {
        var b = el("button", "btn btn-sm", r[0]); b.addEventListener("click", r[1]); rotRow.appendChild(b);
      });
      rotWrap.appendChild(rotRow); tb.appendChild(rotWrap);
      // 출력
      var outWrap = el("div", "field"); outWrap.appendChild(el("label", null, "출력 (크기·형식·품질)"));
      var outRow = el("div", "ie-outrow");
      var mwInput = el("input"); mwInput.type = "number"; mwInput.value = opts.maxWidth; mwInput.title = "최대 너비(px)";
      mwInput.addEventListener("input", function () { opts.maxWidth = Math.max(16, Number(mwInput.value) || 16); schedule(); });
      var fmtOpts = hasWebp ? [["image/webp", "WebP(투명·작게)"], ["image/jpeg", "JPEG(작게)"], ["image/png", "PNG(원본·투명)"]]
        : [["image/png", "PNG(원본·투명)"], ["image/jpeg", "JPEG(작게)"]];
      var fmtSel = el("select");
      fmtOpts.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; if (o[0] === opts.format) op.selected = true; fmtSel.appendChild(op); });
      fmtSel.addEventListener("change", function () { opts.format = fmtSel.value; qWrap.style.display = (opts.format === "image/png") ? "none" : ""; schedule(); });
      var qWrap = el("span", "ie-quality");
      var qIn = el("input"); qIn.type = "range"; qIn.min = "0.3"; qIn.max = "1"; qIn.step = "0.05"; qIn.value = String(opts.quality);
      qIn.addEventListener("input", function () { opts.quality = Number(qIn.value); schedule(); });
      qWrap.appendChild(el("span", null, "품질")); qWrap.appendChild(qIn);
      qWrap.style.display = (opts.format === "image/png") ? "none" : "";
      outRow.appendChild(mwInput); outRow.appendChild(fmtSel); outRow.appendChild(qWrap);
      outWrap.appendChild(outRow); tb.appendChild(outWrap);
      m.appendChild(tb);

      // 미리보기 + 정보 + 버튼
      var info = el("div", "ie-info");
      var prevImg = el("img", "ie-preview");
      info.appendChild(prevImg);
      var sizeLabel = el("div", "ie-size"); info.appendChild(sizeLabel);
      var resetBtn = el("button", "btn btn-sm ghost", "전체 선택");
      resetBtn.addEventListener("click", function () { crop = applyAspect({ x: 0, y: 0, w: work.width, h: work.height }, aspect, work.width, work.height); positionCrop(); schedule(); });
      info.appendChild(resetBtn);
      m.appendChild(info);

      var actions = el("div", "modal-actions");
      var cancel = el("button", "btn", "취소"); cancel.addEventListener("click", close);
      var apply = el("button", "btn primary", "적용");
      apply.addEventListener("click", function () { onApply(encodeImage(work, crop, opts)); close(); });
      actions.appendChild(cancel); actions.appendChild(apply); m.appendChild(actions);

      back.appendChild(m);
      back.addEventListener("click", function (e) { if (e.target === back) close(); });
      document.body.appendChild(back);

      function close() { back.remove(); }

      function recomputeScale() {
        dispScale = Math.min(560 / work.width, 420 / work.height);
        if (dispScale > 2) dispScale = 2;
      }
      function redrawDisp() {
        dispW = Math.round(work.width * dispScale); dispH = Math.round(work.height * dispScale);
        dispCanvas.width = dispW; dispCanvas.height = dispH;
        dispCanvas.getContext("2d").drawImage(work, 0, 0, dispW, dispH);
        stage.style.width = dispW + "px"; stage.style.height = dispH + "px";
        positionCrop();
      }
      function positionCrop() {
        cropEl.style.left = (crop.x * dispScale) + "px";
        cropEl.style.top = (crop.y * dispScale) + "px";
        cropEl.style.width = (crop.w * dispScale) + "px";
        cropEl.style.height = (crop.h * dispScale) + "px";
      }
      function resetCropFull() { crop = applyAspect({ x: 0, y: 0, w: work.width, h: work.height }, aspect, work.width, work.height); }
      function rotate(dir) {
        var nc = el("canvas"); nc.width = work.height; nc.height = work.width;
        var x = nc.getContext("2d"); x.translate(nc.width / 2, nc.height / 2); x.rotate(dir * Math.PI / 2);
        x.drawImage(work, -work.width / 2, -work.height / 2);
        work = nc; if (aspect) aspect = work.width / work.height === 0 ? aspect : aspect; resetCropFull(); recomputeScale(); redrawDisp(); schedule();
      }
      function flip(horizontal) {
        var nc = el("canvas"); nc.width = work.width; nc.height = work.height;
        var x = nc.getContext("2d");
        if (horizontal) { x.translate(work.width, 0); x.scale(-1, 1); } else { x.translate(0, work.height); x.scale(1, -1); }
        x.drawImage(work, 0, 0); work = nc; resetCropFull(); redrawDisp(); schedule();
      }

      // 드래그(이동/리사이즈)
      cropEl.addEventListener("pointerdown", function (e) {
        var corner = e.target.getAttribute && e.target.getAttribute("data-corner");
        if (corner) startResize(e, corner); else startMove(e);
      });
      function startMove(e) {
        e.preventDefault();
        var sx = e.clientX, sy = e.clientY, sc = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
        function mv(ev) {
          crop = clampCrop({ x: sc.x + (ev.clientX - sx) / dispScale, y: sc.y + (ev.clientY - sy) / dispScale, w: sc.w, h: sc.h }, work.width, work.height);
          positionCrop();
        }
        function up() { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); schedule(); }
        document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
      }
      function startResize(e, corner) {
        e.preventDefault(); e.stopPropagation();
        var sx = e.clientX, sy = e.clientY, sc = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
        function mv(ev) {
          var dx = (ev.clientX - sx) / dispScale, dy = (ev.clientY - sy) / dispScale;
          var c = { x: sc.x, y: sc.y, w: sc.w, h: sc.h };
          if (corner.indexOf("e") >= 0) c.w = sc.w + dx;
          if (corner.indexOf("s") >= 0) c.h = sc.h + dy;
          if (corner.indexOf("w") >= 0) { c.x = sc.x + dx; c.w = sc.w - dx; }
          if (corner.indexOf("n") >= 0) { c.y = sc.y + dy; c.h = sc.h - dy; }
          if (c.w < 8) c.w = 8; if (c.h < 8) c.h = 8;
          if (aspect) { var nh = c.w / aspect; if (corner.indexOf("n") >= 0) c.y = sc.y + sc.h - nh; c.h = nh; }
          crop = clampCrop(c, work.width, work.height); positionCrop();
        }
        function up() { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); schedule(); }
        document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
      }

      var schedTimer = null;
      function schedule() { clearTimeout(schedTimer); schedTimer = setTimeout(updatePreview, 120); }
      function updatePreview() {
        var url = encodeImage(work, crop, opts);
        prevImg.src = url;
        var d = outDims(crop, opts.maxWidth);
        sizeLabel.textContent = "출력 " + d.w + "×" + d.h + " · 약 " + dataUrlKB(url) + " KB";
      }

      recomputeScale(); redrawDisp(); updatePreview();
    }
  }

  function imageField(currentVal, onSet) {
    var wrap = el("div", "field");
    wrap.appendChild(el("label", null, "이미지"));
    var row = el("div", "field-inline");
    var inp = el("input"); inp.type = "file"; inp.accept = "image/*"; inp.style.fontSize = "12px";
    inp.addEventListener("change", function () {
      var f = inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { openImageEditor(r.result, function (out) { onSet(out); renderInspector(); }); inp.value = ""; };
      r.readAsDataURL(f);
    });
    row.appendChild(inp);
    if (currentVal) {
      var edit = el("button", "btn btn-sm", "✎ 편집");
      edit.addEventListener("click", function () { openImageEditor(currentVal, function (out) { onSet(out); renderInspector(); }); });
      row.appendChild(edit);
      var rm = el("button", "btn btn-sm danger", "제거");
      rm.addEventListener("click", function () { onSet(null); renderInspector(); });
      row.appendChild(rm);
    }
    wrap.appendChild(row);
    if (currentVal) { var img = el("img", "thumb-preview"); img.src = currentVal; wrap.appendChild(img); }
    return wrap;
  }

  // 페이지 배경 음악(BGM) 편집기
  function bgmEditor(page) {
    var box = el("div");
    var isData = /^data:/.test(page.bgm || "");
    // 파일 업로드
    var fwrap = el("div", "field");
    fwrap.appendChild(el("label", null, "오디오 파일 업로드 (작은 mp3/ogg 권장)"));
    var inp = el("input"); inp.type = "file"; inp.accept = "audio/*"; inp.style.fontSize = "12px";
    inp.addEventListener("change", function () {
      var f = inp.files[0]; if (!f) return;
      if (f.size > 3145728 && !confirm("오디오가 큽니다(" + (f.size / 1048576).toFixed(1) + "MB). 프로젝트 파일에 그대로 담겨 무거워집니다.\n계속할까요? (권장: neocities audio/ 폴더에 올리고 아래 URL/경로 사용)")) { inp.value = ""; return; }
      var r = new FileReader();
      r.onload = function () { page.bgm = r.result; renderInspector(); softRefresh(); };
      r.readAsDataURL(f);
    });
    fwrap.appendChild(inp); box.appendChild(fwrap);
    // URL / 경로
    box.appendChild(field("또는 URL / 경로 (예: audio/theme.mp3)", textInput(isData ? "" : (page.bgm || ""), function (v) { page.bgm = v.trim(); softRefresh(); })));
    // 상태 + 미리듣기 + 제거
    if (page.bgm) {
      var ctl = el("div", "field-inline");
      ctl.appendChild(el("span", "empty-inspector", isData ? "🎵 업로드된 오디오 사용 중" : "🎵 경로/URL 사용 중"));
      var prev = el("button", "btn btn-sm", "▶ 미리듣기"); var a = null;
      prev.addEventListener("click", function () {
        if (a) { a.pause(); a = null; prev.textContent = "▶ 미리듣기"; return; }
        a = new Audio(page.bgm); a.volume = 0.6;
        a.play().then(function () { prev.textContent = "⏸ 정지"; }, function () { toast("재생 불가(경로/형식 확인)"); a = null; });
        a.onended = function () { prev.textContent = "▶ 미리듣기"; a = null; };
      });
      ctl.appendChild(prev);
      var rm = el("button", "btn btn-sm danger", "제거");
      rm.addEventListener("click", function () { page.bgm = ""; renderInspector(); softRefresh(); });
      ctl.appendChild(rm);
      box.appendChild(ctl);
    }
    box.appendChild(checkbox("이 페이지에서 음악 정지 (무음)", page.bgmStop === true, function (c) { page.bgmStop = c; softRefresh(); }));
    var note = el("p", "empty-inspector", "음악을 지정하면 이 페이지부터 재생됩니다. 음악이 없는 페이지는 이전 곡을 이어서 재생해요. (스크롤형은 첫 음악이 전체 배경) 큰 파일은 neocities audio/ 폴더에 올리고 경로로 참조하세요.");
    note.style.cssText = "text-align:left;padding:2px;margin:4px 0 0;";
    box.appendChild(note);
    return box;
  }

  // 점수 편집기 (scores 배열 in-place)
  // allowCond=true(선택지 점수)면 각 항목에 조건(할인/조건부 비용)을 달 수 있다. 링크 점수는 끔.
  function scoresEditor(scores, allowCond) {
    var box = el("div");
    box.appendChild(el("label", null, "점수 (음수=비용, 양수=획득)"));
    var curOpts = project.currencies.map(function (c) { return { value: c.id, label: c.name }; });
    if (!curOpts.length) box.appendChild(el("p", "empty-inspector", "통화가 없습니다(설정에서 추가)."));
    scores.forEach(function (s, i) {
      var wrap = allowCond ? el("div", "score-block") : box;
      var line = el("div", "score-line");
      line.appendChild(selectInput(curOpts, s.currency, function (v) { s.currency = v; softRefresh(); }));
      line.appendChild(numInput(s.value, function (v) { s.value = v; softRefresh(); }));
      var x = el("button", "mini-x", "✕");
      x.addEventListener("click", function () { scores.splice(i, 1); renderInspector(); });
      line.appendChild(x);
      wrap.appendChild(line);
      if (allowCond) {
        // 조건 추가/제거는 캔버스의 "조건부" 뱃지도 즉시 갱신되도록 인스펙터+캔버스 함께 리프레시
        var refreshBoth = function () { renderInspector(); renderCanvas(); autosave(); };
        var hasCond = Array.isArray(s.requirements);
        if (!hasCond) {
          var addCond = el("span", "tree-add", "＋ 조건 (할인/조건부 비용)");
          addCond.addEventListener("click", function () { s.requirements = []; refreshBoth(); });
          wrap.appendChild(addCond);
        } else {
          var condBox = el("div", "score-cond-box");
          var note = el("p", "empty-inspector", "이 조건을 만족할 때만 이 점수가 적용됩니다(예: 특정 선택 시 할인).");
          note.style.cssText = "text-align:left;padding:2px;margin:0 0 4px;";
          condBox.appendChild(note);
          condBox.appendChild(reqEditor(s.requirements, refreshBoth));
          var rmCond = el("button", "btn btn-sm danger", "조건 제거(항상 적용)");
          rmCond.addEventListener("click", function () { delete s.requirements; refreshBoth(); });
          condBox.appendChild(rmCond);
          wrap.appendChild(condBox);
        }
        box.appendChild(wrap);
      }
    });
    if (curOpts.length) {
      var add = el("button", "btn btn-sm", "＋ 점수");
      add.addEventListener("click", function () { scores.push({ currency: project.currencies[0].id, value: 0 }); renderInspector(); });
      box.appendChild(add);
    }
    return box;
  }

  // 변수 효과 편집기 — 선택지(declarative=true: 더하기/빼기·켜기) / 링크(false: +끄기)
  function effectsEditor(effects, declarative) {
    var box = el("div");
    var varOpts = (project.variables || []).map(function (v) { return { value: v.id, label: v.name }; });
    if (!varOpts.length) { box.appendChild(el("p", "empty-inspector", "변수가 없습니다(설정 → 변수에서 추가).")); return box; }
    effects.forEach(function (e, i) {
      var vd = C.variableDef(project, e.var) || project.variables[0];
      if (vd && e.var !== vd.id && !C.variableDef(project, e.var)) e.var = vd.id;
      var line = el("div", "score-line");
      line.appendChild(selectInput(varOpts, e.var, function (v) {
        e.var = v; var nd = C.variableDef(project, v);
        if (nd && nd.type === "flag") { if (e.op !== "on" && e.op !== "off") e.op = "on"; delete e.value; }
        else { if (e.op !== "add" && e.op !== "sub") e.op = "add"; if (e.value == null) e.value = 1; }
        renderInspector();
      }));
      if (vd.type === "flag") {
        if (declarative) { e.op = "on"; var t = el("span", "empty-inspector", "켜기"); t.style.cssText = "margin:0;align-self:center;"; line.appendChild(t); }
        else line.appendChild(selectInput([{ value: "on", label: "켜기" }, { value: "off", label: "끄기" }], e.op === "off" ? "off" : "on", function (v) { e.op = v; softRefresh(); }));
      } else {
        var sub = el("div"); sub.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
        sub.appendChild(selectInput([{ value: "add", label: "＋ 더하기" }, { value: "sub", label: "− 빼기" }], e.op === "sub" ? "sub" : "add", function (v) { e.op = v; softRefresh(); }));
        sub.appendChild(numInput(e.value, function (v) { e.value = v; softRefresh(); }));
        line.appendChild(sub);
      }
      var x = el("button", "mini-x", "✕");
      x.addEventListener("click", function () { effects.splice(i, 1); renderInspector(); });
      line.appendChild(x);
      box.appendChild(line);
    });
    var add = el("button", "btn btn-sm", "＋ 효과");
    add.addEventListener("click", function () {
      var v0 = project.variables[0];
      effects.push(v0.type === "flag" ? { var: v0.id, op: "on" } : { var: v0.id, op: "add", value: 1 });
      renderInspector();
    });
    box.appendChild(add);
    return box;
  }

  // 선택지 id 목록 편집기 (activates/deactivates 등)
  function idListEditor(labelText, arr, excludeId) {
    var box = el("div");
    box.appendChild(el("label", null, labelText));
    var opts = C.allChoices(project).filter(function (c) { return c.id !== excludeId; }).map(function (c) { return { value: c.id, label: c.title || c.id }; });
    arr.forEach(function (id, j) {
      var ln = el("div"); ln.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:4px;margin-bottom:4px;";
      ln.appendChild(selectInput(opts, id, function (v) { arr[j] = v; softRefresh(); }));
      var rm = el("button", "mini-x", "✕"); rm.addEventListener("click", function () { arr.splice(j, 1); renderInspector(); });
      ln.appendChild(rm); box.appendChild(ln);
    });
    if (opts.length) {
      var add = el("span", "tree-add", "＋ 추가");
      add.addEventListener("click", function () { arr.push(opts[0].value); renderInspector(); });
      box.appendChild(add);
    } else box.appendChild(el("p", "empty-inspector", "다른 선택지가 없습니다."));
    return box;
  }

  // 여러 번 선택 편집기
  function multiEditor(ch) {
    if (!ch.selectMultiple) ch.selectMultiple = { enabled: false, min: 0, max: 0 };
    var sm = ch.selectMultiple;
    var kids = [checkbox("여러 번 선택 허용 (− N + 스테퍼)", sm.enabled === true, function (c) { sm.enabled = c; renderInspector(); softRefresh(); })];
    if (sm.enabled) {
      var r2 = el("div", "row2");
      r2.appendChild(field("최소", numInput(sm.min, function (v) { sm.min = v; softRefresh(); })));
      r2.appendChild(field("최대 (0=무제한)", numInput(sm.max, function (v) { sm.max = v; softRefresh(); })));
      kids.push(r2);
      var note = el("p", "empty-inspector", "플레이 시 − N + 로 여러 번 선택. 점수는 개수만큼 곱해집니다.");
      note.style.cssText = "text-align:left;padding:2px;margin:0;"; kids.push(note);
    }
    return group("여러 번 선택", kids);
  }

  // 자동 활성/해제 편집기
  function autoActivateEditor(ch) {
    if (!ch.activates) ch.activates = [];
    if (!ch.deactivates) ch.deactivates = [];
    var note = el("p", "empty-inspector", "이 선택지를 고르면 아래 선택지들이 자동으로 선택/해제됩니다.");
    note.style.cssText = "text-align:left;padding:2px;margin:0;";
    return group("자동 활성/해제", [
      idListEditor("선택 시 자동 선택", ch.activates, ch.id),
      idListEditor("선택 시 자동 해제", ch.deactivates, ch.id),
      note
    ]);
  }

  // 그룹 태그 편집기 — 선택지를 프로젝트 그룹(설정 모달에서 정의)에 넣고 뺌
  function groupsEditor(ch) {
    var defs = project.groups || [];
    if (!defs.length) return null; // 그룹 미정의 시 섹션 숨김
    if (!ch.groups) ch.groups = [];
    var kids = defs.map(function (g) {
      return checkbox(g.name, ch.groups.indexOf(g.id) !== -1, function (c) {
        if (c) { if (ch.groups.indexOf(g.id) === -1) ch.groups.push(g.id); }
        else ch.groups = ch.groups.filter(function (x) { return x !== g.id; });
        softRefresh();
      });
    });
    var note = el("p", "empty-inspector", "요구조건 「그룹 선택 수」와 🎒 백팩 분류에 쓰입니다. 그룹은 설정(⚙)에서 정의합니다.");
    note.style.cssText = "text-align:left;padding:2px;margin:0;";
    kids.push(note);
    return group("그룹", kids);
  }

  // 랜덤 선택(주사위) 편집기 — 행 단위
  function randomEditor(row) {
    if (!row.random) row.random = { enabled: false, label: "" };
    var rd = row.random;
    var kids = [checkbox("🎲 랜덤 선택 버튼 표시", rd.enabled === true, function (c) { rd.enabled = c; renderInspector(); softRefresh(); })];
    if (rd.enabled) {
      kids.push(field("버튼 문구 (비우면 '랜덤 선택')", textInput(rd.label, function (v) { rd.label = v; softRefresh(); })));
      var note = el("p", "empty-inspector", "플레이 시 요구조건을 통과하고 예산이 감당되는 선택지 중 하나를 무작위로 고릅니다. 단일 행은 교체, 다중 행은 남은 슬롯에 추가됩니다.");
      note.style.cssText = "text-align:left;padding:2px;margin:0;";
      kids.push(note);
    }
    return group("랜덤 선택 (주사위)", kids);
  }

  // 애드온 편집기 (조건부 추가 텍스트)
  function addonsEditor(ch) {
    if (!ch.addons) ch.addons = [];
    var box = el("div");
    var hint = el("p", "empty-inspector", "선택/조건 충족 시 카드 아래 표시. 표시 조건을 비우면 ‘이 선택지를 고를 때’ 표시됩니다. 본문에 {{cur:통화id}}로 점수도 표시 가능.");
    hint.style.cssText = "text-align:left;padding:2px;margin:0 0 6px;";
    box.appendChild(hint);
    ch.addons.forEach(function (ad, i) {
      if (!ad.requirements) ad.requirements = [];
      var blk = el("div", "req-block");
      blk.appendChild(field("애드온 " + (i + 1) + " 내용", textArea(ad.text, function (v) { ad.text = v; softRefresh(); })));
      blk.appendChild(reqEditor(ad.requirements));
      var rm = el("button", "btn btn-sm danger", "애드온 삭제");
      rm.addEventListener("click", function () { ch.addons.splice(i, 1); renderInspector(); });
      blk.appendChild(rm);
      box.appendChild(blk);
    });
    var add = el("button", "btn btn-sm", "＋ 애드온");
    add.addEventListener("click", function () { ch.addons.push({ text: "", requirements: [] }); renderInspector(); });
    box.appendChild(add);
    return group("애드온", [box]);
  }

  // 요구조건 편집기 (requirements 배열 in-place). refresh: 구조 변경 시 재렌더 콜백(기본 인스펙터)
  function reqEditor(reqs, refresh) {
    refresh = refresh || renderInspector;
    var box = el("div");
    box.appendChild(el("label", null, "요구조건 (모두 충족 시 선택/이동 가능)"));
    var choiceOpts = C.allChoices(project).map(function (c) { return { value: c.id, label: c.title || c.id }; });
    var curOpts = project.currencies.map(function (c) { return { value: c.id, label: c.name }; });
    var varOpts = (project.variables || []).map(function (v) { return { value: v.id, label: v.name }; });
    var opOpts = [">=", "<=", ">", "<", "==", "!="].map(function (o) { return { value: o, label: o }; });
    var groupOpts = (project.groups || []).map(function (g) { return { value: g.id, label: g.name }; });
    var globalOpts = (project.globalRequirements || []).map(function (g) { return { value: g.id, label: g.name }; });
    var kindOpts = [
      { value: "choice", label: "선택지" }, { value: "oneOf", label: "이 중 하나(OR)" },
      { value: "currency", label: "통화 값" }, { value: "compare", label: "통화 비교" },
      { value: "var", label: "변수 값" }
    ];
    if (groupOpts.length) kindOpts.push({ value: "group", label: "그룹 선택 수" });
    if (globalOpts.length) kindOpts.push({ value: "global", label: "조건 세트(글로벌)" });
    reqs.forEach(function (r, i) {
      var wrap = el("div", "req-block");
      var line = el("div", "req-line");
      line.appendChild(selectInput(kindOpts, r.kind, function (v) {
        r.kind = v;
        delete r.op; delete r.value; delete r.mode; delete r.id; delete r.ids; delete r.a; delete r.b;
        if (v === "choice") { r.id = (choiceOpts[0] || {}).value; r.mode = "selected"; }
        else if (v === "oneOf") { r.ids = choiceOpts[0] ? [choiceOpts[0].value] : []; r.mode = "selected"; }
        else if (v === "currency") { r.id = (curOpts[0] || {}).value; r.op = ">="; r.value = 0; }
        else if (v === "compare") { r.a = (curOpts[0] || {}).value; r.op = ">="; r.b = (curOpts[0] || {}).value; }
        else if (v === "var") { r.id = (varOpts[0] || {}).value; var vd0 = C.variableDef(project, r.id); if (vd0 && vd0.type === "flag") r.op = "isTrue"; else { r.op = ">="; r.value = 0; } }
        else if (v === "group") { r.id = (groupOpts[0] || {}).value; r.op = ">="; r.value = 1; }
        else if (v === "global") { r.id = (globalOpts[0] || {}).value; }
        refresh();
      }));
      if (r.kind === "choice") {
        line.appendChild(selectInput(choiceOpts, r.id, function (v) { r.id = v; softRefresh(); }));
        line.appendChild(selectInput([{ value: "selected", label: "선택함" }, { value: "notSelected", label: "선택안함" }], r.mode || "selected", function (v) { r.mode = v; softRefresh(); }));
      } else if (r.kind === "currency") {
        line.appendChild(selectInput(curOpts, r.id, function (v) { r.id = v; softRefresh(); }));
        var sub = el("div"); sub.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
        sub.appendChild(selectInput(opOpts, r.op || ">=", function (v) { r.op = v; softRefresh(); }));
        sub.appendChild(numInput(r.value, function (v) { r.value = v; softRefresh(); }));
        line.appendChild(sub);
      } else if (r.kind === "compare") {
        line.appendChild(selectInput(curOpts, r.a, function (v) { r.a = v; softRefresh(); }));
        var sub2 = el("div"); sub2.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
        sub2.appendChild(selectInput(opOpts, r.op || ">=", function (v) { r.op = v; softRefresh(); }));
        sub2.appendChild(selectInput(curOpts, r.b, function (v) { r.b = v; softRefresh(); }));
        line.appendChild(sub2);
      } else if (r.kind === "oneOf") {
        line.appendChild(selectInput([{ value: "selected", label: "하나라도 선택" }, { value: "notSelected", label: "모두 미선택" }], r.mode || "selected", function (v) { r.mode = v; softRefresh(); }));
        line.appendChild(el("div")); // 4열 정렬용 빈칸
      } else if (r.kind === "group") {
        line.appendChild(selectInput(groupOpts, r.id, function (v) { r.id = v; softRefresh(); }));
        var gsub = el("div"); gsub.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
        gsub.appendChild(selectInput(opOpts, r.op || ">=", function (v) { r.op = v; softRefresh(); }));
        gsub.appendChild(numInput(r.value, function (v) { r.value = v; softRefresh(); }));
        line.appendChild(gsub);
      } else if (r.kind === "global") {
        line.appendChild(selectInput(globalOpts, r.id, function (v) { r.id = v; softRefresh(); }));
        line.appendChild(el("div")); // 4열 정렬용 빈칸
      } else if (r.kind === "var") {
        line.appendChild(selectInput(varOpts, r.id, function (v) {
          r.id = v; var nd = C.variableDef(project, v);
          if (nd && nd.type === "flag") { if (r.op !== "isFalse") r.op = "isTrue"; delete r.value; }
          else { if (["<=", ">", ">=", "<", "==", "!="].indexOf(r.op) < 0) r.op = ">="; if (r.value == null) r.value = 0; }
          refresh();
        }));
        var vdq = C.variableDef(project, r.id);
        if (vdq && vdq.type === "flag") {
          line.appendChild(selectInput([{ value: "isTrue", label: "참(켜짐)" }, { value: "isFalse", label: "거짓(꺼짐)" }], r.op === "isFalse" ? "isFalse" : "isTrue", function (v) { r.op = v; softRefresh(); }));
        } else {
          var vsub = el("div"); vsub.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
          vsub.appendChild(selectInput(opOpts, r.op || ">=", function (v) { r.op = v; softRefresh(); }));
          vsub.appendChild(numInput(r.value, function (v) { r.value = v; softRefresh(); }));
          line.appendChild(vsub);
        }
      }
      var x = el("button", "mini-x", "✕");
      x.addEventListener("click", function () { reqs.splice(i, 1); refresh(); });
      line.appendChild(x);
      wrap.appendChild(line);
      if (r.kind === "oneOf") {
        if (!r.ids) r.ids = [];
        var idsBox = el("div"); idsBox.style.cssText = "margin:4px 0 2px 12px;display:flex;flex-direction:column;gap:4px;";
        r.ids.forEach(function (id, j) {
          var ln = el("div"); ln.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:4px;";
          ln.appendChild(selectInput(choiceOpts, id, function (v) { r.ids[j] = v; softRefresh(); }));
          var rm = el("button", "mini-x", "✕"); rm.addEventListener("click", function () { r.ids.splice(j, 1); refresh(); });
          ln.appendChild(rm); idsBox.appendChild(ln);
        });
        var addId = el("span", "tree-add", "＋ 선택지");
        addId.addEventListener("click", function () { if (choiceOpts[0]) { r.ids.push(choiceOpts[0].value); refresh(); } });
        idsBox.appendChild(addId);
        wrap.appendChild(idsBox);
      }
      box.appendChild(wrap);
    });
    var add = el("button", "btn btn-sm", "＋ 조건");
    add.addEventListener("click", function () {
      if (choiceOpts.length) reqs.push({ kind: "choice", id: choiceOpts[0].value, mode: "selected" });
      else if (curOpts.length) reqs.push({ kind: "currency", id: curOpts[0].value, op: ">=", value: 0 });
      else if (varOpts.length) { var vf = C.variableDef(project, varOpts[0].value); reqs.push(vf && vf.type === "flag" ? { kind: "var", id: varOpts[0].value, op: "isTrue" } : { kind: "var", id: varOpts[0].value, op: ">=", value: 0 }); }
      else { toast("선택지·통화·변수가 먼저 필요합니다."); return; }
      refresh();
    });
    box.appendChild(add);
    return box;
  }

  function group(title, children) {
    var g = el("div", "insp-group");
    g.appendChild(el("h3", null, title));
    children.forEach(function (c) { g.appendChild(c); });
    return g;
  }

  // 이미지 배치(위치/너비/높이) 편집기 — 행/페이지/선택지 공용
  function layoutEditor(obj, kind) {
    kind = kind || "page";
    var isChoice = kind === "choice";
    var L = isChoice ? (obj.layout || {}) : ensureBlockLayout(obj, kind);
    function setL(k, v) {
      if (isChoice) {
        if (!obj.layout) obj.layout = { imagePos: "top", imageWidth: 40, imageHeight: 0 };
        obj.layout[k] = v;
      } else {
        L[k] = v;
        obj.layout = C.normalizeBlockLayout(L, kind);
        L = obj.layout;
      }
    }
    var pos = L.imagePos || "top";
    var width = (L.imageWidth == null ? (isChoice ? 40 : 100) : L.imageWidth);
    var height = (L.imageHeight == null ? 0 : L.imageHeight);
    var posSel = selectInput([
      { value: "top", label: "위 (텍스트 위)" }, { value: "bottom", label: "아래 (텍스트 아래)" },
      { value: "left", label: "왼쪽 (텍스트 옆)" }, { value: "right", label: "오른쪽 (텍스트 옆)" }
    ], pos, function (v) {
      setL("imagePos", v);
      if (!isChoice) {
        if ((v === "left" || v === "right") && obj.layout.imageWidth >= 90) setL("imageWidth", 45);
        if ((v === "top" || v === "bottom") && obj.layout.imageWidth < 90) setL("imageWidth", 100);
      }
      renderInspector(); softRefresh();
    });
    var wh = el("div", "row2");
    wh.appendChild(field(isChoice ? "너비 % (좌/우 배치)" : "너비 %", numInput(width, function (v) { setL("imageWidth", v); softRefresh(); })));
    wh.appendChild(field(isChoice ? "높이 px (0=표준)" : "높이 px (0=원본비율)", numInput(height, function (v) { setL("imageHeight", v); softRefresh(); })));
    if (isChoice) return group("이미지 배치 (이미지가 있을 때)", [field("위치", posSel), wh]);

    var reset = el("button", "btn btn-sm danger", "기본값으로 초기화");
    reset.addEventListener("click", function () {
      obj.layout = C.defaultBlockLayout(kind);
      renderInspector();
      softRefresh();
    });
    var quick = el("div", "layout-quick-actions");
    [
      { label: "이미지 가운데", apply: function () { setL("imageAlign", "center"); } },
      { label: "텍스트 상자 가운데", apply: function () { setL("textBoxAlign", "center"); } },
      { label: "모두 가운데", apply: function () { setL("imageAlign", "center"); setL("textBoxAlign", "center"); setL("textAlign", "center"); } },
      { label: "본문 읽기 정렬", apply: function () { setL("textAlign", "left"); } }
    ].forEach(function (it) {
      var b = el("button", "btn btn-sm", it.label);
      b.type = "button";
      b.addEventListener("click", function () { it.apply(); renderInspector(); softRefresh(); });
      quick.appendChild(b);
    });
    return group("레이아웃", [
      field("이미지 위치", posSel),
      wh,
      grid2([
        field("이미지-텍스트 간격(px)", numInput(L.imageGap, function (v) { setL("imageGap", v); softRefresh(); })),
        field(kind === "page" ? "제목-콘텐츠 간격(px)" : "콘텐츠-선택지 간격(px)", numInput(L.blockGap, function (v) { setL("blockGap", v); softRefresh(); }))
      ]),
      field("이미지 정렬", selectInput([
        { value: "left", label: "왼쪽" },
        { value: "center", label: "가운데" },
        { value: "right", label: "오른쪽" }
      ], L.imageAlign || "center", function (v) { setL("imageAlign", v); softRefresh(); })),
      grid2([
        field("텍스트 상자 폭(%)", numInput(L.textWidth, function (v) { setL("textWidth", v); softRefresh(); })),
        field("텍스트 상자 위치", selectInput([
          { value: "left", label: "왼쪽" },
          { value: "center", label: "가운데" },
          { value: "right", label: "오른쪽" }
        ], L.textBoxAlign || "center", function (v) { setL("textBoxAlign", v); softRefresh(); }))
      ]),
      field("텍스트 정렬", selectInput([
        { value: "left", label: "왼쪽" },
        { value: "center", label: "가운데" },
        { value: "right", label: "오른쪽" }
      ], L.textAlign || "left", function (v) { setL("textAlign", v); softRefresh(); })),
      field("정렬 추천", quick),
      reset
    ]);
  }

  function grid2(children) {
    var row = el("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
    children.forEach(function (c) { row.appendChild(c); });
    return row;
  }
  function setStartLayoutValue(key, value) {
    var L = ensureStartLayout();
    L[key] = key === "align" ? value : Number(value);
    L.preset = "custom";
    project.start.layout = C.normalizeStartLayout(L);
    softRefresh();
  }
  // 자유 배치 켜기: 현재(세로 스택) 위치를 측정해 items로 저장 → 켜도 튀지 않음
  function enableStartFree() {
    var L = ensureStartLayout();
    var screen = $canvas.querySelector(".start-screen");
    var items = {};
    if (screen) {
      var scale = previewInteractionScale(screen);
      var sr = screen.getBoundingClientRect();
      var sw = sr.width / scale, sh = sr.height / scale;
      Array.prototype.slice.call(screen.querySelectorAll(".start-comp")).forEach(function (c) {
        var key = c.getAttribute("data-comp"); var r = c.getBoundingClientRect();
        items[key] = {
          x: round1((r.left - sr.left) / scale / Math.max(sw, 1) * 100),
          y: round1((r.top - sr.top) / scale / Math.max(sh, 1) * 100),
          w: round1((r.width / scale) / Math.max(sw, 1) * 100)
        };
      });
    }
    L.items = items; L.free = true;
    softRefresh(); renderInspector();
  }
  function startLayoutEditor() {
    var L = ensureStartLayout();
    var reset = el("button", "btn btn-sm danger", "기본값으로 초기화");
    reset.addEventListener("click", function () {
      project.start.layout = C.defaultStartLayout();
      renderInspector();
      softRefresh();
    });
    return group("레이아웃", [
      grid2([
        field("카드 X (%)", numInput(L.cardX, function (v) { setStartLayoutValue("cardX", v); })),
        field("카드 Y (%)", numInput(L.cardY, function (v) { setStartLayoutValue("cardY", v); }))
      ]),
      field("카드 폭(px)", numInput(L.cardWidth, function (v) { setStartLayoutValue("cardWidth", v); })),
      grid2([
        field("가로 패딩(px)", numInput(L.paddingX, function (v) { setStartLayoutValue("paddingX", v); })),
        field("세로 패딩(px)", numInput(L.paddingY, function (v) { setStartLayoutValue("paddingY", v); }))
      ]),
      field("텍스트 정렬", selectInput([
        { value: "left", label: "왼쪽" },
        { value: "center", label: "가운데" },
        { value: "right", label: "오른쪽" }
      ], L.align, function (v) { setStartLayoutValue("align", v); })),
      grid2([
        field("이미지-제목", numInput(L.gapImageTitle, function (v) { setStartLayoutValue("gapImageTitle", v); })),
        field("제목-부제목", numInput(L.gapTitleSubtitle, function (v) { setStartLayoutValue("gapTitleSubtitle", v); }))
      ]),
      grid2([
        field("부제목-본문", numInput(L.gapSubtitleText, function (v) { setStartLayoutValue("gapSubtitleText", v); })),
        field("콘텐츠-버튼", numInput(L.gapTextActions, function (v) { setStartLayoutValue("gapTextActions", v); }))
      ]),
      field("버튼-힌트", numInput(L.gapActionsHint, function (v) { setStartLayoutValue("gapActionsHint", v); })),
      reset
    ]);
  }
  function startPresetEditor() {
    var wrap = el("div");
    wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
    [
      { id: "center", label: "중앙 기본" },
      { id: "top-title", label: "상단 타이틀형" },
      { id: "bottom-bg", label: "하단 배경형" },
      { id: "image-card", label: "이미지 카드형" }
    ].forEach(function (p) {
      var b = el("button", "btn btn-sm", p.label);
      b.addEventListener("click", function () { applyStartPreset(p.id); });
      wrap.appendChild(b);
    });
    return group("정렬 추천", [wrap]);
  }

  function renderInspector() {
    if (previewOpen) { renderPreviewPanel({ preserveScroll: true }); return; }
    $inspector.classList.remove("preview-active");
    clear($inspector);
    if (!sel.type) {
      $inspector.appendChild(el("p", "empty-inspector", "왼쪽 트리나 가운데 캔버스에서 편집할 요소를 선택하세요."));
      var helpBtn = el("button", "btn btn-sm", "❔ 시작 가이드 열기");
      helpBtn.style.marginTop = "8px";
      helpBtn.addEventListener("click", openHelp);
      $inspector.appendChild(helpBtn);
      return;
    }

    if (sel.type === "start") {
      if (!project.start) project.start = {};
      var st = project.start;
      if (!st.imageMode) st.imageMode = "card";
      $inspector.appendChild(group("오프닝", [
        checkbox("공유 뷰어 시작 화면 표시", project.settings.startScreen !== false, function (v) { project.settings.startScreen = v; softRefresh(); }),
        field("제목 (비우면 프로젝트 제목 사용)", textInput(st.title, function (v) { st.title = v; softRefresh(); })),
        field("부제목 (비우면 작성자 사용)", textInput(st.subtitle, function (v) { st.subtitle = v; softRefresh(); })),
        field("본문 (비우면 프로젝트 설명 사용)", textArea(st.text, function (v) { st.text = v; softRefresh(); })),
        field("시작 버튼 문구", textInput(st.buttonLabel, function (v) { st.buttonLabel = v; softRefresh(); }, "▶ 시작하기")),
        field("이미지 표시", selectInput([
          { value: "card", label: "카드 안에 표시" },
          { value: "background", label: "배경으로 표시" }
        ], st.imageMode || "card", function (v) { st.imageMode = v; softRefresh(); })),
        imageField(st.image, function (val) { st.image = val; softRefresh(); })
      ]));
      var L = ensureStartLayout();
      var placeKids = [
        checkbox("자유 배치 (캔버스에서 각 요소 드래그)", L.free, function (v) {
          if (v) enableStartFree();
          else { L.free = false; softRefresh(); renderInspector(); }
        })
      ];
      if (L.free) {
        var fnote = el("p", "empty-inspector", "각 요소(이미지·제목·본문·버튼)를 캔버스에서 드래그하세요. 다른 요소나 화면 중앙에 맞으면 분홍 가이드선이 뜨고 스냅됩니다. 좁은 화면에서는 자동으로 세로 정렬됩니다.");
        fnote.style.cssText = "text-align:left;padding:2px;margin:0;";
        placeKids.push(fnote);
        var restack = el("button", "btn btn-sm", "↕ 다시 세로 정렬");
        restack.addEventListener("click", function () { L.free = false; renderCanvas(); enableStartFree(); });
        placeKids.push(restack);
      }
      $inspector.appendChild(group("배치", placeKids));
      if (!L.free) {
        $inspector.appendChild(startLayoutEditor());
        $inspector.appendChild(startPresetEditor());
      }
      return;
    }

    if (sel.type === "page") {
      var page = C.findPage(project, sel.id);
      if (!page) { sel.type = null; return renderInspector(); }
      var kids = [
        field("페이지 제목", textInput(page.title, function (v) { page.title = v; softRefresh(); })),
        field("유형", selectInput([{ value: "story", label: "서사(텍스트)" }, { value: "build", label: "빌드(선택지 행)" }], page.type, function (v) { page.type = v; if (!page.rows) page.rows = []; renderAll(); })),
        imageField(page.image, function (val) { page.image = val; softRefresh(); })
      ];
      if (page.type === "story") {
        kids.push(field("본문 (엔터=줄바꿈, 빈 줄=문단 나눔. 굵게 등은 <strong>처럼 HTML도 가능)", textArea(page.text, function (v) { page.text = v; softRefresh(); })));
        var rowHint = el("div", "field");
        rowHint.style.cssText = "font-size:12px;color:var(--muted);margin-top:-2px;line-height:1.5;";
        rowHint.innerHTML = "💡 본문 아래에 선택지 묶음을 넣으려면 왼쪽 트리에서 이 페이지의 <b>＋ 행 추가</b>를 누르세요.";
        kids.push(rowHint);
      }
      $inspector.appendChild(group("페이지", kids));
      $inspector.appendChild(layoutEditor(page, "page"));
      $inspector.appendChild(group("배경 음악 (BGM)", [bgmEditor(page)]));
      return;
    }

    if (sel.type === "row") {
      var rid = sel.id;
      var rrow = null;
      project.pages.forEach(function (p) { (p.rows || []).forEach(function (r) { if (r.id === rid) { rrow = r; } }); });
      if (!rrow) { sel.type = null; return renderInspector(); }
      if (!rrow.select) rrow.select = { mode: "single", min: 0, max: 1 };
      var modeSel = selectInput([{ value: "single", label: "단일 (하나만)" }, { value: "multi", label: "다중 (여러 개)" }], rrow.select.mode, function (v) {
        rrow.select.mode = v;
        if (v === "single") rrow.select.max = 1;
        else if ((rrow.select.max || 0) <= 1) rrow.select.max = 0; // 다중 전환 시 기본 무제한
        renderInspector(); softRefresh();
      });
      var selKids = [field("선택 방식", modeSel)];
      if (rrow.select.mode === "multi") {
        selKids.push(field("최대 선택 개수 (0 = 제한 없음)", numInput(rrow.select.max, function (v) { rrow.select.max = v; softRefresh(); })));
      } else {
        var note = el("p", "empty-inspector", "단일 모드는 이 행에서 하나만 선택됩니다. 여러 개를 고르게 하려면 ‘다중’으로 바꾸세요.");
        note.style.cssText = "text-align:left;padding:4px 2px;margin:0;";
        selKids.push(note);
      }
      $inspector.appendChild(group("행", [
        field("행 제목", textInput(rrow.title, function (v) { rrow.title = v; softRefresh(); })),
        field("설명", textArea(rrow.description, function (v) { rrow.description = v; softRefresh(); }))
      ].concat(selKids).concat([
        field("열 수", numInput(rrow.columns || 3, function (v) { rrow.columns = v || 1; softRefresh(); })),
        imageField(rrow.image, function (val) { rrow.image = val; softRefresh(); })
      ])));
      $inspector.appendChild(randomEditor(rrow));
      $inspector.appendChild(layoutEditor(rrow, "row"));
      return;
    }

    if (sel.type === "choice") {
      var ch = C.findChoice(project, sel.id);
      if (!ch) { sel.type = null; return renderInspector(); }
      if (!ch.scores) ch.scores = [];
      if (!ch.requirements) ch.requirements = [];
      if (!ch.effects) ch.effects = [];
      $inspector.appendChild(group("선택지", [
        field("제목", textInput(ch.title, function (v) { ch.title = v; softRefresh(); })),
        field("설명", textArea(ch.description, function (v) { ch.description = v; softRefresh(); })),
        imageField(ch.image, function (val) { ch.image = val; softRefresh(); })
      ]));
      $inspector.appendChild(layoutEditor(ch, "choice"));
      $inspector.appendChild(group("점수", [scoresEditor(ch.scores, true)]));
      $inspector.appendChild(group("효과 (변수 변경 — 선택 시)", [effectsEditor(ch.effects, true)]));
      $inspector.appendChild(multiEditor(ch));
      $inspector.appendChild(autoActivateEditor(ch));
      var grpEd = groupsEditor(ch);
      if (grpEd) $inspector.appendChild(grpEd);
      $inspector.appendChild(addonsEditor(ch));

      var hideCb = checkbox("조건 미충족 시 숨김 (조건을 만족하기 전까지 안 보임)", ch.hideWhenLocked === true, function (c) { ch.hideWhenLocked = c; softRefresh(); });
      var hideNote = el("p", "empty-inspector", "체크하면 아래 요구조건을 만족하기 전까지 이 선택지가 보이지 않습니다. (조건이 없으면 항상 보임)");
      hideNote.style.cssText = "text-align:left;padding:2px;margin:0;";
      $inspector.appendChild(group("요구조건", [hideCb, hideNote, reqEditor(ch.requirements)]));
      return;
    }

    if (sel.type === "link") {
      var f = findLink(sel.id);
      if (!f) { sel.type = null; return renderInspector(); }
      var lnk = f.link;
      if (!lnk.scores) lnk.scores = [];
      if (!lnk.requirements) lnk.requirements = [];
      if (!lnk.effects) lnk.effects = [];
      var pageOpts = project.pages.map(function (p) { return { value: p.id, label: (p.title || p.id) }; });
      $inspector.appendChild(group("이동 링크", [
        field("버튼 라벨", textInput(lnk.label, function (v) { lnk.label = v; softRefresh(); })),
        field("이동할 페이지", selectInput(pageOpts, lnk.target, function (v) { lnk.target = v; softRefresh(); }))
      ]));
      $inspector.appendChild(group("이동 시 점수", [scoresEditor(lnk.scores)]));
      $inspector.appendChild(group("이동 시 효과 (변수 변경 — 이동 1회)", [effectsEditor(lnk.effects, false)]));

      var lhideCb = checkbox("조건 미충족 시 숨김 (조건을 만족하기 전까지 버튼이 안 보임)", lnk.hideWhenLocked === true, function (c) { lnk.hideWhenLocked = c; softRefresh(); });
      var lhideNote = el("p", "empty-inspector", "체크하면 아래 요구조건을 만족하기 전까지 이 이동 버튼이 보이지 않습니다. (조건이 없으면 항상 보임)");
      lhideNote.style.cssText = "text-align:left;padding:2px;margin:0;";
      $inspector.appendChild(group("이동 요구조건", [lhideCb, lhideNote, reqEditor(lnk.requirements)]));
      return;
    }
  }

  /* =========================================================
     변형(추가/삭제)
     ========================================================= */
  function addPage() {
    var id = C.genId("page");
    project.pages.push({ id: id, title: "새 페이지", type: "story", text: "", image: null, layout: C.defaultBlockLayout("page"), rows: [], links: [] });
    select("page", id); autosave();
  }
  function deletePage(id) {
    if (project.pages.length <= 1) { toast("마지막 페이지는 삭제할 수 없습니다."); return; }
    if (!confirm("이 페이지를 삭제할까요?")) return;
    project.pages = project.pages.filter(function (p) { return p.id !== id; });
    if (project.settings.startPageId === id) project.settings.startPageId = project.pages[0].id;
    sel = { type: null, id: null }; editPageId = project.pages[0].id;
    renderAll(); autosave();
  }
  function addRow(page) {
    if (!page.rows) page.rows = [];
    var id = C.genId("row");
    page.rows.push({ id: id, title: "새 행", description: "", image: null, layout: C.defaultBlockLayout("row"), select: { mode: "single", min: 0, max: 1 }, columns: 3, choices: [] });
    select("row", id); autosave();
  }
  function addChoice(row) {
    var id = C.genId("ch");
    row.choices.push({ id: id, title: "새 선택지", description: "", image: null, scores: [], requirements: [] });
    select("choice", id); autosave();
  }
  function addLink(page) {
    if (!page.links) page.links = [];
    var uid = C.genId("lnk");
    var target = (project.pages[0] || {}).id;
    page.links.push({ _uid: uid, label: "다음", target: target, requirements: [], scores: [] });
    select("link", uid); autosave();
  }

  /* =========================================================
     미리보기
     ========================================================= */
  function togglePreview() {
    if (!previewOpen) {
      if (window.matchMedia && window.matchMedia("(max-width: 980px)").matches) {
        toast("미리보기 패널은 넓은 화면에서 사용할 수 있습니다.");
        return;
      }
      previewOpen = true;
      initPreviewState();
      document.getElementById("btnPreview").textContent = "✕ 미리보기";
      renderInspector();
      return;
    }
    previewOpen = false;
    previewStarted = false;
    document.getElementById("btnPreview").textContent = "▶ 미리보기";
    if (_pvAudio) { _pvAudio.pause(); _pvSrc = null; }
    renderInspector();
  }

  /* =========================================================
     설정 모달
     ========================================================= */
  /* =========================================================
     도움말 / 시작 가이드 (온보딩)
     ========================================================= */
  function loadExample(path) {
    if (!confirm("현재 작업을 예제로 대체할까요? 저장하지 않은 변경은 사라집니다.")) return;
    fetch(path).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (p) { loadProject(p); toast("예제를 불러왔어요. 자유롭게 바꿔보세요!"); })
      .catch(function () { toast("예제를 불러오지 못했습니다(로컬 서버에서 열어주세요)."); });
  }
  function openHelp() {
    var back = el("div", "modal-backdrop open");
    var m = el("div", "modal modal-wide");
    m.appendChild(el("h2", null, "🧭 CYOA 에디터 — 시작 가이드"));
    m.appendChild(el("p", "empty-inspector", "선택지로 갈라지는 인터랙티브 이야기를 만들고, 완성하면 한 파일로 내보내 Neocities 같은 정적 호스팅에 올릴 수 있어요. 설치도 빌드도 필요 없습니다."));

    var steps = el("ol", "help-steps");
    [
      ["오프닝 꾸미기", "왼쪽 트리의 <b>오프닝</b>에서 제목·소개·시작 버튼을 정해요."],
      ["페이지 만들기", "<b>＋ 페이지 추가</b> 후 유형을 골라요. <b>서사</b>=이야기 본문, <b>빌드</b>=선택지 묶음. 두 유형 모두 <b>＋ 행 추가</b>로 선택지를 넣을 수 있어요."],
      ["선택지·점수·조건", "행에 <b>＋ 선택지</b>를 넣고, 가운데 캔버스에서 클릭해 오른쪽 패널에서 점수·요구조건을 편집해요."],
      ["미리보기 → 내보내기", "상단 <b>▶ 미리보기</b>로 실제처럼 확인하고, <b>⬆ neocities 내보내기</b>로 배포 파일을 받아요."]
    ].forEach(function (s) {
      var li = el("li");
      li.appendChild(el("strong", null, s[0]));
      li.appendChild(el("div", null, s[1]));
      steps.appendChild(li);
    });
    m.appendChild(group("빠른 시작 4단계", [steps]));

    var tips = el("ul", "help-tips");
    [
      "<b>통화</b>(포인트·체력 등)는 설정 <b>⚙</b>에서 정의하고 선택지 점수로 증감해요. 음수=비용, 양수=획득.",
      "<b>변수</b>(설정 → 변수)는 예산 잠금 없는 자유 상태(수치/참·거짓 깃발). 선택지·링크의 ‘효과’로 바꾸고 본문 <code>{{var:id}}</code>로 표시해요.",
      "<b>조건부 텍스트</b>: 본문에 <code>{{if:var:brave}}…{{else}}…{{/if}}</code>로 상태에 따라 다른 글이 나오게 할 수 있어요(조건은 choice/var/cur, <code>!</code>로 부정).",
      "<b>요구조건</b>으로 특정 선택/통화/변수 조건을 만족해야 고르거나 이동할 수 있게 만들어요(잠금·숨김). 자주 쓰는 조건 묶음은 <b>글로벌 요구조건</b>(설정)으로 저장해 재사용할 수 있어요.",
      "<b>그룹</b>(설정)으로 여러 행의 선택지를 묶으면 “능력 2개 이상” 같은 조건과 🎒 <b>백팩</b> 분류에 쓸 수 있어요.",
      "행 인스펙터의 <b>🎲 랜덤 선택</b>을 켜면 플레이어가 주사위로 무작위 선택을 굴릴 수 있어요.",
      "선택지 <b>점수에 조건</b>을 달면 “특정 선택 시 할인/추가 비용”처럼 상황에 따라 값이 바뀌게 만들 수 있어요.",
      "플레이어는 뷰어에서 🎒 <b>백팩</b>(실시간 선택 요약·저장 슬롯)과 🌓 <b>밝기 전환</b>을 쓸 수 있어요.",
      "실수해도 <b>↩ 되돌리기(Ctrl+Z)</b>로 복구할 수 있어요(삭제·이동·수정 모두). ↪ 다시 실행은 Ctrl+Shift+Z.",
      "작업은 브라우저에 <b>자동 저장</b>돼요. 백업·다른 기기로 옮기려면 <b>저장(JSON)</b>으로 파일을 받으세요.",
      "🕸 <b>연결망</b> 뷰로 선택지·페이지가 어떻게 얽혀 있는지 한눈에 볼 수 있어요.",
      "고급: <b>커스텀 CSS·JS</b>로 직접 확장할 수 있어요(설정 → 확장, 문서는 docs/EXTEND.md)."
    ].forEach(function (t) { tips.appendChild(el("li", null, t)); });
    m.appendChild(group("알아두면 좋아요", [tips]));

    var actions = el("div", "modal-actions");
    var exLabel = el("span", "empty-inspector", "예제로 둘러보기:");
    var exStory = el("button", "btn btn-sm", "📖 서사 예제");
    exStory.addEventListener("click", function () { back.remove(); loadExample("examples/sample-story.json"); });
    var exBuild = el("button", "btn btn-sm", "🧩 빌드 예제");
    exBuild.addEventListener("click", function () { back.remove(); loadExample("examples/sample-build.json"); });
    var spacer = el("span", "help-spacer");
    var close = el("button", "btn primary", "시작하기");
    close.addEventListener("click", function () { back.remove(); });
    [exLabel, exStory, exBuild, spacer, close].forEach(function (n) { actions.appendChild(n); });
    m.appendChild(actions);

    back.appendChild(m);
    back.addEventListener("click", function (e) { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  // 첫 실행(자동저장 없음 + 미열람)에만 1회 자동 표시. 이후엔 ❔ 도움말 버튼으로 언제든 열 수 있음.
  function maybeFirstRunHelp() {
    var seen = false; try { seen = localStorage.getItem(HELP_KEY) === "1"; } catch (e) {}
    if (seen) return;
    try { localStorage.setItem(HELP_KEY, "1"); } catch (e) {}
    openHelp();
  }

  function openSettings() {
    var back = el("div", "modal-backdrop open");
    var m = el("div", "modal");
    m.appendChild(el("h2", null, "프로젝트 설정"));

    // 메타
    m.appendChild(group("기본 정보", [
      field("제목", textInput(project.meta.title, function (v) { project.meta.title = v; autosave(); })),
      field("작성자", textInput(project.meta.author, function (v) { project.meta.author = v; autosave(); })),
      field("설명", textArea(project.meta.description, function (v) { project.meta.description = v; autosave(); }))
    ]));

    // 진행 방식
    var pageOpts = project.pages.map(function (p) { return { value: p.id, label: p.title || p.id }; });
    m.appendChild(group("진행 방식", [
      field("흐름", selectInput([{ value: "paged", label: "페이지형(한 페이지씩)" }, { value: "scroll", label: "스크롤형(전부 표시)" }], project.settings.flow, function (v) { project.settings.flow = v; autosave(); })),
      field("시작 페이지", selectInput(pageOpts, project.settings.startPageId, function (v) { project.settings.startPageId = v; autosave(); })),
      checkbox("잠긴 선택지 표시(끄면 숨김)", project.settings.showLockedChoices, function (v) { project.settings.showLockedChoices = v; autosave(); }),
      checkbox("통화 음수 허용(전역)", project.settings.allowNegativeCurrency, function (v) { project.settings.allowNegativeCurrency = v; autosave(); }),
      checkbox("빌드코드 공유 사용", project.settings.enableBuildCode, function (v) { project.settings.enableBuildCode = v; autosave(); }),
      checkbox("공유 뷰어 오프닝 표시", project.settings.startScreen !== false, function (v) { project.settings.startScreen = v; autosave(); }),
      checkbox("플레이어 밝기 전환(🌓) 허용", project.settings.allowBrightnessToggle !== false, function (v) { project.settings.allowBrightnessToggle = v; autosave(); })
    ]));

    // 통화
    var curBox = el("div");
    function renderCurs() {
      clear(curBox);
      project.currencies.forEach(function (c, i) {
        var line = el("div", "field");
        var r = el("div"); r.style.cssText = "display:grid;grid-template-columns:1fr 1.4fr 70px 38px 30px;gap:5px;align-items:center;";
        r.appendChild(textInput(c.id, function (v) { c.id = v.trim() || c.id; autosave(); }, "id"));
        r.appendChild(textInput(c.name, function (v) { c.name = v; autosave(); }, "이름"));
        r.appendChild(numInput(c.start, function (v) { c.start = v; autosave(); }));
        var col = el("input"); col.type = "color"; col.className = "color-swatch"; col.value = c.color || "#d8b25a";
        col.addEventListener("input", function () { c.color = col.value; autosave(); });
        r.appendChild(col);
        var x = el("button", "mini-x", "✕");
        x.addEventListener("click", function () { project.currencies.splice(i, 1); renderCurs(); autosave(); });
        r.appendChild(x);
        line.appendChild(r);
        line.appendChild(checkbox("음수 허용", c.allowNegative, function (v) { c.allowNegative = v; autosave(); }));
        curBox.appendChild(line);
      });
      var add = el("button", "btn btn-sm", "＋ 통화 추가");
      add.addEventListener("click", function () { project.currencies.push({ id: C.genId("cur"), name: "새 통화", start: 0, color: "#d8b25a", allowNegative: false }); renderCurs(); autosave(); });
      curBox.appendChild(add);
    }
    renderCurs();
    var curGroup = el("div", "insp-group");
    curGroup.appendChild(el("h3", null, "통화 (id, 이름, 시작값, 색)"));
    curGroup.appendChild(curBox);
    m.appendChild(curGroup);

    // 변수 (상태/깃발) — 예산 잠금 없는 자유 상태
    var varBox = el("div");
    function renderVars() {
      clear(varBox);
      if (!project.variables) project.variables = [];
      var hint = el("p", "empty-inspector", "통화와 달리 예산 잠금이 없는 자유 상태. 선택지·이동 링크의 ‘효과’로 바꾸고, 요구조건·본문 {{var:id}}에서 읽습니다. (수치 / 참·거짓 깃발)");
      hint.style.cssText = "margin:0 0 6px;"; varBox.appendChild(hint);
      project.variables.forEach(function (v, i) {
        if (!v.type) v.type = "number";
        var line = el("div", "field");
        var r = el("div"); r.style.cssText = "display:grid;grid-template-columns:1fr 1.3fr 90px 70px 30px;gap:5px;align-items:center;";
        r.appendChild(textInput(v.id, function (val) { v.id = val.trim() || v.id; autosave(); }, "id"));
        r.appendChild(textInput(v.name, function (val) { v.name = val; autosave(); }, "이름"));
        r.appendChild(selectInput([{ value: "number", label: "수치" }, { value: "flag", label: "참/거짓" }], v.type, function (val) {
          v.type = val; v.initial = (val === "flag") ? false : 0; renderVars(); autosave();
        }));
        if (v.type === "flag") r.appendChild(checkbox("초깃값 켜짐", !!v.initial, function (val) { v.initial = val; autosave(); }));
        else r.appendChild(numInput(v.initial, function (val) { v.initial = val; autosave(); }));
        var x = el("button", "mini-x", "✕");
        x.addEventListener("click", function () { project.variables.splice(i, 1); renderVars(); autosave(); });
        r.appendChild(x);
        line.appendChild(r);
        varBox.appendChild(line);
      });
      var add = el("button", "btn btn-sm", "＋ 변수 추가");
      add.addEventListener("click", function () { project.variables.push({ id: C.genId("var"), name: "새 변수", type: "number", initial: 0 }); renderVars(); autosave(); });
      varBox.appendChild(add);
    }
    renderVars();
    var varGroup = el("div", "insp-group");
    varGroup.appendChild(el("h3", null, "변수 (상태/깃발 — id, 이름, 타입, 초깃값)"));
    varGroup.appendChild(varBox);
    m.appendChild(varGroup);

    // 그룹 — 행을 가로지르는 선택지 묶음(요구조건 「그룹 선택 수」·백팩 분류에 사용)
    var grpBox = el("div");
    function renderGroups() {
      clear(grpBox);
      if (!project.groups) project.groups = [];
      var hint = el("p", "empty-inspector", "여러 행에 흩어진 선택지를 하나의 묶음으로 태그합니다(선택지 인스펙터 「그룹」). 요구조건 「그룹 선택 수」(예: 능력 그룹에서 2개 이상)와 🎒 백팩 분류에 쓰입니다.");
      hint.style.cssText = "margin:0 0 6px;"; grpBox.appendChild(hint);
      project.groups.forEach(function (g, i) {
        var r = el("div"); r.style.cssText = "display:grid;grid-template-columns:1fr 1.4fr 30px;gap:5px;align-items:center;margin-bottom:4px;";
        r.appendChild(textInput(g.id, function (v) { g.id = v.trim() || g.id; autosave(); }, "id"));
        r.appendChild(textInput(g.name, function (v) { g.name = v; autosave(); }, "이름"));
        var x = el("button", "mini-x", "✕");
        x.addEventListener("click", function () { project.groups.splice(i, 1); renderGroups(); autosave(); });
        r.appendChild(x);
        grpBox.appendChild(r);
      });
      var add = el("button", "btn btn-sm", "＋ 그룹 추가");
      add.addEventListener("click", function () { project.groups.push({ id: C.genId("grp"), name: "새 그룹" }); renderGroups(); autosave(); });
      grpBox.appendChild(add);
    }
    renderGroups();
    var grpGroup = el("div", "insp-group");
    grpGroup.appendChild(el("h3", null, "그룹 (선택지 묶음 — 요구조건·백팩 분류)"));
    grpGroup.appendChild(grpBox);
    m.appendChild(grpGroup);

    // 글로벌 요구조건 — 조건 세트를 한 번 정의해 여러 곳에서 참조
    var greqBox = el("div");
    function renderGlobalReqs() {
      clear(greqBox);
      if (!project.globalRequirements) project.globalRequirements = [];
      var hint = el("p", "empty-inspector", "자주 쓰는 조건 묶음을 세트로 저장해 요구조건 「조건 세트(글로벌)」로 참조합니다. 본문에서는 {{if:global:세트id}}로 사용. 세트끼리 참조할 수도 있습니다(순환 참조는 무시됨).");
      hint.style.cssText = "margin:0 0 6px;"; greqBox.appendChild(hint);
      project.globalRequirements.forEach(function (g, i) {
        if (!g.requirements) g.requirements = [];
        var blk = el("div", "req-block");
        var r2 = el("div", "row2");
        r2.appendChild(field("세트 id", textInput(g.id, function (v) { g.id = v.trim() || g.id; autosave(); })));
        r2.appendChild(field("이름", textInput(g.name, function (v) { g.name = v; autosave(); })));
        blk.appendChild(r2);
        blk.appendChild(reqEditor(g.requirements, renderGlobalReqs));
        var rm = el("button", "btn btn-sm danger", "세트 삭제");
        rm.addEventListener("click", function () { project.globalRequirements.splice(i, 1); renderGlobalReqs(); autosave(); });
        blk.appendChild(rm);
        greqBox.appendChild(blk);
      });
      var add = el("button", "btn btn-sm", "＋ 조건 세트");
      add.addEventListener("click", function () { project.globalRequirements.push({ id: C.genId("greq"), name: "새 조건 세트", requirements: [] }); renderGlobalReqs(); autosave(); });
      greqBox.appendChild(add);
    }
    renderGlobalReqs();
    var greqGroup = el("div", "insp-group");
    greqGroup.appendChild(el("h3", null, "글로벌 요구조건 (조건 세트 재사용)"));
    greqGroup.appendChild(greqBox);
    m.appendChild(greqGroup);

    // 동적 단어 (wordMap)
    var wordsBox = el("div");
    function renderWords() {
      clear(wordsBox);
      if (!project.words) project.words = [];
      var hint = el("p", "empty-inspector", "본문·설명·애드온에서 {{word:id}}로 사용. 규칙 조건을 만족하면 그 값, 아니면 기본값. (포인트 표시는 {{cur:통화id}})");
      hint.style.cssText = "margin:0 0 6px;"; wordsBox.appendChild(hint);
      project.words.forEach(function (w, i) {
        if (!w.rules) w.rules = [];
        var blk = el("div", "req-block");
        var r2 = el("div", "row2");
        r2.appendChild(field("단어 id", textInput(w.id, function (v) { w.id = v.trim(); autosave(); })));
        r2.appendChild(field("기본값", textInput(w.default, function (v) { w.default = v; autosave(); })));
        blk.appendChild(r2);
        w.rules.forEach(function (rule, j) {
          if (!rule.requirements) rule.requirements = [];
          var rb = el("div"); rb.style.cssText = "margin:4px 0 6px 10px;border-left:2px solid var(--card-border);padding-left:6px;";
          rb.appendChild(field("이 조건 만족 시 값", textInput(rule.value, function (v) { rule.value = v; autosave(); })));
          rb.appendChild(reqEditor(rule.requirements, renderWords));
          var rmr = el("button", "btn btn-sm danger", "규칙 삭제"); rmr.addEventListener("click", function () { w.rules.splice(j, 1); renderWords(); autosave(); });
          rb.appendChild(rmr); blk.appendChild(rb);
        });
        var addRule = el("button", "btn btn-sm", "＋ 규칙"); addRule.addEventListener("click", function () { w.rules.push({ requirements: [], value: "" }); renderWords(); autosave(); });
        blk.appendChild(addRule);
        var rmw = el("button", "btn btn-sm danger", "단어 삭제"); rmw.style.marginLeft = "6px"; rmw.addEventListener("click", function () { project.words.splice(i, 1); renderWords(); autosave(); });
        blk.appendChild(rmw);
        wordsBox.appendChild(blk);
      });
      var addW = el("button", "btn btn-sm", "＋ 동적 단어"); addW.addEventListener("click", function () { project.words.push({ id: C.genId("word"), default: "", rules: [] }); renderWords(); autosave(); });
      wordsBox.appendChild(addW);
    }
    renderWords();
    var wordsGroup = el("div", "insp-group");
    wordsGroup.appendChild(el("h3", null, "동적 단어 (본문 {{word:id}})"));
    wordsGroup.appendChild(wordsBox);
    m.appendChild(wordsGroup);

    // 테마
    var st = project.style;
    function styleOption(key, value) {
      st[key] = value;
      applyLiveTheme();
      renderCanvas();
      if (previewOpen) renderPreviewPanel({ preserveScroll: true });
      autosave();
    }
    m.appendChild(group("개인화", [
      field("전체 레이아웃", selectInput([
        { value: "default", label: "기본형" },
        { value: "wide", label: "넓은형" },
        { value: "card", label: "카드형" },
        { value: "compact", label: "컴팩트형" }
      ], st.layoutPreset, function (v) { styleOption("layoutPreset", v); })),
      field("선택지 형태", selectInput([
        { value: "card", label: "카드형" },
        { value: "button", label: "버튼형" },
        { value: "list", label: "리스트형" }
      ], st.choicePreset, function (v) { styleOption("choicePreset", v); })),
      (function () { var w = el("div", "row2");
        w.appendChild(field("페이지 전환", selectInput([
          { value: "none", label: "없음" },
          { value: "fade", label: "페이드" },
          { value: "slide", label: "슬라이드" },
          { value: "zoom", label: "확대" }
        ], st.pageTransition, function (v) { styleOption("pageTransition", v); })));
        w.appendChild(field("전환 속도", selectInput([
          { value: "fast", label: "빠름" },
          { value: "normal", label: "보통" },
          { value: "slow", label: "느림" }
        ], st.transitionSpeed, function (v) { styleOption("transitionSpeed", v); })));
        return w; })()
    ]));
    function themeColor(label, key) {
      var f = el("div", "field"); f.appendChild(el("label", null, label));
      var inl = el("div", "field-inline");
      var col = el("input"); col.type = "color"; col.className = "color-swatch"; col.value = st[key] || "#000000";
      var txt = textInput(st[key], function (v) { st[key] = v; col.value = /^#/.test(v) ? v : col.value; applyLiveTheme(); autosave(); });
      col.addEventListener("input", function () { st[key] = col.value; txt.value = col.value; applyLiveTheme(); autosave(); });
      inl.appendChild(col); inl.appendChild(txt); f.appendChild(inl); return f;
    }
    m.appendChild(group("테마", [
      themeColor("배경", "bg"), themeColor("글자", "text"), themeColor("강조(accent)", "accent"),
      themeColor("카드 배경", "card"), themeColor("카드 테두리", "cardBorder"),
      field("폰트", textInput(st.font, function (v) { st.font = v; applyLiveTheme(); autosave(); }, "system-ui, Georgia, ...")),
      (function () {
        var f = field("웹폰트 URL (선택)", textInput(st.fontUrl, function (v) { st.fontUrl = v; applyLiveTheme(); autosave(); }, "https://fonts.googleapis.com/css2?family=..."));
        var hint = el("p", "empty-inspector", "구글 폰트 등 <b>폰트 스타일시트 URL</b>(https)을 넣고, 위 ‘폰트’ 칸에 그 폰트 이름을 적으면 적용됩니다. 예: URL은 Google Fonts의 링크, 폰트는 <code>'Noto Sans KR', sans-serif</code>.");
        hint.style.cssText = "text-align:left;padding:2px;margin:2px 0 0;line-height:1.5;";
        f.appendChild(hint);
        return f;
      })(),
      (function () { var w = el("div", "row2");
        w.appendChild(field("최대 폭(px)", numInput(st.maxWidth, function (v) { st.maxWidth = v; applyLiveTheme(); autosave(); })));
        w.appendChild(field("이미지 높이(px)", numInput(st.rowImageHeight, function (v) { st.rowImageHeight = v; applyLiveTheme(); autosave(); })));
        return w; })(),
      field("커스텀 CSS", textArea(st.customCss, function (v) { st.customCss = v; applyLiveTheme(); autosave(); }))
    ]));

    // 확장 — 숙련자용 커스텀 JS (project.customJs)
    var customJsArea = textArea(project.customJs, function (v) { project.customJs = v; autosave(); });
    customJsArea.placeholder = 'api.on("render", function (ctx) {\n  // ctx.project, ctx.state, ctx.mountEl, ctx.mode, ctx.stage\n});';
    customJsArea.rows = 8; customJsArea.spellcheck = false;
    customJsArea.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre;";
    var jsApply = el("button", "btn btn-sm primary", "▶ 미리보기에 적용");
    jsApply.addEventListener("click", function () {
      C.resetHooks();
      var ok = C.runCustomJs(project, { onError: function (e) { toast("스크립트 오류: " + e.message); } });
      if (previewOpen) renderPreviewPanel({ preserveScroll: true });
      if (ok) toast(previewOpen ? "스크립트를 적용했습니다." : "스크립트 실행됨 — 미리보기를 열어 확인하세요.");
    });
    var jsHelp = el("div", null,
      '숙련자용: 작성자 정의 JavaScript. 로드 시 1회 실행되며 <code>api.on("render", fn)</code>로 렌더에 끼어들 수 있습니다. ' +
      '<code>CYOA</code>(엔진)·<code>project</code>·<code>api</code> 사용 가능. ' +
      '⚠ 내가 내보낸 페이지에선 자동 실행, 외부 파일을 열 땐 확인 후 실행됩니다. 사용법: docs/EXTEND.md');
    jsHelp.style.cssText = "font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;";
    m.appendChild(group("확장 — 커스텀 JS (고급)", [jsHelp, field("스크립트", customJsArea), jsApply]));

    var actions = el("div", "modal-actions");
    var close = el("button", "btn primary", "닫기");
    close.addEventListener("click", function () { back.remove(); renderAll(); });
    actions.appendChild(close);
    m.appendChild(actions);

    back.appendChild(m);
    back.addEventListener("click", function (e) { if (e.target === back) { back.remove(); renderAll(); } });
    document.body.appendChild(back);
  }
  function checkbox(label, val, onchange) {
    var f = el("div", "field-inline");
    var c = el("input"); c.type = "checkbox"; c.checked = !!val; c.id = "cb_" + C.genId("");
    c.addEventListener("change", function () { onchange(c.checked); });
    var l = el("label"); l.setAttribute("for", c.id); l.textContent = label; l.style.cssText = "margin:0;color:var(--text);font-size:13px;cursor:pointer;";
    f.appendChild(c); f.appendChild(l); return f;
  }
  function applyLiveTheme() { C.applyTheme(project.style, document.documentElement); }

  /* =========================================================
     내보내기 모달
     ========================================================= */
  function openExport() {
    var back = el("div", "modal-backdrop open");
    var m = el("div", "modal");
    m.appendChild(el("h2", null, "neocities 내보내기"));
    m.appendChild(el("p", "empty-inspector", "neocities는 정적 파일만 올립니다. 받은 파일을 neocities에 그대로 업로드하면 누구나 플레이할 수 있는 공유 링크가 됩니다."));

    var b1 = el("button", "btn primary", "① 단일 파일 (index.html 하나) — 가장 쉬움");
    b1.style.cssText = "display:block;width:100%;margin:8px 0;";
    b1.addEventListener("click", function () { exportSingleFile(); });

    var bSet = el("button", "btn", "② 공유 뷰어 세트 내려받기 (5개 파일)");
    bSet.style.cssText = "display:block;width:100%;margin:8px 0;";
    bSet.addEventListener("click", function () { exportViewerSet(); });

    var b2 = el("button", "btn", "③ project.json 만 내보내기");
    b2.style.cssText = "display:block;width:100%;margin:8px 0;";
    b2.addEventListener("click", function () { download("project.json", JSON.stringify(stripUids(project), null, 2), "application/json"); toast("project.json 저장됨"); });

    var b3 = el("button", "btn", "④ 이미지 분리 내보내기 (이미지 파일 + project.json)");
    b3.style.cssText = "display:block;width:100%;margin:8px 0;";
    b3.addEventListener("click", function () { exportSeparateImages(); });

    var note = el("p", "empty-inspector",
      "① 단일 파일: index.html 하나만 올리면 끝(이미지·음악도 내장). 이미지/음악이 많아 파일이 무거우면 ②를 쓰세요. " +
      "② 공유 뷰어 세트: index.html · viewer.js · engine.js · styles.css · project.json 5개를 모두 업로드(이미지/음악은 경로 사용 시 images/ · audio/ 폴더도 함께). 자세한 안내는 docs/DEPLOY-neocities.md 참고.");

    m.appendChild(b1); m.appendChild(bSet); m.appendChild(b2); m.appendChild(b3); m.appendChild(note);
    var actions = el("div", "modal-actions");
    var close = el("button", "btn", "닫기"); close.addEventListener("click", function () { back.remove(); });
    actions.appendChild(close); m.appendChild(actions);
    back.appendChild(m);
    back.addEventListener("click", function (e) { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }

  function stripUids(p) {
    var c = C.clone(p);
    (c.pages || []).forEach(function (pg) { (pg.links || []).forEach(function (l) { delete l._uid; }); });
    return c;
  }

  function exportSingleFile() {
    Promise.all([
      fetch("index.html").then(function (r) { return r.text(); }),
      fetch("styles.css").then(function (r) { return r.text(); }),
      fetch("engine.js").then(function (r) { return r.text(); }),
      fetch("viewer.js").then(function (r) { return r.text(); })
    ]).then(function (parts) {
      var tpl = parts[0], css = parts[1], eng = parts[2], vw = parts[3];
      var pjson = JSON.stringify(stripUids(project)).replace(/<\//g, "<\\/");
      var html = tpl
        .replace('<link rel="stylesheet" href="styles.css" />', "<style>\n" + css + "\n</style>")
        .replace('<script src="engine.js"></script>', '<script>window.__CYOA_TRUSTED__=true;window.__CYOA_PROJECT__=' + pjson + ';<\/script>\n<script>\n' + eng + '\n<\/script>')
        .replace('<script src="viewer.js"></script>', '<script>\n' + vw + '\n<\/script>');
      download("index.html", html, "text/html");
      toast("단일 파일(index.html) 내보냄 — neocities에 업로드하세요.");
    }).catch(function () {
      alert("단일 파일 내보내기는 로컬 서버에서 실행할 때만 동작합니다.\n터미널에서 다음을 실행한 뒤 http://localhost:8765/editor.html 로 여세요:\n\npython3 -m http.server 8765");
    });
  }

  // 공유 뷰어 세트(다중 파일) 한 번에 내려받기
  function exportViewerSet() {
    Promise.all([
      fetch("index.html").then(function (r) { return r.text(); }),
      fetch("viewer.js").then(function (r) { return r.text(); }),
      fetch("engine.js").then(function (r) { return r.text(); }),
      fetch("styles.css").then(function (r) { return r.text(); })
    ]).then(function (parts) {
      // 작성자 배포본은 신뢰됨 → customJs 자동 실행되도록 플래그 주입
      var indexHtml = parts[0].replace('<script src="engine.js"></script>', '<script>window.__CYOA_TRUSTED__=true;<\/script>\n  <script src="engine.js"></script>');
      var files = [
        ["index.html", indexHtml, "text/html"],
        ["viewer.js", parts[1], "text/javascript"],
        ["engine.js", parts[2], "text/javascript"],
        ["styles.css", parts[3], "text/css"],
        ["project.json", JSON.stringify(stripUids(project), null, 2), "application/json"]
      ];
      files.forEach(function (f, i) { setTimeout(function () { download(f[0], f[1], f[2]); }, i * 250); });
      toast("공유 뷰어 세트(5개 파일) 내려받음 — 모두 neocities에 업로드하세요.");
    }).catch(function () {
      alert("공유 뷰어 세트 내보내기는 로컬 서버에서 실행할 때만 동작합니다.\npython3 -m http.server 8765 실행 후 http://localhost:8765/editor.html 로 여세요.");
    });
  }

  function exportSeparateImages() {
    var copy = stripUids(project);
    var count = 0;
    function handleImg(obj, key, name) {
      var v = obj[key];
      if (typeof v === "string" && v.indexOf("data:") === 0) {
        var m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(v);
        var ext = "png";
        if (m) { ext = m[1].split("/")[1].replace("svg+xml", "svg"); }
        var fname = "images/" + name + "." + ext;
        // SVG data URL(비base64)도 처리
        if (m) { download(name + "." + ext, b64toBlob(m[2], m[1]), m[1]); }
        else { var dec = decodeURIComponent(v.replace(/^data:[^,]*,/, "")); download(name + "." + ext, dec, "image/svg+xml"); }
        obj[key] = fname; count++;
      }
    }
    copy.pages.forEach(function (p, pi) {
      handleImg(p, "image", "page" + pi);
      (p.rows || []).forEach(function (r, ri) {
        handleImg(r, "image", "p" + pi + "_row" + ri);
        (r.choices || []).forEach(function (c, ci) { handleImg(c, "image", "p" + pi + "_r" + ri + "_c" + ci); });
      });
    });
    download("project.json", JSON.stringify(copy, null, 2), "application/json");
    toast(count + "개 이미지 + project.json 내보냄. images/ 폴더에 함께 올리세요.");
  }
  function b64toBlob(b64, mime) {
    var bin = atob(b64); var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /* =========================================================
     파일 입출력
     ========================================================= */
  function loadProject(obj) {
    if (!obj || obj.format !== "cyoa-tool") { if (!confirm("CYOA 프로젝트 형식이 아닐 수 있습니다. 그래도 불러올까요?")) return; }
    project = obj;
    normalize();
    sel = { type: null, id: null };
    editPageId = (project.settings && project.settings.startPageId) || project.pages[0].id;
    previewOpen = false; previewStarted = false; pstate = null;
    if (_pvAudio) { _pvAudio.pause(); _pvSrc = null; }
    document.getElementById("btnPreview").textContent = "▶ 미리보기";
    applyLiveTheme(); renderAll(); autosave();
  }
  function normalize() {
    project.meta = project.meta || { title: "", author: "", description: "", lang: "ko" };
    // 프로젝트별 안정적 id — 뷰어의 저장 키가 제목이 아니라 이 id로 구분되게 해
    // 동명 작품끼리 진행/슬롯이 섞이는 것을 막는다(기존 작품엔 이 시점에 1회 부여).
    if (!project.meta.id) project.meta.id = C.genId("proj");
    project.start = project.start || {};
    if (project.start.title == null) project.start.title = "";
    if (project.start.subtitle == null) project.start.subtitle = "";
    if (project.start.text == null) project.start.text = "";
    if (project.start.buttonLabel == null) project.start.buttonLabel = "";
    if (project.start.image == null) project.start.image = null;
    if (project.start.imageMode !== "card" && project.start.imageMode !== "background") project.start.imageMode = "card";
    project.start.layout = C.normalizeStartLayout(project.start.layout);
    project.settings = project.settings || {};
    if (project.settings.flow == null) project.settings.flow = "paged";
    if (project.settings.showLockedChoices == null) project.settings.showLockedChoices = true;
    if (project.settings.allowNegativeCurrency == null) project.settings.allowNegativeCurrency = false;
    if (project.settings.enableBuildCode == null) project.settings.enableBuildCode = true;
    project.style = C.normalizeStyle ? C.normalizeStyle(project.style) : (project.style || {});
    if (typeof project.customJs !== "string") project.customJs = "";
    project.currencies = project.currencies || [];
    project.variables = project.variables || [];
    project.pages = project.pages || [];
    if (!project.pages.length) {
      var pid = C.genId("page");
      project.pages.push({ id: pid, title: "시작", type: "story", text: "", image: null, rows: [], links: [] });
    }
    project.pages.forEach(function (p) {
      p.type = p.type || "story";
      p.layout = C.normalizeBlockLayout(p.layout, "page");
      p.links = p.links || [];
      p.links.forEach(function (l) { if (!l._uid) l._uid = C.genId("lnk"); l.requirements = l.requirements || []; l.scores = l.scores || []; l.effects = l.effects || []; });
      // 행은 서사·빌드 페이지 모두 가질 수 있으므로 유형과 무관하게 정규화
      p.rows = p.rows || [];
      p.rows.forEach(function (r) {
        r.layout = C.normalizeBlockLayout(r.layout, "row");
        r.choices = r.choices || []; r.select = r.select || { mode: "single", min: 0, max: 1 };
        r.choices.forEach(function (c) { c.scores = c.scores || []; c.requirements = c.requirements || []; c.effects = c.effects || []; });
      });
    });
    if (!project.settings.startPageId || !C.findPage(project, project.settings.startPageId)) project.settings.startPageId = project.pages[0].id;
  }

  /* =========================================================
     초기화
     ========================================================= */
  /* =========================================================
     패널 폭 조절 (트리/인스펙터 리사이저)
     ========================================================= */
  var PANE_KEY = "cyoa_pane_widths_v1";
  function initPaneResizers() {
    var editor = document.querySelector(".editor");
    var rsTree = document.getElementById("resizeTree");
    var rsInsp = document.getElementById("resizeInspector");
    if (!editor || !rsTree || !rsInsp) return;
    function getW(prop, fallback) {
      var v = parseInt(getComputedStyle(editor).getPropertyValue(prop), 10);
      return isFinite(v) && v > 0 ? v : fallback;
    }
    // 저장된 폭 복원
    try {
      var saved = JSON.parse(localStorage.getItem(PANE_KEY));
      if (saved && saved.tree) editor.style.setProperty("--tree-width", saved.tree + "px");
      if (saved && saved.insp) editor.style.setProperty("--inspector-width", saved.insp + "px");
    } catch (e) {}
    function persistWidths() {
      try {
        localStorage.setItem(PANE_KEY, JSON.stringify({ tree: getW("--tree-width", 280), insp: getW("--inspector-width", 320) }));
      } catch (e) {}
    }
    function wire(handle, prop, min, max, fromRight, fallback) {
      handle.title = "드래그로 폭 조절 · 더블클릭으로 초기화";
      handle.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        handle.classList.add("dragging");
        var startX = e.clientX, startW = getW(prop, fallback);
        function move(ev) {
          var d = ev.clientX - startX;
          var w = fromRight ? startW - d : startW + d;
          // 캔버스 최소 폭 확보: 두 패널을 아무리 넓혀도 가운데가 짓눌리지 않게
          var other = fromRight ? getW("--tree-width", 280) : getW("--inspector-width", 320);
          var maxAllowed = Math.min(max, window.innerWidth - other - 320);
          w = Math.max(min, Math.min(maxAllowed, w));
          editor.style.setProperty(prop, w + "px");
          rescalePreviewFrames(); // 인스펙터가 미리보기 패널일 때 viewport 스케일 갱신
        }
        function up(ev) {
          try { handle.releasePointerCapture(ev.pointerId); } catch (err) {}
          handle.classList.remove("dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          persistWidths();
        }
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      handle.addEventListener("dblclick", function () {
        editor.style.removeProperty(prop);
        persistWidths();
        rescalePreviewFrames();
      });
    }
    wire(rsTree, "--tree-width", 170, 560, false, 280);
    wire(rsInsp, "--inspector-width", 220, 720, true, 320);
  }

  function init() {
    if (!document.getElementById("tree")) return; // 에디터 DOM이 없으면(테스트 페이지 등) 스킵
    $tree = document.getElementById("tree");
    $canvas = document.getElementById("canvas");
    $canvasWrap = document.getElementById("canvasWrap");
    $inspector = document.getElementById("inspector");
    $banner = document.getElementById("editBanner");

    document.getElementById("btnNew").addEventListener("click", function () {
      if (confirm("새 프로젝트를 시작할까요? 저장하지 않은 변경은 사라집니다.")) loadProject(C.newProject());
    });
    document.getElementById("btnLoad").addEventListener("click", function () { document.getElementById("fileLoad").click(); });
    document.getElementById("fileLoad").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { try { loadProject(JSON.parse(r.result)); toast("불러왔습니다."); } catch (err) { alert("JSON 오류: " + err.message); } };
      r.readAsText(f); e.target.value = "";
    });
    document.getElementById("btnSave").addEventListener("click", function () {
      download((project.meta.title || "cyoa") + ".json", JSON.stringify(stripUids(project), null, 2), "application/json");
      toast("저장됨 (JSON 다운로드)");
    });
    document.getElementById("btnHelp").addEventListener("click", openHelp);
    document.getElementById("btnUndo").addEventListener("click", undo);
    document.getElementById("btnRedo").addEventListener("click", redo);
    document.addEventListener("keydown", function (e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      var k = String(e.key).toLowerCase();
      if (k !== "z" && k !== "y") return;
      // 텍스트 입력 중엔 브라우저 네이티브 undo 를 존중
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      if (k === "y" || e.shiftKey) redo(); else undo();
    });
    document.getElementById("btnSettings").addEventListener("click", openSettings);
    document.getElementById("btnExport").addEventListener("click", openExport);
    document.getElementById("btnPreview").addEventListener("click", togglePreview);
    document.getElementById("btnGraph").addEventListener("click", function () {
      if (!window.CYOAGraph) { toast("graph.js 를 불러오지 못했습니다."); return; }
      if (previewOpen) togglePreview();
      window.CYOAGraph.open(project, { onEditNode: function (type, id) { select(type, id); } });
    });
    window.addEventListener("resize", rescalePreviewFrames);
    initPaneResizers();

    // 자동저장 복원(IndexedDB, 옛 localStorage 자동 이관) 또는 데모 로드 — 비동기
    loadAutosaveState().then(function (restored) {
      if (restored && restored.pages && restored.pages.length) {
        project = restored; normalize();
        editPageId = project.settings.startPageId || project.pages[0].id;
        applyLiveTheme(); renderAll();
        resetUndoBaseline(); // 복원 직후를 undo 기준선으로 — 첫 편집 전 상태로 돌아올 수 있게
        toast("이전 작업을 자동 복원했습니다.");
      } else {
        // 데모 프로젝트 시도, 실패하면 새 프로젝트
        fetch("project.json").then(function (r) { return r.json(); }).then(function (p) { loadProject(p); })
          .catch(function () { loadProject(C.newProject()); });
        maybeFirstRunHelp();   // 첫 실행(자동저장 없음)인 신규 사용자에게 시작 가이드 1회 표시
      }
    });
  }

  // 테스트용 순수 헬퍼 노출(에디터에서만 로드되므로 배포 뷰어엔 영향 없음)
  window.__IE = { clampCrop: clampCrop, applyAspect: applyAspect, outDims: outDims, encodeImage: encodeImage, webpSupported: webpSupported, dataUrlKB: dataUrlKB };
  window.__ALIGN = { computeSnap: computeSnap, uniqNum: uniqNum };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
