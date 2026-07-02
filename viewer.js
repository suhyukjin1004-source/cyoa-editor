/* ===========================================================
   CYOA 공유 뷰어 (viewer.js) — engine.js(window.CYOA) 의존
   index.html / viewer.html 에서 로드. UI 전체를 #cyoa-app(또는 body)에 구성.
   프로젝트는 window.__CYOA_PROJECT__(단일파일) → ?p= → project.json 순으로 로드.
   =========================================================== */
(function () {
  "use strict";
  var CY = window.CYOA;
  var root = document.getElementById("cyoa-app") || document.body;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function param(name) { return new URLSearchParams(location.search).get(name); }

  /* ---------- UI 골격 구성 ---------- */
  var view = el("div", "cyoa-view");
  var topbar = el("div", "cyoa-topbar"); topbar.hidden = true;
  var titleSpan = el("span", "title");
  var curBar = el("div", "currency-bar");
  var tools = el("div"); tools.style.cssText = "display:flex;gap:6px;";
  var muteBtn = el("button", "btn btn-sm", "🔊"); muteBtn.hidden = true; muteBtn.title = "배경 음악 켜기/끄기";
  var themeBtn = el("button", "btn btn-sm", "🌓"); themeBtn.hidden = true; themeBtn.title = "밝기 전환";
  var packBtn = el("button", "btn btn-sm", "🎒"); packBtn.title = "백팩 (내 선택)";
  var imageBtn = el("button", "btn btn-sm", "🖼 결과 이미지");
  var codeBtn = el("button", "btn btn-sm", "빌드코드"); codeBtn.hidden = true;
  var resetBtn = el("button", "btn btn-sm", "처음으로");
  tools.appendChild(muteBtn); tools.appendChild(themeBtn); tools.appendChild(packBtn); tools.appendChild(imageBtn); tools.appendChild(codeBtn); tools.appendChild(resetBtn);
  topbar.appendChild(titleSpan); topbar.appendChild(curBar); topbar.appendChild(tools);
  var mount = el("div");
  view.appendChild(topbar); view.appendChild(mount);
  var audio = el("audio"); audio.loop = true; audio.preload = "auto"; audio.volume = 0.6;
  var toastEl = el("div", "toast");
  var startEl = el("div", "start-screen"); startEl.hidden = true;
  // 백팩 사이드 패널
  var packPanel = el("aside", "backpack-panel");
  var packHead = el("div", "backpack-head");
  packHead.appendChild(el("strong", null, "🎒 내 선택"));
  var packClose = el("button", "btn btn-sm", "✕"); packClose.title = "닫기";
  packHead.appendChild(packClose);
  var packMount = el("div", "backpack-body");
  var slotsBox = el("div", "backpack-slots");
  packPanel.appendChild(packHead); packPanel.appendChild(packMount); packPanel.appendChild(slotsBox);
  root.appendChild(view); root.appendChild(audio); root.appendChild(toastEl); root.appendChild(startEl); root.appendChild(packPanel);

  var project = null, state = null, saveKey = "cyoa_save_default";
  var packOpen = false, themeInverted = false;

  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 1800); }

  /* ---------- 저장/복원 ---------- */
  function persist() { try { localStorage.setItem(saveKey, JSON.stringify(state)); } catch (e) {} }
  // 저장 슬롯: 오토세이브(persist)와 별개로, 이름 붙인 상태를 빌드코드로 보관
  var MAX_SLOTS = 10;
  function loadSlots() {
    try { return JSON.parse(localStorage.getItem(saveKey + ":slots")) || []; } catch (e) { return []; }
  }
  function saveSlots(arr) {
    try { localStorage.setItem(saveKey + ":slots", JSON.stringify(arr)); return true; }
    catch (e) { toast("⚠ 저장 실패 — 브라우저 저장 공간이 부족합니다."); return false; }
  }

  /* ---------- 백팩 패널 ---------- */
  function renderSlots() {
    slotsBox.innerHTML = "";
    var head = el("div", "backpack-slots-head");
    head.appendChild(el("strong", null, "💾 저장 슬롯"));
    var slots = loadSlots();
    var addBtn = el("button", "btn btn-sm", "＋ 현재 상태 저장");
    addBtn.disabled = slots.length >= MAX_SLOTS;
    if (addBtn.disabled) addBtn.title = "슬롯이 가득 찼습니다 (" + MAX_SLOTS + "개)";
    addBtn.addEventListener("click", function () {
      var name = prompt("저장 이름:", "저장 " + (slots.length + 1));
      if (name == null) return;
      slots.push({ name: (name.trim() || "저장 " + (slots.length + 1)), ts: Date.now(), code: CY.encodeBuildCode(state) });
      if (saveSlots(slots)) { renderSlots(); toast("저장했습니다."); }
    });
    head.appendChild(addBtn);
    slotsBox.appendChild(head);
    if (!slots.length) {
      slotsBox.appendChild(el("p", "backpack-empty", "저장된 슬롯이 없습니다. (진행은 자동 저장됩니다 — 슬롯은 분기 비교용 수동 저장)"));
      return;
    }
    slots.forEach(function (s, i) {
      var line = el("div", "backpack-slot");
      var d = new Date(s.ts || 0);
      var when = d.getMonth() + 1 + "/" + d.getDate() + " " + d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
      line.appendChild(el("span", "backpack-slot-name", CY.escapeHtml(s.name || "저장 " + (i + 1)) + ' <span class="backpack-slot-ts">' + when + "</span>"));
      var load = el("button", "btn btn-sm", "불러오기");
      load.addEventListener("click", function () {
        if (CY.applyBuildCode(state, s.code)) { persist(); render(); renderBackpack(); toast("'" + (s.name || "") + "' 을(를) 불러왔습니다."); }
        else toast("저장 데이터가 손상되었습니다.");
      });
      var x = el("button", "backpack-x", "✕"); x.title = "슬롯 삭제";
      x.addEventListener("click", function () {
        if (!confirm("'" + (s.name || "") + "' 슬롯을 삭제할까요?")) return;
        slots.splice(i, 1); saveSlots(slots); renderSlots();
      });
      line.appendChild(load); line.appendChild(x);
      slotsBox.appendChild(line);
    });
  }
  function renderBackpack() {
    if (!packOpen || !project) return;
    CY.renderBackpackPanel(project, state, packMount, {
      onRemove: function (id) { CY.toggleChoice(project, state, id); persist(); render(); renderBackpack(); }
    });
  }
  function togglePack(open) {
    packOpen = open == null ? !packOpen : !!open;
    packPanel.classList.toggle("open", packOpen);
    if (packOpen) { renderBackpack(); renderSlots(); }
  }

  /* ---------- 밝기(명도 반전) 토글 ---------- */
  function allowBrightness() { return !(project && project.settings && project.settings.allowBrightnessToggle === false); }
  function applyCurrentTheme() {
    CY.applyTheme(themeInverted ? CY.invertStyle(project.style) : project.style, document.documentElement);
  }
  function restore() {
    try {
      var raw = localStorage.getItem(saveKey);
      if (raw) {
        var s = JSON.parse(raw);
        state.selected = s.selected || [];
        state.counts = s.counts || {};
        state.eventScores = s.eventScores || {};
        state.varEvents = s.varEvents || [];
        state.takenLinks = s.takenLinks || [];
        state.currentPageId = s.currentPageId || state.currentPageId;
        state.history = s.history || [];
      }
    } catch (e) {}
  }

  /* ---------- 배경 음악 ---------- */
  var curBgm = null, pendingPlay = false;
  var bgmMuted = localStorage.getItem("cyoa_bgm_muted") === "1";
  function hasAnyBgm() { return !!(project && (project.pages || []).some(function (p) { return p.bgm; })); }
  function tryPlay() { if (bgmMuted || !audio.src) return; var pr = audio.play(); if (pr && pr.catch) pr.catch(function () { pendingPlay = true; }); }
  function updateAudio() {
    if (!project) return;
    muteBtn.hidden = !hasAnyBgm();
    muteBtn.textContent = bgmMuted ? "🔇" : "🔊";
    var a = CY.pageAudio(project, state);
    if (a.action === "stop") { audio.pause(); curBgm = null; audio.removeAttribute("src"); try { audio.load(); } catch (e) {} return; }
    if (a.action === "play") {
      if (a.src !== curBgm) { curBgm = a.src; audio.src = a.src; if (!bgmMuted) tryPlay(); }
      else if (!bgmMuted && audio.paused) tryPlay();
      return;
    }
    if (!bgmMuted && audio.src && audio.paused) tryPlay(); // keep
  }
  function kick() { if (pendingPlay && !bgmMuted) { pendingPlay = false; tryPlay(); } }
  document.addEventListener("pointerdown", kick);
  document.addEventListener("keydown", kick);

  /* ---------- 렌더 ---------- */
  function renderTopbar() {
    titleSpan.textContent = (project.meta && project.meta.title) || "CYOA";
    curBar.innerHTML = CY.currencyBadgesHTML(project, state);
    codeBtn.hidden = !(project.settings && project.settings.enableBuildCode);
    themeBtn.hidden = !allowBrightness();
  }
  function render(animatePage) {
    renderTopbar();
    CY.renderStage(project, state, mount, {
      mode: "play",
      onToggle: function (id) { CY.toggleChoice(project, state, id); persist(); render(); },
      onCount: function (id, delta) { CY.changeCount(project, state, id, delta); persist(); render(); },
      onNavigate: function (link) { CY.navigate(project, state, link); persist(); render(true); window.scrollTo(0, 0); },
      onBack: function () { CY.goBack(state); persist(); render(true); window.scrollTo(0, 0); },
      onRoll: function (row) {
        var id = CY.rollRandomChoice(project, state, row);
        persist(); render();
        if (!id) toast("굴릴 수 있는 선택지가 없습니다.");
      },
      animatePage: !!animatePage
    });
    if (themeInverted) applyCurrentTheme(); // renderStage 가 제작자 테마를 다시 적용하므로 반전 유지
    renderBackpack();
    updateAudio();
  }

  /* ---------- 시작 화면 ---------- */
  function hasSavedProgress() {
    if (!state) return false;
    var startId = project.settings && project.settings.startPageId;
    return !!(state.selected.length || state.history.length || (state.currentPageId && startId && state.currentPageId !== startId));
  }
  function showStart() {
    topbar.hidden = true; mount.innerHTML = "";
    CY.renderStartScreen(project, startEl, {
      mode: "play",
      hasSaved: hasSavedProgress(),
      onStart: begin,
      onResume: begin,
      onNew: function () { state = CY.newState(project); persist(); begin(); },
      hint: hasAnyBgm() ? "🔊 배경 음악이 포함되어 있어요" : ""
    });
    if (themeInverted) applyCurrentTheme(); // renderStartScreen 의 테마 재적용을 덮음
    startEl.hidden = false;
  }
  function begin() { startEl.hidden = true; topbar.hidden = false; render(true); pendingPlay = false; updateAudio(); window.scrollTo(0, 0); }

  /* ---------- 버튼 ---------- */
  function wireButtons() {
    resetBtn.onclick = function () {
      if (!confirm("선택과 진행 상황을 모두 초기화할까요?")) return;
      state = CY.newState(project); persist(); render(true); window.scrollTo(0, 0);
    };
    muteBtn.onclick = function () {
      bgmMuted = !bgmMuted;
      try { localStorage.setItem("cyoa_bgm_muted", bgmMuted ? "1" : "0"); } catch (e) {}
      if (bgmMuted) audio.pause();
      updateAudio();
    };
    themeBtn.onclick = function () {
      themeInverted = !themeInverted;
      try { localStorage.setItem(saveKey + ":bright", themeInverted ? "1" : "0"); } catch (e) {}
      applyCurrentTheme();
    };
    packBtn.onclick = function () { togglePack(); };
    packClose.onclick = function () { togglePack(false); };
    imageBtn.onclick = function () {
      imageBtn.disabled = true; var prev = imageBtn.textContent; imageBtn.textContent = "이미지 생성 중…";
      CY.saveResultImage(project, state, (project.meta && project.meta.title) || "cyoa").then(function (type) {
        imageBtn.disabled = false; imageBtn.textContent = prev;
        toast(type === "webp" ? "결과 이미지(WebP)를 저장했습니다." : type === "png" ? "WebP 미지원 → PNG로 저장했습니다." : "이미지를 만들 수 없습니다(이미지 보안 제한).");
      }).catch(function () { imageBtn.disabled = false; imageBtn.textContent = prev; toast("이미지 생성 중 오류가 발생했습니다."); });
    };
    codeBtn.onclick = function () {
      var code = CY.encodeBuildCode(state);
      var url = location.origin + location.pathname + location.search + "#code=" + encodeURIComponent(code);
      var doImport = function () {
        var inp = prompt("불러올 빌드코드를 붙여넣으세요:\n(빈칸으로 두고 확인하면 현재 코드를 복사합니다)", "");
        if (inp) { if (CY.applyBuildCode(state, inp.trim())) { persist(); render(); toast("빌드코드를 불러왔습니다."); } else toast("코드가 올바르지 않습니다."); }
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("공유 링크를 복사했습니다."); }, doImport);
      else doImport();
    };
  }

  /* ---------- 시작 ---------- */
  function start(p, trustedSource) {
    project = p;
    CY.applyTheme(project.style, document.documentElement);
    // 작성자 정의 스크립트(customJs): 번들된(내보낸) 프로젝트 출처에서만 자동 실행.
    // ?p= 로 불러온 외부/타 출처 프로젝트나 드롭한 파일은 trusted 페이지라도 확인 후 실행(XSS 방지).
    // (첫 렌더 전에 훅이 등록돼야 하므로 여기서 실행)
    CY.resetHooks();
    if (project.customJs && String(project.customJs).trim()) {
      var trusted = !!window.__CYOA_TRUSTED__ && trustedSource === true;
      if (trusted || confirm("이 CYOA에는 제작자가 넣은 사용자 정의 스크립트가 있습니다.\n신뢰할 수 있을 때만 실행하세요. 실행할까요?")) {
        CY.runCustomJs(project);
      }
    }
    saveKey = "cyoa_save_" + ((project.meta && project.meta.title) || "default");
    document.title = (project.meta && project.meta.title) || "CYOA";
    try { themeInverted = allowBrightness() && localStorage.getItem(saveKey + ":bright") === "1"; } catch (e) { themeInverted = false; }
    if (themeInverted) applyCurrentTheme();
    state = CY.newState(project);
    var hash = location.hash.replace(/^#/, "");
    var codeParam = /(?:^|&)code=([^&]+)/.exec(hash);
    var fromCode = false;
    if (codeParam) { CY.applyBuildCode(state, decodeURIComponent(codeParam[1])); fromCode = true; }
    else restore();
    wireButtons();
    var startParam = param("start");
    var useStart = startParam !== "0" && !(project.settings && project.settings.startScreen === false) && !fromCode;
    if (useStart) showStart(); else begin();
  }

  /* ---------- 프로젝트 없을 때 드롭 UI ---------- */
  function showLoader(msg) {
    topbar.hidden = true; startEl.hidden = true; mount.innerHTML = "";
    var box = el("div", "loader-msg", "<h2>CYOA 뷰어</h2><p>" + msg + "</p>");
    var drop = el("div", "drop", "여기에 <b>project.json</b> 파일을 끌어다 놓거나<br>클릭해서 선택하세요.");
    var input = el("input"); input.type = "file"; input.accept = ".json,application/json"; input.style.display = "none";
    drop.onclick = function () { input.click(); };
    input.onchange = function () { if (input.files[0]) readFile(input.files[0]); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("hot"); };
    drop.ondragleave = function () { drop.classList.remove("hot"); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("hot"); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); };
    box.appendChild(drop); box.appendChild(input); mount.appendChild(box);
  }
  function readFile(file) {
    var r = new FileReader();
    r.onload = function () { try { start(JSON.parse(r.result), false); } catch (e) { showLoader("JSON 파싱 오류: " + e.message); } };
    r.readAsText(file);
  }

  /* ---------- 부트스트랩 ---------- */
  if (window.__CYOA_PROJECT__) {
    start(window.__CYOA_PROJECT__, true);   // 단일 파일에 인라인된 프로젝트 = 신뢰 출처
  } else {
    var pOverride = param("p");
    var src = pOverride || "project.json";
    fetch(src).then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (p) { start(p, !pOverride); })   // 기본 project.json만 신뢰, ?p= 오버라이드는 확인 강제
      .catch(function () { showLoader("project.json 을 불러올 수 없습니다. 로컬 파일로 열었거나 파일이 없는 경우, 아래에서 직접 불러오세요."); });
  }
})();
