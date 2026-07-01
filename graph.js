/* ===========================================================
   CYOA 연결망(그물망) 뷰 — graph.js
   선택지/페이지가 요구조건·이동링크로 어떻게 연결되는지
   힘-기반(force-directed) 그래프로 시각화. 의존성 없음.
   window.CYOAGraph.open(project, { onEditNode }) 로 호출.
   =========================================================== */
(function (global) {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function trunc(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* ---------- 데이터 → 그래프 모델 ---------- */
  function buildModel(project) {
    var nodes = [], byId = {};
    function add(id, type, label, extra) {
      if (byId[id]) return byId[id];
      var n = { id: id, type: type, label: label || id, x: 0, y: 0, dx: 0, dy: 0, fixed: false };
      if (extra) Object.keys(extra).forEach(function (k) { n[k] = extra[k]; });
      nodes.push(n); byId[id] = n; return n;
    }
    (project.pages || []).forEach(function (p) {
      add(p.id, "page", p.title || "(페이지)", { pageType: p.type });
      (p.rows || []).forEach(function (r) {
        (r.choices || []).forEach(function (c) { add(c.id, "choice", c.title || "(선택지)", { pageId: p.id, rowTitle: r.title }); });
      });
    });

    var edges = [];
    function edge(s, t, kind, label) {
      if (!byId[s] || !byId[t] || s === t) return;
      edges.push({ s: byId[s], t: byId[t], kind: kind, label: label || "" });
    }
    (project.pages || []).forEach(function (p) {
      (p.rows || []).forEach(function (r) {
        (r.choices || []).forEach(function (c) {
          edge(p.id, c.id, "contain");
          (c.requirements || []).forEach(function (req) {
            if (req.kind === "choice") edge(req.id, c.id, req.mode === "notSelected" ? "reqNot" : "req");
          });
        });
      });
      (p.links || []).forEach(function (l) {
        edge(p.id, l.target, "link", l.label);
        (l.requirements || []).forEach(function (req) { if (req.kind === "choice") edge(req.id, l.target, "gate"); });
      });
    });
    return { nodes: nodes, edges: edges, byId: byId };
  }

  /* ---------- 노드 크기 ---------- */
  function sizeOf(n) {
    var fs = n.type === "page" ? 13 : 11.5;
    var label = trunc(n.label, n.type === "page" ? 18 : 16);
    var w = Math.max(n.type === "page" ? 78 : 56, label.length * fs * 0.62 + 20);
    var h = n.type === "page" ? 30 : 24;
    n._w = w; n._h = h; n._fs = fs; n._disp = label;
    n._r = Math.max(w, h) / 2;
    return n;
  }

  /* ---------- 레이아웃 (Fruchterman–Reingold) ---------- */
  function makeLayout(model, W, H) {
    var n = model.nodes.length || 1;
    var area = Math.max(W * H, 1);
    var k = 0.82 * Math.sqrt(area / n);
    var temp = Math.min(W, H) / 6;

    // 초기 배치: 페이지는 큰 원, 선택지는 소속 페이지 주변
    var pages = model.nodes.filter(function (x) { return x.type === "page"; });
    var R = Math.min(W, H) * 0.34;
    pages.forEach(function (p, i) {
      var a = (i / Math.max(pages.length, 1)) * Math.PI * 2;
      p.x = Math.cos(a) * R; p.y = Math.sin(a) * R;
    });
    model.nodes.forEach(function (c) {
      if (c.type === "choice") {
        var par = model.byId[c.pageId];
        var bx = par ? par.x : 0, by = par ? par.y : 0;
        c.x = bx + (Math.random() - 0.5) * 80;
        c.y = by + (Math.random() - 0.5) * 80;
      }
    });

    function step() {
      var nodes = model.nodes, edges = model.edges, i, j;
      for (i = 0; i < nodes.length; i++) { nodes[i].dx = 0; nodes[i].dy = 0; }
      // 반발
      for (i = 0; i < nodes.length; i++) {
        for (j = i + 1; j < nodes.length; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var f = (k * k) / d;
          var ux = dx / d, uy = dy / d;
          a.dx += ux * f; a.dy += uy * f;
          b.dx -= ux * f; b.dy -= uy * f;
        }
      }
      // 인력(간선)
      for (i = 0; i < edges.length; i++) {
        var e = edges[i], s = e.s, t = e.t;
        var ddx = s.x - t.x, ddy = s.y - t.y;
        var dd = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
        var w = e.kind === "contain" ? 2.2 : 1.0;       // 포함은 더 강하게 묶기
        var fa = (dd * dd) / k * 0.9 * w;
        var uxx = ddx / dd, uyy = ddy / dd;
        s.dx -= uxx * fa / 1; s.dy -= uyy * fa;
        t.dx += uxx * fa; t.dy += uyy * fa;
      }
      // 중심 인력 + 적용
      for (i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        nd.dx += -nd.x * 0.015;
        nd.dy += -nd.y * 0.015;
        if (nd.fixed) continue;
        var dl = Math.sqrt(nd.dx * nd.dx + nd.dy * nd.dy) || 0.01;
        nd.x += (nd.dx / dl) * Math.min(dl, temp);
        nd.y += (nd.dy / dl) * Math.min(dl, temp);
      }
      temp = Math.max(temp * 0.95, 0.6);
      return temp;
    }
    return { step: step, reheat: function (v) { temp = v || Math.min(W, H) / 8; }, temp: function () { return temp; } };
  }

  /* ---------- 메인 ---------- */
  function open(project, opts) {
    opts = opts || {};
    var model = buildModel(project);
    model.nodes.forEach(sizeOf);

    // 오버레이 DOM
    var overlay = document.createElement("div");
    overlay.className = "graph-overlay";
    overlay.innerHTML =
      '<div class="graph-head">' +
        '<span class="graph-title">🕸 선택지 연결망</span>' +
        '<span class="graph-legend">' +
          '<i class="lg lg-req"></i>요구(선택함) ' +
          '<i class="lg lg-reqnot"></i>요구(선택안함) ' +
          '<i class="lg lg-gate"></i>이동 게이트 ' +
          '<i class="lg lg-link"></i>페이지 이동 ' +
          '<i class="lg lg-contain"></i>포함' +
        '</span>' +
        '<span class="graph-stats" id="gStats"></span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-sm" id="gRelayout">재배치</button>' +
        '<button class="btn btn-sm" id="gFit">맞춤</button>' +
        '<button class="btn btn-sm primary" id="gClose">닫기</button>' +
      '</div>' +
      '<div class="graph-canvas"><svg class="graph-svg" id="gSvg"></svg></div>' +
      '<div class="graph-hint">노드 <b>드래그</b>로 이동 · 빈 곳 드래그로 <b>이동(팬)</b> · 휠 <b>확대/축소</b> · 노드 <b>더블클릭</b>으로 편집 · 호버로 연결 강조</div>';
    document.body.appendChild(overlay);

    var svg = overlay.querySelector("#gSvg");
    var rect = svg.getBoundingClientRect();
    var W = rect.width || 900, H = rect.height || 560;

    // defs: 화살표 마커
    var defs = svgEl("defs");
    [["arrow-req", "var(--accent)"], ["arrow-reqnot", "var(--danger)"], ["arrow-gate", "var(--accent)"], ["arrow-link", "#5b8cd6"]].forEach(function (m) {
      var mk = svgEl("marker", { id: m[0], viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
      mk.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", fill: m[1] }));
      defs.appendChild(mk);
    });
    svg.appendChild(defs);

    var gRoot = svgEl("g");           // 줌/팬 변환 적용 대상
    var gEdges = svgEl("g");
    var gNodes = svgEl("g");
    gRoot.appendChild(gEdges); gRoot.appendChild(gNodes);
    svg.appendChild(gRoot);

    var T = { x: W / 2, y: H / 2, k: 1 };
    function applyT() { gRoot.setAttribute("transform", "translate(" + T.x + "," + T.y + ") scale(" + T.k + ")"); }
    applyT();

    /* --- 간선/노드 DOM 1회 생성, 이후 좌표만 갱신 --- */
    var edgeEls = model.edges.map(function (e) {
      var path = svgEl("path", { class: "g-edge g-edge-" + e.kind, fill: "none" });
      if (e.kind === "req") path.setAttribute("marker-end", "url(#arrow-req)");
      else if (e.kind === "reqNot") path.setAttribute("marker-end", "url(#arrow-reqnot)");
      else if (e.kind === "gate") path.setAttribute("marker-end", "url(#arrow-gate)");
      else if (e.kind === "link") path.setAttribute("marker-end", "url(#arrow-link)");
      gEdges.appendChild(path);
      return { e: e, path: path };
    });

    var nodeEls = model.nodes.map(function (n) {
      var g = svgEl("g", { class: "g-node g-node-" + n.type + (n.type === "page" ? " g-page-" + (n.pageType || "story") : ""), "data-id": n.id });
      var shape;
      if (n.type === "page") shape = svgEl("rect", { x: -n._w / 2, y: -n._h / 2, width: n._w, height: n._h, rx: 8 });
      else shape = svgEl("rect", { x: -n._w / 2, y: -n._h / 2, width: n._w, height: n._h, rx: n._h / 2 });
      shape.setAttribute("class", "g-shape");
      var txt = svgEl("text", { "text-anchor": "middle", dy: ".35em" });
      txt.setAttribute("font-size", n._fs);
      txt.textContent = n._disp;
      var title = svgEl("title"); title.textContent = (n.type === "page" ? "[페이지] " : "[선택지] ") + n.label;
      g.appendChild(shape); g.appendChild(txt); g.appendChild(title);
      gNodes.appendChild(g);
      return { n: n, g: g };
    });
    overlay.querySelector("#gStats").textContent = "노드 " + model.nodes.length + " · 연결 " + model.edges.filter(function (e) { return e.kind !== "contain"; }).length;

    // 노드 빠른 조회
    var elByNode = {}; nodeEls.forEach(function (ne) { elByNode[ne.n.id] = ne; });
    // 인접 맵(호버 강조용)
    var adj = {}; model.nodes.forEach(function (n) { adj[n.id] = {}; });
    model.edges.forEach(function (e) { adj[e.s.id][e.t.id] = true; adj[e.t.id][e.s.id] = true; });

    function curvePath(a, b) {
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / dist, uy = dy / dist;
      // 양 끝을 노드 경계 근처에서 시작/종료
      var sx = a.x + ux * (a._r * 0.7), sy = a.y + uy * (a._r * 0.7);
      var ex = b.x - ux * (b._r * 0.78), ey = b.y - uy * (b._r * 0.78);
      // 살짝 곡선
      var mx = (sx + ex) / 2 + (-uy) * dist * 0.08;
      var my = (sy + ey) / 2 + (ux) * dist * 0.08;
      return "M" + sx.toFixed(1) + "," + sy.toFixed(1) + " Q" + mx.toFixed(1) + "," + my.toFixed(1) + " " + ex.toFixed(1) + "," + ey.toFixed(1);
    }
    function renderPositions() {
      edgeEls.forEach(function (ee) { ee.path.setAttribute("d", curvePath(ee.e.s, ee.e.t)); });
      nodeEls.forEach(function (ne) { ne.g.setAttribute("transform", "translate(" + ne.n.x.toFixed(1) + "," + ne.n.y.toFixed(1) + ")"); });
    }

    /* --- 레이아웃 애니메이션 --- */
    var layout = makeLayout(model, W, H);
    var raf = null, fitted = false;
    function tick() {
      var temp = layout.step();
      renderPositions();
      if (!fitted && temp < 2) { fit(); fitted = true; }
      if (temp > 0.7) raf = requestAnimationFrame(tick);
      else raf = null;
    }
    function startSim() { if (raf) cancelAnimationFrame(raf); fitted = false; raf = requestAnimationFrame(tick); }

    function fit() {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      model.nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n._w / 2); maxX = Math.max(maxX, n.x + n._w / 2);
        minY = Math.min(minY, n.y - n._h / 2); maxY = Math.max(maxY, n.y + n._h / 2);
      });
      if (minX === Infinity) return;
      var bw = maxX - minX, bh = maxY - minY, pad = 40;
      var r2 = svg.getBoundingClientRect(); W = r2.width; H = r2.height;
      var k = Math.min((W - pad * 2) / Math.max(bw, 1), (H - pad * 2) / Math.max(bh, 1), 1.6);
      T.k = k;
      T.x = W / 2 - ((minX + maxX) / 2) * k;
      T.y = H / 2 - ((minY + maxY) / 2) * k;
      applyT();
    }

    /* --- 상호작용 --- */
    var dragNode = null, panning = false, last = null, moved = false;
    function screenToGraph(cx, cy) {
      var r = svg.getBoundingClientRect();
      return { x: (cx - r.left - T.x) / T.k, y: (cy - r.top - T.y) / T.k };
    }
    function nodeFromEvent(ev) {
      var el = ev.target.closest ? ev.target.closest("[data-id]") : null;
      return el ? elByNode[el.getAttribute("data-id")] : null;
    }
    svg.addEventListener("pointerdown", function (ev) {
      moved = false;
      var ne = nodeFromEvent(ev);
      if (ne) { dragNode = ne.n; dragNode.fixed = true; }
      else { panning = true; }
      last = { x: ev.clientX, y: ev.clientY };
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      if (!last) return;
      var ddx = ev.clientX - last.x, ddy = ev.clientY - last.y;
      if (Math.abs(ddx) + Math.abs(ddy) > 2) moved = true;
      if (dragNode) {
        var p = screenToGraph(ev.clientX, ev.clientY);
        dragNode.x = p.x; dragNode.y = p.y;
        layout.reheat(Math.min(W, H) / 12);
        if (!raf) startSim();
        renderPositions();
      } else if (panning) {
        T.x += ddx; T.y += ddy; applyT();
      }
      last = { x: ev.clientX, y: ev.clientY };
    });
    svg.addEventListener("pointerup", function (ev) {
      if (dragNode) dragNode.fixed = false;
      dragNode = null; panning = false; last = null;
      try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
    });
    svg.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = svg.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      T.x = mx - (mx - T.x) * factor;
      T.y = my - (my - T.y) * factor;
      T.k *= factor;
      applyT();
    }, { passive: false });

    // 호버 강조
    gNodes.addEventListener("pointerover", function (ev) {
      var ne = nodeFromEvent(ev); if (!ne) return;
      var id = ne.n.id;
      overlay.classList.add("hovering");
      nodeEls.forEach(function (x) { x.g.classList.toggle("dim", x.n.id !== id && !adj[id][x.n.id]); x.g.classList.toggle("hot", x.n.id === id); });
      edgeEls.forEach(function (ee) {
        var on = ee.e.s.id === id || ee.e.t.id === id;
        ee.path.classList.toggle("dim", !on); ee.path.classList.toggle("hot", on);
      });
    });
    gNodes.addEventListener("pointerout", function () {
      overlay.classList.remove("hovering");
      nodeEls.forEach(function (x) { x.g.classList.remove("dim", "hot"); });
      edgeEls.forEach(function (ee) { ee.path.classList.remove("dim", "hot"); });
    });
    // 더블클릭 → 편집
    gNodes.addEventListener("dblclick", function (ev) {
      var ne = nodeFromEvent(ev); if (!ne) return;
      if (opts.onEditNode) { close(); opts.onEditNode(ne.n.type, ne.n.id); }
    });

    /* --- 버튼 --- */
    function close() { if (raf) cancelAnimationFrame(raf); overlay.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    overlay.querySelector("#gClose").addEventListener("click", close);
    overlay.querySelector("#gRelayout").addEventListener("click", function () {
      model.nodes.forEach(function (n) { n.fixed = false; });
      var l2 = makeLayout(model, W, H); layout.step = l2.step; layout.reheat = l2.reheat; layout.temp = l2.temp;
      startSim();
    });
    overlay.querySelector("#gFit").addEventListener("click", fit);

    if (!model.nodes.length) {
      gNodes.appendChild((function () { var t = svgEl("text", { x: 0, y: 0, "text-anchor": "middle", fill: "var(--muted)" }); t.textContent = "표시할 선택지/페이지가 없습니다."; return t; })());
    }
    startSim();
  }

  global.CYOAGraph = { open: open };
})(window);
