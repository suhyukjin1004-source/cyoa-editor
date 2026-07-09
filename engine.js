/* ===========================================================
   CYOA 공유 엔진 (engine.js)
   - 데이터 모델 헬퍼, 요구조건 평가, 통화 계산
   - HTML 새니타이저, 테마 주입
   - 무대(stage) 렌더러: 뷰어 재생 + 에디터 미리보기/편집 공용
   전역 window.CYOA 로 노출 (모듈 불필요 → file:// 및 단일파일 인라인에 안전).
   =========================================================== */
(function (global) {
  "use strict";

  /* ---------------- 기본 유틸 ---------------- */
  function genId(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // 사용자(작품 데이터)가 지정한 색을 CSS 색상 값으로만 허용 — 그 외(속성 탈출·CSS 주입)는 기본값으로.
  // #hex / rgb()·rgba()·hsl()·hsla() / 색 이름(영문·공백)만 통과. 신뢰 못 하는 project.json 방어.
  function safeColor(v, fallback) {
    fallback = fallback || "var(--accent)";
    if (typeof v !== "string") return fallback;
    var s = v.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\sA-Za-z/]+\)$/.test(s)) return s;
    if (/^[A-Za-z][A-Za-z\s]{0,24}$/.test(s)) return s; // 색 이름(예: rebeccapurple)
    if (/^var\(--[a-zA-Z0-9-]+\)$/.test(s)) return s;
    return fallback;
  }

  /* ---------------- HTML 새니타이저 (화이트리스트) ---------------- */
  var ALLOWED = {
    P: [], BR: [], STRONG: [], EM: [], B: [], I: [], U: [], S: [],
    UL: [], OL: [], LI: [], H3: [], H4: [], BLOCKQUOTE: [], SPAN: [], HR: [], A: ["href"]
  };
  function cleanNode(node) {
    var out = document.createElement(node.tagName || "DIV");
    var kids = node.childNodes, i;
    for (i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 3) {
        out.appendChild(document.createTextNode(child.nodeValue));
      } else if (child.nodeType === 1) {
        var tag = child.tagName;
        if (ALLOWED[tag]) {
          var el = document.createElement(tag);
          ALLOWED[tag].forEach(function (attr) {
            if (child.hasAttribute(attr)) {
              var v = child.getAttribute(attr);
              if (attr === "href" && !/^(https?:|#|mailto:)/i.test(v)) return;
              el.setAttribute(attr, v);
              if (tag === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
            }
          });
          // 정리된 자식 노드를 직접 이동 — innerHTML 로 문자열화→재파싱하는 라운드트립을 피해
          // mXSS(재직렬화 과정에서 위험 노드가 되살아나는 변형 XSS) 여지를 없앤다.
          var inner = cleanNode(child);
          while (inner.firstChild) el.appendChild(inner.firstChild);
          out.appendChild(el);
        } else {
          // 허용되지 않은 태그: 내용만 보존
          var innerU = cleanNode(child);
          while (innerU.firstChild) out.appendChild(innerU.firstChild);
        }
      }
    }
    return out;
  }
  function sanitizeHtml(html) {
    if (!html) return "";
    var doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    return cleanNode(doc.body.firstChild).innerHTML;
  }
  // 줄바꿈 자동 변환: 블록 태그가 없으면 엔터=<br>, 빈 줄=문단으로.
  // (사용자가 <p> 등 블록 HTML을 직접 쓰면 그대로 둠 → 기존 방식과 호환)
  function hasBlockTags(s) { return /<\s*(p|br|ul|ol|li|h3|h4|blockquote|hr|div)\b/i.test(s || ""); }
  function formatRich(text, paragraphs) {
    if (text == null) return "";
    if (hasBlockTags(text)) return text;
    var t = String(text);
    if (paragraphs) {
      return t.split(/\n{2,}/).map(function (b) {
        b = b.replace(/\n/g, "<br>");
        return b.trim() ? "<p>" + b + "</p>" : "";
      }).join("");
    }
    return t.replace(/\n/g, "<br>");
  }
  // 동적 단어 해석: 첫 통과 rule.value, 없으면 default
  function resolveWord(project, state, id) {
    var w = (project.words || []).find(function (x) { return x.id === id; });
    if (!w) return "";
    var rules = w.rules || [];
    for (var i = 0; i < rules.length; i++) {
      if (evaluateRequirements(rules[i].requirements, project, state).ok) return rules[i].value;
    }
    return w.default || "";
  }
  // 인라인 조건 텍스트 {{if:조건}}…{{else}}…{{/if}} — 조건은 R1 요구조건 평가를 재사용.
  // 조건 형식: choice:ID | !choice:ID | var:ID [OP N] | !var:ID | cur:ID [OP N] | group:ID [OP N] | global:ID
  function parseInlineReq(cond, project) {
    var m = /^(choice|var|cur|group|global)\s*:\s*([^\s<>=!]+)\s*(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)?$/.exec(cond);
    if (!m) return null;
    var ns = m[1], id = m[2], op = m[3], val = m[4];
    if (ns === "choice") return { kind: "choice", id: id, mode: "selected" };
    if (ns === "cur") return op ? { kind: "currency", id: id, op: op, value: Number(val) } : { kind: "currency", id: id, op: "!=", value: 0 };
    if (ns === "group") return op ? { kind: "group", id: id, op: op, value: Number(val) } : { kind: "group", id: id, op: ">=", value: 1 };
    if (ns === "global") return { kind: "global", id: id };
    var def = variableDef(project, id);
    if (op) return { kind: "var", id: id, op: op, value: Number(val) };
    if (def && def.type === "flag") return { kind: "var", id: id, op: "isTrue" };
    return { kind: "var", id: id, op: "!=", value: 0 }; // 수치: 0이 아니면 참
  }
  function evalInlineCond(cond, project, state) {
    cond = (cond || "").trim();
    var neg = false;
    if (cond.charAt(0) === "!") { neg = true; cond = cond.slice(1).trim(); }
    var req = parseInlineReq(cond, project);
    var ok = req ? evaluateRequirements([req], project, state).ok : false;
    return neg ? !ok : ok;
  }
  function resolveConditionals(text, project, state) {
    var guard = 0;
    while (guard++ < 2000) {
      var open = text.indexOf("{{if:");
      if (open === -1) break;
      var condEnd = text.indexOf("}}", open);
      if (condEnd === -1) break; // 깨진 토큰 — 그대로 둠
      var cond = text.slice(open + 5, condEnd);
      var i = condEnd + 2, depth = 1, elsePos = -1, closeStart = -1;
      while (i < text.length) {
        var nIf = text.indexOf("{{if:", i), nElse = text.indexOf("{{else}}", i), nEnd = text.indexOf("{{/if}}", i);
        if (nEnd === -1) break; // 닫힘 없음
        var next = nEnd, kind = "end";
        if (nIf !== -1 && nIf < next) { next = nIf; kind = "if"; }
        if (nElse !== -1 && nElse < next) { next = nElse; kind = "else"; }
        if (kind === "if") { depth++; i = next + 5; }
        else if (kind === "else") { if (depth === 1 && elsePos === -1) elsePos = next; i = next + 8; }
        else { depth--; if (depth === 0) { closeStart = next; break; } i = next + 7; }
      }
      if (closeStart === -1) break; // 매칭 실패 — 무한루프 방지
      var bodyStart = condEnd + 2, ifBody, elseBody;
      if (elsePos !== -1) { ifBody = text.slice(bodyStart, elsePos); elseBody = text.slice(elsePos + 8, closeStart); }
      else { ifBody = text.slice(bodyStart, closeStart); elseBody = ""; }
      var chosen = evalInlineCond(cond, project, state) ? ifBody : elseBody;
      text = text.slice(0, open) + chosen + text.slice(closeStart + 7);
    }
    return text;
  }
  // 본문 처리: {{if:…}} 조건 → {{cur:id}}/{{var:id}}/{{word:id}} 토큰 치환
  function interpolate(text, project, state) {
    if (text == null) return "";
    text = resolveConditionals(String(text), project, state);
    var totals = null, vars = null;
    return text.replace(/\{\{\s*(cur|word|var)\s*:\s*([^}\s]+)\s*\}\}/g, function (m, kind, id) {
      if (kind === "cur") { if (!totals) totals = computeCurrencies(project, state); var v = totals[id]; return (v == null ? 0 : v); }
      if (kind === "var") { if (!vars) vars = computeVars(project, state); var vv = vars[id]; return vv === undefined ? "" : vv === true ? "예" : vv === false ? "아니오" : vv; }
      return resolveWord(project, state, id);
    });
  }

  /* ---------------- 데이터 헬퍼 ---------------- */
  function findPage(project, id) {
    return (project.pages || []).find(function (p) { return p.id === id; }) || null;
  }
  function eachRow(project, fn) {
    (project.pages || []).forEach(function (pg) {
      (pg.rows || []).forEach(function (r) { fn(r, pg); });
    });
  }
  function allChoices(project) {
    var out = [];
    eachRow(project, function (r) { (r.choices || []).forEach(function (c) { out.push(c); }); });
    return out;
  }
  // id→choice 맵을 1회 구성(반복 조회용). findChoice 전체 스캔을 반복하던 O(n²) 경로를 대체.
  // findChoice/findRowOfChoice 와 동일하게 '첫' 항목 우선(중복 id가 있어도 동작 일치).
  function buildChoiceMap(project) {
    var m = {};
    eachRow(project, function (r) { (r.choices || []).forEach(function (c) { if (!(c.id in m)) m[c.id] = c; }); });
    return m;
  }
  function findChoice(project, id) {
    return allChoices(project).find(function (c) { return c.id === id; }) || null;
  }
  function findRowOfChoice(project, id) {
    var found = null;
    eachRow(project, function (r) {
      if ((r.choices || []).some(function (c) { return c.id === id; })) found = r;
    });
    return found;
  }
  function currencyDef(project, id) {
    return (project.currencies || []).find(function (c) { return c.id === id; }) || null;
  }
  function variableDef(project, id) {
    return (project.variables || []).find(function (v) { return v.id === id; }) || null;
  }
  function currencyAllowsNeg(project, id) {
    var d = currencyDef(project, id);
    return !!(project.settings && project.settings.allowNegativeCurrency) || !!(d && d.allowNegative);
  }
  function groupDef(project, id) {
    return (project.groups || []).find(function (g) { return g.id === id; }) || null;
  }
  function globalReqDef(project, id) {
    return (project.globalRequirements || []).find(function (g) { return g.id === id; }) || null;
  }
  // 그룹에 속한 선택지 중 현재 선택된 개수(선택지 단위 — 다중 카운트 ×N은 세지 않음)
  function countGroupSelected(project, state, groupId) {
    var n = 0;
    eachRow(project, function (r) {
      (r.choices || []).forEach(function (c) {
        if ((c.groups || []).indexOf(groupId) !== -1 && isSelected(state, c.id)) n++;
      });
    });
    return n;
  }

  /* ---------------- 상태 ---------------- */
  function newState(project) {
    return {
      selected: [],            // 선택된 choice id 배열
      counts: {},              // 다중 선택 카운트 { choiceId: n }
      eventScores: {},         // 링크로 획득/소모한 통화 누적
      varEvents: [],           // 링크가 1회성으로 남긴 변수 효과 로그(방문 순서대로 재생)
      takenLinks: [],          // 1회성 점수/효과 중복 방지용 링크 키
      currentPageId: (project.settings && project.settings.startPageId) || ((project.pages[0] || {}).id),
      history: []
    };
  }
  function isSelected(state, id) { return state.selected.indexOf(id) !== -1; }
  function getCount(state, id) {
    var n = state.counts ? state.counts[id] : undefined;
    if (n != null) return n;
    return isSelected(state, id) ? 1 : 0;
  }
  function isMulti(choice) { return !!(choice && choice.selectMultiple && choice.selectMultiple.enabled); }

  /* ---------------- 통화 계산 ----------------
     점수 항목은 선택적으로 requirements 를 가질 수 있다(조건부 점수/할인).
     조건이 통화 값을 참조할 수 있어 순진하게 계산하면 재귀가 생기므로 2-패스로 처리:
       1패스) requirements 없는 무조건 항목만 합산 → base
       2패스) 조건부 항목은 base 통화를 넘겨 평가(재계산 안 함)해 가산.
     따라서 "통화 ≥ N" 같은 조건은 **할인 전(base) 값** 기준으로 판정된다(결정적). */
  // 한 점수 항목이 지금 유효한지 — 조건 없으면 항상, 있으면 base 기준 평가.
  function scoreEntryActive(s, project, state, baseTotals) {
    if (!s.requirements || !s.requirements.length) return true;
    return evaluateRequirements(s.requirements, project, state, baseTotals).ok;
  }
  // 한 선택지에서 지금 유효한 점수 항목만 반환(비용·표시 계산의 단일 소스).
  function activeScores(choice, project, state, baseTotals) {
    if (!choice || !choice.scores) return [];
    return choice.scores.filter(function (s) { return scoreEntryActive(s, project, state, baseTotals); });
  }
  function computeCurrencies(project, state) {
    var base = {};
    (project.currencies || []).forEach(function (c) {
      base[c.id] = (typeof c.start === "number" ? c.start : 0);
    });
    // 선택지 id→choice 맵을 한 번만 구성(선택마다 findChoice 전체 스캔하던 O(n²) 제거). 선택이 있을 때만 빌드.
    var byId = null, selectedRefs = [];
    state.selected.forEach(function (cid) {
      if (!byId) byId = buildChoiceMap(project);
      var ch = byId[cid]; if (!ch) return;
      var cnt = getCount(state, cid) || 1;
      selectedRefs.push({ ch: ch, cnt: cnt });
      // 1패스: 무조건 항목만
      (ch.scores || []).forEach(function (s) {
        if (s.requirements && s.requirements.length) return;
        if (base[s.currency] === undefined) base[s.currency] = 0;
        base[s.currency] += (Number(s.value) || 0) * cnt;
      });
    });
    Object.keys(state.eventScores || {}).forEach(function (cid) {
      if (base[cid] === undefined) base[cid] = 0;
      base[cid] += Number(state.eventScores[cid]) || 0;
    });
    // 조건부 항목이 하나도 없으면 base 가 곧 최종값(빠른 경로).
    var hasConditional = selectedRefs.some(function (r) {
      return (r.ch.scores || []).some(function (s) { return s.requirements && s.requirements.length; });
    });
    if (!hasConditional) return base;
    // 2패스: 조건부 항목을 base 기준으로 평가해 가산.
    var totals = {}; Object.keys(base).forEach(function (k) { totals[k] = base[k]; });
    selectedRefs.forEach(function (r) {
      (r.ch.scores || []).forEach(function (s) {
        if (!s.requirements || !s.requirements.length) return;
        if (!evaluateRequirements(s.requirements, project, state, base).ok) return;
        if (totals[s.currency] === undefined) totals[s.currency] = 0;
        totals[s.currency] += (Number(s.value) || 0) * r.cnt;
      });
    });
    return totals;
  }

  /* ---------------- 변수(상태/깃발) 계산 ----------------
     통화와 달리 예산 잠금이 없는 자유 상태. type: number | flag.
     선언적(선택지 effects: 합산/OR, 되돌릴 수 있음) + 명령적(링크 varEvents: 순서대로) 조합. */
  function applyVarEffect(out, def, e, cnt, declarative) {
    if (!def) return;
    if (def.type === "flag") {
      if (e.op === "on") out[def.id] = true;
      else if (e.op === "off" && !declarative) out[def.id] = false; // off(끄기)는 명령적(링크)만
    } else {
      var n = (Number(e.value) || 0) * (cnt || 1);
      out[def.id] = (Number(out[def.id]) || 0) + (e.op === "sub" ? -n : n);
    }
  }
  function computeVars(project, state) {
    var out = {};
    (project.variables || []).forEach(function (v) {
      out[v.id] = (v.type === "flag") ? !!v.initial : (Number(v.initial) || 0);
    });
    // 1) 선언적: 선택된 choice의 effects (다중카운트만큼 곱)
    var byId = null;
    (state.selected || []).forEach(function (cid) {
      if (!byId) byId = buildChoiceMap(project);
      var ch = byId[cid]; if (!ch || !ch.effects) return;
      var cnt = getCount(state, cid) || 1;
      ch.effects.forEach(function (e) { applyVarEffect(out, variableDef(project, e.var), e, cnt, true); });
    });
    // 2) 명령적: 링크가 남긴 효과 로그(방문 순서대로 — off/덮어쓰기는 마지막 쓰기 우선)
    (state.varEvents || []).forEach(function (e) { applyVarEffect(out, variableDef(project, e.var), e, 1, false); });
    return out;
  }

  /* ---------------- 요구조건 평가 (배열 = AND) ----------------
     _seenGlobals: 글로벌 조건 세트가 서로를 참조할 때의 순환 가드(재귀 경로의 방문 집합) */
  function evaluateRequirements(reqs, project, state, totals, _seenGlobals) {
    var reasons = [];
    if (!reqs || !reqs.length) return { ok: true, reasons: reasons };
    totals = totals || computeCurrencies(project, state);
    var varsCache = null;
    reqs.forEach(function (req) {
      if (req.kind === "choice") {
        var sel = isSelected(state, req.id);
        var want = req.mode !== "notSelected";
        if (sel !== want) {
          var ch = findChoice(project, req.id);
          var nm = ch ? ch.title : req.id;
          reasons.push(want ? ("'" + nm + "' 선택 필요") : ("'" + nm + "' 선택 시 불가"));
        }
      } else if (req.kind === "currency") {
        var v = totals[req.id];
        if (v === undefined) v = 0;
        var ok = compare(v, req.op, Number(req.value) || 0);
        if (!ok) {
          var cd = currencyDef(project, req.id);
          reasons.push((cd ? cd.name : req.id) + " " + req.op + " " + req.value + " 필요");
        }
      } else if (req.kind === "oneOf") {
        var ids = req.ids || [];
        if (!ids.length) return; // 빈 그룹은 통과(무시)
        var anySel = ids.some(function (id) { return isSelected(state, id); });
        var wantSel = req.mode !== "notSelected";
        if (wantSel ? !anySel : anySel) {
          var names = ids.map(function (id) { var c = findChoice(project, id); return c ? c.title : id; });
          reasons.push(wantSel ? ("'" + names.join(" / ") + "' 중 하나 선택 필요") : ("'" + names.join(" / ") + "' 모두 선택 안 함 필요"));
        }
      } else if (req.kind === "compare") {
        var va = totals[req.a]; if (va === undefined) va = 0;
        var vb = totals[req.b]; if (vb === undefined) vb = 0;
        if (!compare(va, req.op, vb)) {
          var ca = currencyDef(project, req.a), cb = currencyDef(project, req.b);
          reasons.push((ca ? ca.name : req.a) + " " + req.op + " " + (cb ? cb.name : req.b) + " 필요");
        }
      } else if (req.kind === "group") {
        var gd = groupDef(project, req.id);
        var gn = countGroupSelected(project, state, req.id);
        if (!compare(gn, req.op || ">=", Number(req.value) || 0)) {
          reasons.push("'" + (gd ? gd.name : req.id) + "' 그룹 선택 수 " + (req.op || ">=") + " " + (Number(req.value) || 0) + " 필요");
        }
      } else if (req.kind === "global") {
        var grd = globalReqDef(project, req.id);
        if (!grd) return; // 삭제된 세트 참조는 통과(무시)
        var seen = _seenGlobals || {};
        if (seen[req.id]) return; // 순환 참조 — 통과 처리로 무한 재귀 방지
        seen[req.id] = true;
        var sub = evaluateRequirements(grd.requirements, project, state, totals, seen);
        delete seen[req.id]; // 경로 이탈 — 다이아몬드 참조(서로 다른 경로의 같은 세트)는 허용
        if (!sub.ok) reasons.push("'" + (grd.name || req.id) + "' 조건 미충족 (" + sub.reasons.join(", ") + ")");
      } else if (req.kind === "var") {
        if (!varsCache) varsCache = computeVars(project, state);
        var vdef = variableDef(project, req.id);
        var vval = varsCache[req.id];
        if (vdef && vdef.type === "flag") {
          var want = req.op !== "isFalse"; // 기본 isTrue
          if (!!vval !== want) reasons.push("'" + (vdef ? vdef.name : req.id) + "' " + (want ? "필요" : "아님 필요"));
        } else {
          var nval = (vval === undefined ? 0 : Number(vval) || 0);
          if (!compare(nval, req.op, Number(req.value) || 0)) {
            reasons.push((vdef ? vdef.name : req.id) + " " + req.op + " " + req.value + " 필요");
          }
        }
      }
    });
    return { ok: reasons.length === 0, reasons: reasons };
  }
  function compare(a, op, b) {
    switch (op) {
      case ">=": return a >= b;
      case "<=": return a <= b;
      case ">": return a > b;
      case "<": return a < b;
      case "==": return a === b;
      case "!=": return a !== b;
      default: return true;
    }
  }

  /* ---------------- 선택지 상태 ---------------- */
  function choiceStatus(project, choice, row, state, totals) {
    totals = totals || computeCurrencies(project, state);
    var selected = isSelected(state, choice.id);
    var req = evaluateRequirements(choice.requirements, project, state, totals);
    // 예산: 이 선택지를 새로 고르면 음수 불가 통화가 0 미만이 되는가?
    // 조건부 점수 항목은 지금 조건을 만족하는 것만 비용에 반영(현재 통화 기준 평가).
    var budgetReasons = [];
    if (!selected && choice.scores) {
      activeScores(choice, project, state, totals).forEach(function (s) {
        if (currencyAllowsNeg(project, s.currency)) return;
        var after = (totals[s.currency] || 0) + (Number(s.value) || 0);
        if (after < 0) {
          var cd = currencyDef(project, s.currency);
          budgetReasons.push((cd ? cd.name : s.currency) + " 부족");
        }
      });
    }
    var reasons = req.reasons.concat(budgetReasons);
    var locked = !selected && reasons.length > 0;
    // 숨김 판정: 선택지별 설정이 있으면 우선, 없으면 프로젝트 전역 설정을 따름
    var globalHide = project.settings && project.settings.showLockedChoices === false;
    var hideThis = choice.hideWhenLocked === true ? true
      : choice.hideWhenLocked === false ? false : globalHide;
    var hidden = locked && hideThis;
    return { selected: selected, locked: locked, hidden: hidden, selectable: !locked, reasons: reasons };
  }

  /* ---------------- 선택 토글 ---------------- */
  function countSelectedInRow(state, row) {
    var n = 0;
    (row.choices || []).forEach(function (c) { if (isSelected(state, c.id)) n++; });
    return n;
  }
  function removeChoice(state, id) {
    state.selected = state.selected.filter(function (x) { return x !== id; });
    if (state.counts) delete state.counts[id];
  }
  function budgetOkForCount(project, state, choice, next) {
    var totals = computeCurrencies(project, state);
    var cur = getCount(state, choice.id), bad = false;
    activeScores(choice, project, state, totals).forEach(function (s) {
      if (currencyAllowsNeg(project, s.currency)) return;
      var delta = (Number(s.value) || 0) * (next - cur);
      if ((totals[s.currency] || 0) + delta < 0) bad = true;
    });
    return !bad;
  }
  // 확장 훅 "select" 발행(선택 변경 후 최종 상태 기준)
  function emitSelect(project, state, choiceId) {
    hooksEmit("select", { project: project, state: state, choiceId: choiceId, selected: isSelected(state, choiceId), count: getCount(state, choiceId) });
  }
  function toggleChoice(project, state, choiceId) {
    var row = findRowOfChoice(project, choiceId);
    var choice = findChoice(project, choiceId);
    if (!row || !choice) return false;
    if (isMulti(choice)) {
      if (getCount(state, choiceId) > 0) { removeChoice(state, choiceId); pruneInvalid(project, state); emitSelect(project, state, choiceId); return true; }
      return changeCount(project, state, choiceId, 1);
    }
    if (isSelected(state, choiceId)) {
      removeChoice(state, choiceId);
    } else {
      var st = choiceStatus(project, choice, row, state);
      if (!st.selectable) return false;
      var mode = (row.select && row.select.mode) || "multi";
      if (mode === "single") {
        (row.choices || []).forEach(function (c) { removeChoice(state, c.id); });
      } else {
        var max = row.select && row.select.max;
        if (max && countSelectedInRow(state, row) >= max) return false;
      }
      state.selected.push(choiceId);
    }
    pruneInvalid(project, state);
    emitSelect(project, state, choiceId);
    return true;
  }
  // 다중 선택지 카운트 증감
  function changeCount(project, state, choiceId, delta) {
    var row = findRowOfChoice(project, choiceId);
    var choice = findChoice(project, choiceId);
    if (!row || !choice) return false;
    if (!state.counts) state.counts = {};
    var sm = choice.selectMultiple || {};
    var min = Number(sm.min) || 0, max = Number(sm.max) || 0; // max 0 = 무제한
    var cur = getCount(state, choiceId), next;
    if (delta > 0) {
      if (cur === 0) {
        var st = choiceStatus(project, choice, row, state);
        if (!st.selectable) return false;
        var smode = (row.select && row.select.mode) || "multi";
        if (smode === "single") { (row.choices || []).forEach(function (c) { removeChoice(state, c.id); }); }
        else { var rmax = row.select && row.select.max; if (rmax && countSelectedInRow(state, row) >= rmax) return false; }
        next = Math.max(1, min);
      } else { next = cur + 1; if (max && next > max) return false; }
      if (!budgetOkForCount(project, state, choice, next)) return false;
      state.counts[choiceId] = next;
      if (!isSelected(state, choiceId)) state.selected.push(choiceId);
    } else {
      if (cur <= 0) return false;
      next = (cur - 1 < min) ? 0 : cur - 1;
      if (next <= 0) removeChoice(state, choiceId);
      else state.counts[choiceId] = next;
    }
    pruneInvalid(project, state);
    emitSelect(project, state, choiceId);
    return true;
  }
  // 재계산: 자동 활성/해제(forced) + 요구조건 깨진 선택 연쇄 해제. 안정점까지 반복.
  function pruneInvalid(project, state) {
    if (!state.counts) state.counts = {};
    var byId = buildChoiceMap(project);   // 구조는 루프 중 바뀌지 않으므로 1회만 구성
    var changed = true, guard = 0;
    while (changed && guard < 100) {
      changed = false; guard++;
      // 1) forced 집합(선택된 choice가 activates 하는 id)
      var forced = {};
      state.selected.slice().forEach(function (cid) {
        var ch = byId[cid]; if (!ch) return;
        (ch.activates || []).forEach(function (id) { forced[id] = true; });
      });
      // 2) 자동 해제(deactivates) → 자동 선택(activates)
      state.selected.slice().forEach(function (cid) {
        var ch = byId[cid]; if (!ch) return;
        (ch.deactivates || []).forEach(function (id) {
          if (isSelected(state, id) && !forced[id]) { removeChoice(state, id); changed = true; }
        });
        (ch.activates || []).forEach(function (id) {
          if (byId[id] && !isSelected(state, id)) {
            state.selected.push(id); state.counts[id] = state.counts[id] || 1; changed = true;
          }
        });
      });
      // 3) 요구조건 깨진 선택 해제 (forced 는 유지)
      var totals = computeCurrencies(project, state);
      state.selected.slice().forEach(function (cid) {
        if (forced[cid]) return;
        var ch = byId[cid];
        if (!ch) { removeChoice(state, cid); changed = true; return; }
        var r = evaluateRequirements(ch.requirements, project, state, totals);
        if (!r.ok) { removeChoice(state, cid); changed = true; }
      });
    }
  }

  /* ---------------- 페이지 이동 ---------------- */
  function navigate(project, state, link) {
    var req = evaluateRequirements(link.requirements, project, state);
    if (!req.ok) return false;
    var from = state.currentPageId;
    var key = from + "->" + link.target + "#" + (link.label || "");
    state.history.push(from);
    state.currentPageId = link.target;
    var hasOnce = (link.scores && link.scores.length) || (link.effects && link.effects.length);
    if (hasOnce && state.takenLinks.indexOf(key) === -1) {
      state.takenLinks.push(key);
      (link.scores || []).forEach(function (s) {
        state.eventScores[s.currency] = (state.eventScores[s.currency] || 0) + (Number(s.value) || 0);
      });
      if (!state.varEvents) state.varEvents = [];
      (link.effects || []).forEach(function (e) { state.varEvents.push({ var: e.var, op: e.op, value: e.value }); });
    }
    hooksEmit("navigate", { project: project, state: state, link: link, from: from, to: link.target });
    return true;
  }
  function goBack(state) {
    if (!state.history.length) return false;
    state.currentPageId = state.history.pop();
    return true;
  }

  /* ---------------- 랜덤 선택(주사위) ----------------
     행의 후보(보이는·선택 가능·미선택) 중 하나를 무작위로 골라 토글.
     단일 행은 toggleChoice 가 기존 선택을 교체하고, 다중 행은 남은 슬롯에 추가.
     성공 시 선택된 choice id, 굴릴 후보가 없으면 null. */
  function rollRandomChoice(project, state, row) {
    var totals = computeCurrencies(project, state);
    var cands = (row.choices || []).filter(function (c) {
      if (isSelected(state, c.id)) return false;
      var st = choiceStatus(project, c, row, state, totals);
      return !st.hidden && st.selectable;
    });
    while (cands.length) {
      var i = Math.floor(Math.random() * cands.length);
      var pick = cands.splice(i, 1)[0];
      if (toggleChoice(project, state, pick.id)) {
        hooksEmit("roll", { project: project, state: state, row: row, choiceId: pick.id });
        return pick.id;
      }
    }
    return null;
  }

  /* ---------------- 선택 요약(백팩·결과 이미지 공용) ----------------
     행 순서대로 선택된 선택지를 구조화해 반환: [{ row, title, choices:[choice…] }] */
  function collectBuildSummary(project, state) {
    var out = [];
    (project.pages || []).forEach(function (pg) {
      (pg.rows || []).forEach(function (r) {
        var sel = (r.choices || []).filter(function (c) { return isSelected(state, c.id); });
        if (sel.length) out.push({ row: r, title: r.title || "", choices: sel });
      });
    });
    return out;
  }

  /* ---------------- 배경 음악(BGM) 판정 ----------------
     반환 { action:"play"|"stop"|"keep", src } — 호스트(뷰어/에디터)가 오디오를 제어 */
  function pageAudio(project, state) {
    var flow = project.settings && project.settings.flow;
    if (flow === "scroll") {
      // 스크롤형: 처음으로 bgm이 지정된 페이지의 곡을 전체 배경으로
      var src = null;
      (project.pages || []).some(function (p) { if (p.bgm && !p.bgmStop) { src = p.bgm; return true; } return false; });
      return src ? { action: "play", src: src } : { action: "keep" };
    }
    var pg = findPage(project, state.currentPageId) || (project.pages || [])[0];
    if (!pg) return { action: "keep" };
    if (pg.bgmStop) return { action: "stop" };
    if (pg.bgm) return { action: "play", src: pg.bgm };
    return { action: "keep" };   // 음악 미지정 페이지 → 이전 곡 계속
  }

  /* ---------------- 테마 ---------------- */
  function pick(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }
  function transitionMs(speed) {
    if (speed === "fast") return 180;
    if (speed === "slow") return 520;
    return 320;
  }
  function normalizeStyle(style) {
    var S = style || {};
    var out = {};
    Object.keys(S).forEach(function (k) { out[k] = S[k]; });
    if (out.bg == null) out.bg = "#0e0f14";
    if (out.text == null) out.text = "#e9e9ef";
    if (out.accent == null) out.accent = "#d8b25a";
    if (out.card == null) out.card = "#1a1b22";
    if (out.cardBorder == null) out.cardBorder = "#33343d";
    if (out.font == null) out.font = "system-ui";
    if (out.fontUrl == null) out.fontUrl = ""; // 웹폰트 스타일시트 URL(예: Google Fonts)
    out.maxWidth = clampNum(out.maxWidth, 560, 1800, 980);
    out.rowImageHeight = clampNum(out.rowImageHeight, 80, 720, 200);
    out.layoutPreset = pick(out.layoutPreset, ["default", "wide", "card", "compact"], "default");
    out.choicePreset = pick(out.choicePreset, ["card", "button", "list"], "card");
    out.pageTransition = pick(out.pageTransition, ["none", "fade", "slide", "zoom"], "none");
    out.transitionSpeed = pick(out.transitionSpeed, ["fast", "normal", "slow"], "normal");
    if (out.customCss == null) out.customCss = "";
    return out;
  }
  // 명도 반전 팔레트: 제작자 테마의 bg/text/card/cardBorder 명도(L)를 뒤집어
  // 어두운 테마 ↔ 밝은 테마 변형을 만든다(색상·채도·accent는 유지).
  function _hexToRgb(h) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return null;
    var s = m[1];
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function _invertLightness(hex) {
    var c = _hexToRgb(hex);
    if (!c) return hex; // hex 가 아니면(rgb()·이름 등) 그대로 둠
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, d = max - min, h = 0, sat = 0;
    if (d) {
      sat = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    l = 1 - l; // 명도 반전
    var cc = (1 - Math.abs(2 * l - 1)) * sat;
    var x = cc * (1 - Math.abs(((h / 60) % 2) - 1));
    var mm = l - cc / 2, rgb;
    if (h < 60) rgb = [cc, x, 0]; else if (h < 120) rgb = [x, cc, 0];
    else if (h < 180) rgb = [0, cc, x]; else if (h < 240) rgb = [0, x, cc];
    else if (h < 300) rgb = [x, 0, cc]; else rgb = [cc, 0, x];
    return "#" + rgb.map(function (v) {
      var n = Math.round((v + mm) * 255);
      n = Math.max(0, Math.min(255, n));
      return (n < 16 ? "0" : "") + n.toString(16);
    }).join("");
  }
  function invertStyle(style) {
    var s = normalizeStyle(style), out = {};
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    ["bg", "text", "card", "cardBorder"].forEach(function (k) { out[k] = _invertLightness(s[k]); });
    return out;
  }
  function layoutMaxWidth(style) {
    var base = Number(style.maxWidth) || 980;
    if (style.layoutPreset === "wide") return Math.max(base, 1220);
    if (style.layoutPreset === "card") return Math.min(base, 900);
    if (style.layoutPreset === "compact") return Math.min(base, 760);
    return base;
  }
  // 웹폰트 URL 검증: https 스타일시트 URL만 허용하고, url("…") 컨텍스트를 깨뜨릴
  // 문자("' ()<> \ 공백·제어문자)는 배제 → CSS 주입(임의 규칙 삽입) 차단. 실패 시 "".
  function safeFontUrl(v) {
    if (typeof v !== "string") return "";
    var s = v.trim();
    if (/^\/\//.test(s)) s = "https:" + s;       // 프로토콜 상대 → https
    if (!/^https:\/\//i.test(s)) return "";        // https 만(외부 폰트 CDN)
    if (/["'()<>\\\s]/.test(s)) return "";         // url() 탈출·CSS 주입 방지
    return s;
  }
  function applyTheme(style, rootEl) {
    style = normalizeStyle(style);
    var r = (rootEl || document.documentElement).style;
    if (style.bg) r.setProperty("--bg", style.bg);
    if (style.text) r.setProperty("--text", style.text);
    if (style.accent) r.setProperty("--accent", style.accent);
    if (style.card) r.setProperty("--card", style.card);
    if (style.cardBorder) r.setProperty("--card-border", style.cardBorder);
    if (style.font) r.setProperty("--font", style.font);
    if (style.maxWidth) r.setProperty("--max-width", style.maxWidth + "px");
    r.setProperty("--layout-max-width", layoutMaxWidth(style) + "px");
    if (style.rowImageHeight) r.setProperty("--row-img-height", style.rowImageHeight + "px");
    r.setProperty("--page-transition-duration", transitionMs(style.transitionSpeed) + "ms");
    var root = rootEl || document.documentElement;
    if (root.dataset) {
      root.dataset.layoutPreset = style.layoutPreset;
      root.dataset.choicePreset = style.choicePreset;
      root.dataset.pageTransition = style.pageTransition;
      root.dataset.transitionSpeed = style.transitionSpeed;
    }
    // 웹폰트 @import 는 별도 <style> 에(@import 는 규칙 맨 앞이어야 함).
    var fEl = document.getElementById("cyoa-font-face");
    if (!fEl) { fEl = document.createElement("style"); fEl.id = "cyoa-font-face"; document.head.appendChild(fEl); }
    var furl = safeFontUrl(style.fontUrl);
    fEl.textContent = furl ? ('@import url("' + furl + '");') : "";
    var sEl = document.getElementById("cyoa-custom-css");
    if (!sEl) { sEl = document.createElement("style"); sEl.id = "cyoa-custom-css"; document.head.appendChild(sEl); }
    sEl.textContent = style.customCss || "";
  }

  /* ---------------- 확장 훅 버스 (숙련자용 customJs) ----------------
     작성자 코드가 api.on("render", fn) 등으로 라이프사이클에 끼어들 수 있게 함.
     훅은 play 모드 렌더에서만 발행 → 에디터 편집 캔버스(edit)는 영향 없음.
     모든 콜백은 try/catch로 격리 → 한 훅이 실패해도 화면이 깨지지 않음. */
  var _hooks = {};            // { name: [fn, ...] }
  var _customJsRan = false;   // 프로젝트 로드당 1회 실행 가드
  function hooksOn(name, fn) { if (typeof fn === "function") (_hooks[name] || (_hooks[name] = [])).push(fn); }
  function hooksEmit(name, payload) {
    var fns = _hooks[name]; if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload); }
      catch (e) { if (global.console) global.console.error("[CYOA hook:" + name + "]", e); }
    }
  }
  function resetHooks() { _hooks = {}; _customJsRan = false; }
  // 작성자 정의 스크립트 실행(프로젝트당 1회). new Function 으로 전역 스코프 격리, eval 미사용.
  function runCustomJs(project, opts) {
    opts = opts || {};
    if (_customJsRan) return false;
    var code = project && project.customJs;
    if (!code || !String(code).trim()) return false;
    _customJsRan = true;
    var api = { on: hooksOn, CYOA: global.CYOA, project: project };
    try {
      var fn = new Function("CYOA", "project", "api", '"use strict";\n' + String(code));
      fn(global.CYOA, project, api);
      return true;
    } catch (e) {
      if (global.console) global.console.error("[CYOA customJs]", e);
      if (opts.onError) opts.onError(e);
      return false;
    }
  }

  /* ---------------- 렌더 ---------------- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // opts.state+opts.mode 를 주면 조건부 점수 항목을 처리:
  //  play → 조건 충족 항목만 표시(할인/추가비용이 실제 반영된 것만).
  //  edit → 전부 표시하되 조건부 항목엔 "조건부" 뱃지(작성자가 규칙을 본다).
  function scoreTagsHTML(project, scores, opts) {
    if (!scores || !scores.length) return "";
    opts = opts || {};
    var base = (opts.state && opts.mode === "play") ? computeCurrencies(project, opts.state) : null;
    return scores.map(function (s) {
      var conditional = !!(s.requirements && s.requirements.length);
      if (conditional && opts.mode === "play") {
        // 재생 중엔 조건 충족한 항목만 노출
        if (!opts.state || !evaluateRequirements(s.requirements, project, opts.state, base).ok) return "";
      }
      var cd = currencyDef(project, s.currency);
      var nm = cd ? cd.name : s.currency;
      var v = Number(s.value) || 0;
      var badge = (conditional && opts.mode === "edit") ? '<span class="score-cond">조건부</span>' : "";
      if (v === 0) return '<span class="score-tag">' + escapeHtml(nm) + ' 0' + badge + '</span>';
      var cls = v > 0 ? "gain" : "cost";
      return '<span class="score-tag ' + cls + '">' + escapeHtml(nm) + " " + (v > 0 ? "+" : "") + v + badge + "</span>";
    }).join("");
  }
  function currencyBadgesHTML(project, state) {
    var totals = computeCurrencies(project, state);
    return (project.currencies || []).map(function (c) {
      var v = totals[c.id] || 0;
      var over = !currencyAllowsNeg(project, c.id) && v < 0;
      return '<span class="currency-badge ' + (over ? "over" : "") + '">' +
        '<span class="cur-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="cur-val" style="color:' + safeColor(c.color) + '">' + v + '</span></span>';
    }).join("");
  }

  // 이미지 + 콘텐츠를 layout(위치/너비/높이)에 따라 배치
  function clampNum(v, min, max, fallback) {
    v = Number(v);
    if (!isFinite(v)) v = fallback;
    return Math.max(min, Math.min(max, v));
  }
  function defaultBlockLayout(kind, pos) {
    pos = pos || "top";
    return {
      imagePos: pos,
      imageWidth: (kind === "choice" || pos === "left" || pos === "right") ? 40 : 100,
      imageHeight: 0,
      imageGap: (pos === "left" || pos === "right") ? 16 : 8,
      imageAlign: "center",
      textWidth: 100,
      textBoxAlign: "center",
      textAlign: "left",
      blockGap: kind === "row" ? 10 : 6
    };
  }
  function normalizeBlockLayout(layout, kind) {
    var L = layout || {};
    var pos = (L.imagePos === "bottom" || L.imagePos === "left" || L.imagePos === "right") ? L.imagePos : "top";
    var d = defaultBlockLayout(kind, pos);
    var align = (L.imageAlign === "left" || L.imageAlign === "right" || L.imageAlign === "center") ? L.imageAlign : d.imageAlign;
    var textBoxAlign = (L.textBoxAlign === "left" || L.textBoxAlign === "right" || L.textBoxAlign === "center") ? L.textBoxAlign : d.textBoxAlign;
    var textAlign = (L.textAlign === "left" || L.textAlign === "right" || L.textAlign === "center") ? L.textAlign : d.textAlign;
    return {
      imagePos: pos,
      imageWidth: clampNum(L.imageWidth, 5, 100, d.imageWidth),
      imageHeight: clampNum(L.imageHeight, 0, 2000, d.imageHeight),
      imageGap: clampNum(L.imageGap, 0, 160, d.imageGap),
      imageAlign: align,
      textWidth: clampNum(L.textWidth, 20, 100, d.textWidth),
      textBoxAlign: textBoxAlign,
      textAlign: textAlign,
      blockGap: clampNum(L.blockGap, 0, 180, d.blockGap)
    };
  }
  function imageEl(src, layout) {
    var img = el("img", "el-img");
    img.src = src; img.alt = ""; img.loading = "lazy";
    var h = Number((layout || {}).imageHeight) || 0;
    if (h > 0) { img.style.height = h + "px"; img.style.objectFit = "cover"; }
    return img;
  }
  function alignMargins(align) {
    if (align === "left") return { left: "0", right: "auto" };
    if (align === "right") return { left: "auto", right: "0" };
    return { left: "auto", right: "auto" };
  }
  function applyTextBoxLayout(contentEl, layout, sideBySide) {
    if (!contentEl) return;
    contentEl.classList.add("layout-text-box");
    contentEl.style.textAlign = layout.textAlign || "left";
    if (sideBySide) {
      contentEl.style.width = "";
      contentEl.style.marginLeft = "";
      contentEl.style.marginRight = "";
      return;
    }
    var m = alignMargins(layout.textBoxAlign);
    contentEl.style.width = layout.textWidth + "%";
    contentEl.style.marginLeft = m.left;
    contentEl.style.marginRight = m.right;
  }
  function arrangeImage(src, contentEl, layout, kind) {
    var L = normalizeBlockLayout(layout, kind || "page");
    if (!src) {
      applyTextBoxLayout(contentEl, L, false);
      return contentEl || null;
    }
    var pos = L.imagePos || "top";
    var w = Number(L.imageWidth);
    if (!w && w !== 0) w = (pos === "left" || pos === "right") ? 45 : 100;
    var iw = el("div", "img-wrap");
    iw.appendChild(imageEl(src, L));
    iw.style.margin = "0";
    if (pos === "left" || pos === "right") {
      var boxR = el("div", "lay lay-row");
      boxR.style.gap = L.imageGap + "px";
      iw.style.flex = "0 0 " + w + "%"; iw.style.maxWidth = w + "%";
      if (contentEl) { contentEl.classList.add("lay-content"); applyTextBoxLayout(contentEl, L, true); }
      if (pos === "left") { boxR.appendChild(iw); if (contentEl) boxR.appendChild(contentEl); }
      else { if (contentEl) boxR.appendChild(contentEl); boxR.appendChild(iw); }
      return boxR;
    }
    var boxC = el("div", "lay lay-col");
    var m = alignMargins(L.imageAlign);
    boxC.style.gap = L.imageGap + "px";
    iw.style.width = w + "%"; iw.style.marginLeft = m.left; iw.style.marginRight = m.right;
    applyTextBoxLayout(contentEl, L, false);
    if (pos === "bottom") { if (contentEl) boxC.appendChild(contentEl); boxC.appendChild(iw); }
    else { boxC.appendChild(iw); if (contentEl) boxC.appendChild(contentEl); }
    return boxC;
  }

  function renderChoice(project, choice, row, state, opts, totals) {
    var st = choiceStatus(project, choice, row, state, totals);
    if (st.hidden && opts.mode === "play") return null;
    var multi = isMulti(choice);
    var node = el("div", "choice");
    if (opts.mode === "edit") node.dataset.choiceId = choice.id;
    if (st.selected) node.classList.add("selected");
    if (st.locked) node.classList.add("locked");
    if (opts.mode === "edit" && opts.editSelectedId === choice.id) node.classList.add("editing");
    // 편집 모드: 조건부 숨김 선택지에 표식
    if (opts.mode === "edit" && choice.hideWhenLocked === true) {
      node.classList.add("hide-flag");
      node.appendChild(el("span", "hide-badge", "🙈 숨김"));
    }

    var body = el("div", "choice-body");
    body.appendChild(el("div", "choice-title", escapeHtml(choice.title || "(제목 없음)")));
    if (choice.description) body.appendChild(el("div", "choice-desc", sanitizeHtml(formatRich(interpolate(choice.description, project, state), false))));
    var sc = scoreTagsHTML(project, choice.scores, { state: state, mode: opts.mode });
    if (sc) body.appendChild(el("div", "choice-scores", sc));
    if (st.locked && st.reasons.length) body.appendChild(el("div", "lock-reason", escapeHtml(st.reasons.join(", "))));
    if (multi) {
      if (opts.mode === "play") {
        var cnt = getCount(state, choice.id);
        var stp = el("div", "choice-stepper");
        var minus = el("button", "btn btn-sm", "−");
        minus.disabled = cnt <= 0;
        var num = el("span", "stepper-num", String(cnt));
        var plus = el("button", "btn btn-sm", "＋");
        minus.addEventListener("click", function (e) { e.stopPropagation(); if (opts.onCount) opts.onCount(choice.id, -1); });
        plus.addEventListener("click", function (e) { e.stopPropagation(); if (opts.onCount) opts.onCount(choice.id, 1); });
        stp.appendChild(minus); stp.appendChild(num); stp.appendChild(plus);
        body.appendChild(stp);
      } else {
        body.appendChild(el("div", "choice-multi-note", "🔁 여러 번 선택 가능"));
      }
    }
    // 애드온: 조건부 추가 텍스트
    (choice.addons || []).forEach(function (ad) {
      var show;
      if (opts.mode === "edit") show = true; // 편집 모드에선 항상 표시
      else if (ad.requirements && ad.requirements.length) show = evaluateRequirements(ad.requirements, project, state, totals).ok;
      else show = st.selected; // 요구조건 없으면 선택 시 표시
      if (show) body.appendChild(el("div", "choice-addon", sanitizeHtml(formatRich(interpolate(ad.text, project, state), false))));
    });

    if (choice.image) {
      var L = choice.layout || {};
      var pos = L.imagePos || "top";
      node.classList.add("ci-" + pos);
      var im = el("img", "choice-img"); im.src = choice.image; im.alt = choice.title || ""; im.loading = "lazy";
      var h = Number(L.imageHeight) || 0;
      if (h > 0) im.style.height = h + "px";
      if (pos === "left" || pos === "right") {
        var w = Number(L.imageWidth) || 40;
        im.style.flex = "0 0 " + w + "%"; im.style.width = w + "%";
      }
      if (pos === "bottom" || pos === "right") { node.appendChild(body); node.appendChild(im); }
      else { node.appendChild(im); node.appendChild(body); }
    } else {
      node.appendChild(body);
    }

    node.addEventListener("click", function () {
      if (opts.mode === "edit") { if (opts.onEditSelect) opts.onEditSelect("choice", choice.id); return; }
      if (st.locked) return;
      if (multi) return; // 다중 선택지는 스테퍼(− N +)로만 조작
      if (opts.onToggle) opts.onToggle(choice.id);
    });
    return node;
  }

  function renderRow(project, row, state, opts, totals) {
    if (!totals) totals = computeCurrencies(project, state);
    var node = el("div", "cyoa-row");
    node.dataset.rowId = row.id;
    var L = normalizeBlockLayout(row.layout, "row");
    node.style.setProperty("--block-gap", L.blockGap + "px");
    if (opts.mode === "edit" && opts.editSelectedId === row.id) node.classList.add("editing");
    var head = el("div", "row-head");
    head.appendChild(el("h3", "row-title", escapeHtml(row.title || "(행)")));
    if (row.description) head.appendChild(el("p", "row-desc", sanitizeHtml(formatRich(interpolate(row.description, project, state), false))));
    if (opts.mode === "edit") {
      node.addEventListener("click", function (e) {
        if (!e.target.closest(".choice")) {
          e.stopPropagation();
          if (opts.onEditSelect) opts.onEditSelect("row", row.id);
        }
      });
    }
    node.appendChild(arrangeImage(row.image, head, row.layout, "row"));
    // 랜덤 선택(주사위) 버튼 — row.random.enabled 일 때
    if (row.random && row.random.enabled) {
      var rollWrap = el("div", "row-roll");
      var rollBtn = el("button", "btn btn-sm roll-btn", "🎲 " + escapeHtml((row.random.label || "").trim() || "랜덤 선택"));
      if (opts.mode === "edit") {
        rollBtn.disabled = true;
        rollWrap.appendChild(rollBtn);
        rollWrap.appendChild(el("span", "roll-note", "플레이 시 무작위로 하나를 고릅니다"));
      } else {
        rollBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (rollBtn.disabled) return;
          rollBtn.disabled = true;
          // 룰렛 연출: 보이는 카드들을 순환 강조한 뒤 확정
          var cards = node.querySelectorAll(".choice:not(.locked)");
          var step = 0, maxSteps = Math.max(8, Math.min(16, cards.length * 3));
          var tick = function () {
            for (var i = 0; i < cards.length; i++) cards[i].classList.remove("roll-flash");
            if (step >= maxSteps || !cards.length) {
              if (opts.onRoll) opts.onRoll(row);
              return;
            }
            cards[step % cards.length].classList.add("roll-flash");
            step++;
            setTimeout(tick, 45 + step * 6); // 점점 느려지는 룰렛
          };
          tick();
        });
        rollWrap.appendChild(rollBtn);
      }
      node.appendChild(rollWrap);
    }
    var grid = el("div", "choice-grid");
    grid.style.setProperty("--cols", row.columns || 3);
    (row.choices || []).forEach(function (ch) {
      var c = renderChoice(project, ch, row, state, opts, totals);
      if (c) grid.appendChild(c);
    });
    node.appendChild(grid);
    return node;
  }

  function renderLinks(project, page, state, opts) {
    if (!page.links || !page.links.length) return null;
    var wrap = el("div", "cyoa-links");
    var shown = 0;
    page.links.forEach(function (link) {
      var st = evaluateRequirements(link.requirements, project, state);
      var hidden = link.hideWhenLocked === true && !st.ok;
      if (hidden && opts.mode === "play") return; // 조건 미충족 → 숨김
      shown++;
      var cls = "btn nav-link" + (st.ok ? "" : " locked");
      if (opts.mode === "edit" && link.hideWhenLocked === true) cls += " nav-hide-flag";
      var b = el("button", cls);
      if (opts.mode === "edit") b.dataset.linkUid = link._uid || "";
      b.textContent = (opts.mode === "edit" && link.hideWhenLocked === true ? "🙈 " : "") + (link.label || "→");
      if (!st.ok && st.reasons.length) b.title = st.reasons.join(", ");
      b.addEventListener("click", function () {
        if (opts.mode === "edit") return;
        if (project.settings && project.settings.flow === "scroll") {
          var t = document.getElementById("page-" + link.target);
          if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (!st.ok) return;
        if (opts.onNavigate) opts.onNavigate(link);
      });
      wrap.appendChild(b);
    });
    return shown ? wrap : null;
  }

  function renderPage(project, page, state, opts) {
    var sec = el("section", "cyoa-page");
    sec.dataset.pageId = page.id;
    var L = normalizeBlockLayout(page.layout, "page");
    sec.style.setProperty("--block-gap", L.blockGap + "px");
    sec.id = "page-" + page.id;
    if (opts.mode === "edit" && opts.editSelectedId === page.id) sec.classList.add("editing");
    if (opts.mode === "edit") {
      sec.addEventListener("click", function (e) {
        if (e.target.closest(".cyoa-row, .choice, .nav-link, .layout-drag-handle, .layout-gap-handle")) return;
        if (opts.onEditSelect) opts.onEditSelect("page", page.id);
      });
    }
    sec.appendChild(el("h2", "page-title", escapeHtml(page.title || "(페이지)")));
    var storyEl = (page.type === "story" && page.text) ? el("div", "story-text", sanitizeHtml(formatRich(interpolate(page.text, project, state), true))) : null;
    if (page.image || storyEl) {
      var block = arrangeImage(page.image, storyEl, page.layout, "page");
      if (block) sec.appendChild(block);
    }
    // 행(선택지 묶음)은 서사/빌드 페이지 모두에서 렌더 — 서사 페이지는 본문 아래에 선택지가 붙는다.
    // 통화 합계는 페이지당 1회만 계산해 모든 행·선택지에 전달(선택지마다 재계산하던 비용 제거).
    // 행이 없는(본문만 있는) 서사 페이지에서는 계산을 건너뛴다.
    var pageTotals = (page.rows && page.rows.length) ? computeCurrencies(project, state) : null;
    (page.rows || []).forEach(function (r) { sec.appendChild(renderRow(project, r, state, opts, pageTotals)); });
    var links = renderLinks(project, page, state, opts);
    if (links) sec.appendChild(links);
    return sec;
  }

  function defaultStartLayout() {
    return {
      cardX: 50, cardY: 50, cardWidth: 620,
      paddingX: 30, paddingY: 40,
      align: "center",
      gapImageTitle: 22, gapTitleSubtitle: 6, gapSubtitleText: 18,
      gapTextActions: 26, gapActionsHint: 16,
      preset: "center"
    };
  }
  function normalizeStartLayout(layout) {
    var d = defaultStartLayout(), L = layout || {}, out = {};
    out.cardX = clampNum(L.cardX, 5, 95, d.cardX);
    out.cardY = clampNum(L.cardY, 5, 95, d.cardY);
    out.cardWidth = clampNum(L.cardWidth, 320, 1200, d.cardWidth);
    out.paddingX = clampNum(L.paddingX, 0, 120, d.paddingX);
    out.paddingY = clampNum(L.paddingY, 0, 140, d.paddingY);
    out.align = (L.align === "left" || L.align === "right" || L.align === "center") ? L.align : d.align;
    out.gapImageTitle = clampNum(L.gapImageTitle, 0, 140, d.gapImageTitle);
    out.gapTitleSubtitle = clampNum(L.gapTitleSubtitle, 0, 120, d.gapTitleSubtitle);
    out.gapSubtitleText = clampNum(L.gapSubtitleText, 0, 140, d.gapSubtitleText);
    out.gapTextActions = clampNum(L.gapTextActions, 0, 160, d.gapTextActions);
    out.gapActionsHint = clampNum(L.gapActionsHint, 0, 120, d.gapActionsHint);
    out.preset = L.preset || d.preset;
    out.free = !!L.free;
    out.items = sanitizeStartItems(L.items);
    return out;
  }
  function sanitizeStartItems(items) {
    var out = {};
    if (!items || typeof items !== "object") return out;
    ["image", "title", "subtitle", "text", "actions", "hint"].forEach(function (k) {
      var it = items[k];
      if (!it || typeof it !== "object") return;
      var o = {};
      if (it.x != null) o.x = clampNum(it.x, 0, 100, 0);
      if (it.y != null) o.y = clampNum(it.y, 0, 100, 0);
      if (it.w != null) o.w = clampNum(it.w, 5, 100, 40);
      if (it.align === "left" || it.align === "center" || it.align === "right") o.align = it.align;
      out[k] = o;
    });
    return out;
  }
  function applyStartLayout(screen, card, layout) {
    var L = normalizeStartLayout(layout);
    var justify = L.align === "left" ? "flex-start" : L.align === "right" ? "flex-end" : "center";
    screen.style.setProperty("--start-card-x", L.cardX + "%");
    screen.style.setProperty("--start-card-y", L.cardY + "%");
    screen.style.setProperty("--start-card-width", L.cardWidth + "px");
    screen.style.setProperty("--start-padding-x", L.paddingX + "px");
    screen.style.setProperty("--start-padding-y", L.paddingY + "px");
    screen.style.setProperty("--start-align", L.align);
    screen.style.setProperty("--start-actions-justify", justify);
    screen.style.setProperty("--start-gap-image-title", L.gapImageTitle + "px");
    screen.style.setProperty("--start-gap-title-subtitle", L.gapTitleSubtitle + "px");
    screen.style.setProperty("--start-gap-subtitle-text", L.gapSubtitleText + "px");
    screen.style.setProperty("--start-gap-text-actions", L.gapTextActions + "px");
    screen.style.setProperty("--start-gap-actions-hint", L.gapActionsHint + "px");
    card.style.textAlign = L.align;
    return L;
  }

  // 오프닝(시작) 화면 렌더 — 뷰어/에디터 미리보기 공용
  // opts: { mode:"play"|"preview", hasSaved, onStart, onResume, onNew, hint }
  function renderStartScreen(project, mountEl, opts) {
    opts = opts || {};
    var st = project.start || {};
    var meta = project.meta || {};
    var layout = normalizeStartLayout(st.layout);
    applyTheme(project.style, document.documentElement);
    mountEl.innerHTML = "";
    var screen = el("div", "start-screen" + (opts.inline ? " start-inline" : ""));
    var bgMode = st.image && st.imageMode === "background";
    if (bgMode) { screen.classList.add("has-bg"); screen.style.backgroundImage = "linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)), url(" + JSON.stringify(st.image) + ")"; }
    var free = !!layout.free;
    var card = el("div", "start-card");
    if (free) screen.classList.add("start-free"); else applyStartLayout(screen, card, layout);

    var comps = [];
    function mk(key, elm) { elm.classList.add("start-comp"); elm.setAttribute("data-comp", key); comps.push({ key: key, el: elm }); return elm; }
    if (st.image && st.imageMode !== "background") { var im = el("img", "start-image"); im.src = st.image; im.alt = ""; mk("image", im); }
    mk("title", el("h1", "start-title", escapeHtml(st.title || meta.title || "CYOA")));
    var sub = (st.subtitle != null && st.subtitle !== "") ? st.subtitle : (meta.author ? ("by " + meta.author) : "");
    if (sub) mk("subtitle", el("div", "start-author", escapeHtml(sub)));
    var desc = (st.text != null && st.text !== "") ? st.text : meta.description;
    if (desc) { var d = el("div", "start-desc"); d.innerHTML = sanitizeHtml(formatRich(desc, true)); mk("text", d); }
    var actions = el("div", "start-actions");
    var label = escapeHtml(st.buttonLabel || "▶ 시작하기");
    if (opts.mode === "preview") {
      actions.appendChild(el("button", "btn primary", label));
    } else if (opts.hasSaved) {
      var r = el("button", "btn primary", "이어서 하기"); r.addEventListener("click", opts.onResume || function () {});
      var n = el("button", "btn", "처음부터"); n.addEventListener("click", opts.onNew || function () {});
      actions.appendChild(r); actions.appendChild(n);
    } else {
      var s = el("button", "btn primary", label); s.addEventListener("click", opts.onStart || function () {});
      actions.appendChild(s);
    }
    mk("actions", actions);
    if (opts.hint) mk("hint", el("div", "start-hint", opts.hint));

    if (free) {
      var items = layout.items || {};
      comps.forEach(function (c, i) {
        var it = items[c.key] || {};
        c.el.style.left = (it.x != null ? it.x : 8) + "%";
        c.el.style.top = (it.y != null ? it.y : 8 + i * 13) + "%";
        if (it.w != null) c.el.style.width = it.w + "%";
        if (c.key !== "image" && it.align) c.el.style.textAlign = it.align;
        screen.appendChild(c.el);
      });
    } else {
      comps.forEach(function (c) { card.appendChild(c.el); });
      screen.appendChild(card);
    }
    mountEl.appendChild(screen);
    // 확장 훅: 재생 모드(뷰어·미리보기)에서만 발행
    if (opts.mode !== "edit") hooksEmit("startscreen", { project: project, mountEl: mountEl, screen: screen, mode: opts.mode });
  }

  // 무대 렌더: mountEl 비우고 채움
  function renderStage(project, state, mountEl, opts) {
    opts = opts || {};
    opts.mode = opts.mode || "play";
    var style = normalizeStyle(project.style);
    applyTheme(style, document.documentElement);
    mountEl.innerHTML = "";
    var stage = el("div", "cyoa-stage layout-" + style.layoutPreset + " choice-" + style.choicePreset);
    if (opts.animatePage && opts.mode === "play" && style.pageTransition !== "none") {
      stage.classList.add("page-transition", "page-transition-" + style.pageTransition);
    }

    var scroll = opts.mode === "play" && project.settings && project.settings.flow === "scroll";
    if (opts.pageId) {
      var pg = findPage(project, opts.pageId);
      if (pg) stage.appendChild(renderPage(project, pg, state, opts));
    } else if (scroll) {
      (project.pages || []).forEach(function (pg) { stage.appendChild(renderPage(project, pg, state, opts)); });
    } else {
      var cur = findPage(project, state.currentPageId) || project.pages[0];
      if (cur) {
        var pageEl = renderPage(project, cur, state, opts);
        // 뒤로가기
        if (opts.mode === "play" && state.history.length) {
          var back = el("button", "btn ghost btn-sm nav-back", "← 이전");
          back.addEventListener("click", function () { if (opts.onBack) opts.onBack(); });
          pageEl.insertBefore(back, pageEl.firstChild);
        }
        stage.appendChild(pageEl);
      }
    }
    mountEl.appendChild(stage);
    // 확장 훅: 재생 렌더 후에만 발행(편집 캔버스 보호)
    if (opts.mode === "play") hooksEmit("render", { project: project, state: state, mountEl: mountEl, mode: opts.mode, stage: stage });
  }

  /* ---------------- 백팩(실시간 선택 요약) ----------------
     그룹이 정의돼 있고 태그된 선택이 있으면 그룹별, 아니면 행별로 분류 */
  function backpackCategories(project, state) {
    var summary = collectBuildSummary(project, state);
    var groups = project.groups || [];
    var useGroups = groups.length > 0 && summary.some(function (s) {
      return s.choices.some(function (c) { return (c.groups || []).length > 0; });
    });
    if (!useGroups) {
      return summary.map(function (s) { return { title: s.title || "(행)", choices: s.choices }; });
    }
    var byId = {}, order = [];
    groups.forEach(function (g) { byId[g.id] = { title: g.name, choices: [] }; order.push(byId[g.id]); });
    var etc = { title: "기타", choices: [] };
    summary.forEach(function (s) {
      s.choices.forEach(function (c) {
        var tagged = (c.groups || []).filter(function (id) { return byId[id]; });
        if (tagged.length) tagged.forEach(function (id) { byId[id].choices.push(c); });
        else etc.choices.push(c);
      });
    });
    order.push(etc);
    return order.filter(function (o) { return o.choices.length; });
  }
  // 백팩 패널 내용 렌더 — 뷰어/에디터 미리보기 공용. opts.onRemove(choiceId)로 해제.
  function renderBackpackPanel(project, state, mountEl, opts) {
    opts = opts || {};
    mountEl.innerHTML = "";
    var badges = el("div", "backpack-currencies");
    badges.innerHTML = currencyBadgesHTML(project, state);
    mountEl.appendChild(badges);
    var cats = backpackCategories(project, state);
    if (!cats.length) {
      mountEl.appendChild(el("p", "backpack-empty", "아직 선택한 항목이 없습니다."));
      return;
    }
    cats.forEach(function (cat) {
      var sec = el("div", "backpack-cat");
      sec.appendChild(el("h4", "backpack-cat-title", escapeHtml(cat.title)));
      cat.choices.forEach(function (c) {
        var it = el("div", "backpack-item");
        if (c.image) { var im = el("img", "backpack-thumb"); im.src = c.image; im.alt = ""; im.loading = "lazy"; it.appendChild(im); }
        var bd = el("div", "backpack-item-body");
        var cnt = getCount(state, c.id) || 1;
        bd.appendChild(el("div", "backpack-item-title", escapeHtml(c.title || "(제목 없음)") + (cnt > 1 ? ' <span class="backpack-count">×' + cnt + "</span>" : "")));
        var sc = scoreTagsHTML(project, c.scores, { state: state, mode: "play" });
        if (sc) bd.appendChild(el("div", "backpack-item-scores", sc));
        it.appendChild(bd);
        if (opts.onRemove) {
          var x = el("button", "backpack-x", "✕");
          x.title = "선택 해제";
          x.addEventListener("click", function () { opts.onRemove(c.id); });
          it.appendChild(x);
        }
        sec.appendChild(it);
      });
      mountEl.appendChild(sec);
    });
  }

  /* ---------------- 빌드 코드 (선택 공유) ---------------- */
  function encodeBuildCode(state) {
    var payload = {
      s: state.selected, c: state.counts, e: state.eventScores, t: state.takenLinks,
      ve: state.varEvents, p: state.currentPageId, h: state.history
    };
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); }
    catch (e) { return ""; }
  }
  function applyBuildCode(state, code) {
    try {
      var p = JSON.parse(decodeURIComponent(escape(atob(code))));
      if (!p || typeof p !== "object") return false;
      // 필드별 형태 검증 — 조작된 #code= 링크가 배열/객체 자리에 엉뚱한 타입을 넣어
      // 이후 forEach/indexOf 에서 뷰어를 크래시시키는 것을 방지(공유 링크 DoS 차단).
      var obj = function (v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
      state.selected = Array.isArray(p.s) ? p.s : [];
      state.counts = obj(p.c);
      state.eventScores = obj(p.e);
      state.varEvents = Array.isArray(p.ve) ? p.ve : [];
      state.takenLinks = Array.isArray(p.t) ? p.t : [];
      state.currentPageId = typeof p.p === "string" ? p.p : state.currentPageId;
      state.history = Array.isArray(p.h) ? p.h : [];
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 결과 이미지(WebP) 추출 ---------------- */
  function _loadImg(src) {
    return new Promise(function (res) {
      if (!src) { res(null); return; }
      var im = new Image();
      im.crossOrigin = "anonymous"; // 교차출처 비CORS 이미지는 로드 실패시켜 캔버스 오염 방지
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = src;
    });
  }
  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function _drawCover(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }
  function _font(ctx, weight, size, fam) { ctx.font = weight + " " + size + "px " + fam; }
  function _wrap(ctx, text, maxW, maxLines) {
    text = String(text == null ? "" : text);
    var all = [], cur = "", i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (ch === "\n") { all.push(cur); cur = ""; continue; }
      if (cur && ctx.measureText(cur + ch).width > maxW) { all.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) all.push(cur);
    if (all.length <= maxLines) return all;
    var kept = all.slice(0, maxLines), last = kept[maxLines - 1];
    while (last.length && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = last + "…";
    return kept;
  }

  function buildResultCanvas(project, state) {
    var S = project.style || {};
    var col = { bg: S.bg || "#0e0f14", text: S.text || "#e9e9ef", accent: S.accent || "#d8b25a", card: S.card || "#1a1b22", border: S.cardBorder || "#33343d" };
    var fam = S.font || "system-ui, sans-serif";
    var W = 860, pad = 36, dpr = 2, contentW = W - pad * 2;
    var title = (project.meta && project.meta.title) || "내 선택";
    var totals = computeCurrencies(project, state);

    var groups = collectBuildSummary(project, state).map(function (g) {
      return { row: g.title, choices: g.choices };
    });

    var proms = [];
    groups.forEach(function (g) { g.choices.forEach(function (c) { if (c.image) proms.push(_loadImg(c.image).then(function (im) { c.__img = im; })); }); });

    var cardH = 92, cardGap = 8, rowTitleH = 30, groupGap = 12;

    // 한 번의 render(ctx, draw)로 측정과 그리기를 동일 로직으로 처리
    function render(ctx, draw) {
      var yy = pad, i;
      _font(ctx, "bold", 30, fam);
      _wrap(ctx, title, contentW, 2).forEach(function (ln) {
        if (draw) { ctx.fillStyle = col.text; ctx.fillText(ln, pad, yy); }
        yy += 38;
      });
      yy += 4;
      var curs = project.currencies || [];
      if (curs.length) {
        _font(ctx, "600", 15, fam);
        var cx = pad, ph = 26;
        curs.forEach(function (c) {
          var txt = c.name + " " + (totals[c.id] || 0);
          var pw = ctx.measureText(txt).width + 22;
          if (cx + pw > W - pad && cx > pad) { cx = pad; yy += ph + 6; }
          if (draw) {
            ctx.fillStyle = col.card; _roundRect(ctx, cx, yy, pw, ph, 13); ctx.fill();
            ctx.strokeStyle = col.border; ctx.lineWidth = 1; _roundRect(ctx, cx, yy, pw, ph, 13); ctx.stroke();
            ctx.fillStyle = safeColor(c.color, col.accent); ctx.fillText(txt, cx + 11, yy + 5);
          }
          cx += pw + 8;
        });
        yy += ph + 12;
      }
      if (!groups.length) {
        _font(ctx, "normal", 16, fam);
        if (draw) { ctx.fillStyle = "rgba(233,233,239,.55)"; ctx.fillText("선택한 항목이 없습니다.", pad, yy); }
        yy += 40;
      }
      groups.forEach(function (g) {
        _font(ctx, "bold", 20, fam);
        if (draw) { ctx.fillStyle = col.accent; ctx.fillText(g.row || "(행)", pad, yy); }
        yy += rowTitleH;
        g.choices.forEach(function (c) {
          if (draw) {
            ctx.fillStyle = col.card; _roundRect(ctx, pad, yy, contentW, cardH, 12); ctx.fill();
            ctx.strokeStyle = col.border; ctx.lineWidth = 1.5; _roundRect(ctx, pad, yy, contentW, cardH, 12); ctx.stroke();
          }
          var tx = pad + 14;
          if (c.__img) {
            var ix = pad + 10, iy = yy + 10, iw = 110, ih = cardH - 20;
            if (draw) { ctx.save(); _roundRect(ctx, ix, iy, iw, ih, 8); ctx.clip(); _drawCover(ctx, c.__img, ix, iy, iw, ih); ctx.restore(); }
            tx = ix + iw + 14;
          }
          var cnt = getCount(state, c.id) || 1;
          var twAvail = pad + contentW - 12 - tx;
          _font(ctx, "bold", 18, fam);
          var tlines = _wrap(ctx, (c.title || "") + (cnt > 1 ? "  ×" + cnt : ""), twAvail, 2), ty = yy + 13;
          tlines.forEach(function (ln) { if (draw) { ctx.fillStyle = col.text; ctx.fillText(ln, tx, ty); } ty += 24; });
          var shownScores = activeScores(c, project, state, totals); // 조건부 항목은 충족한 것만
          if (shownScores.length) {
            _font(ctx, "600", 13, fam);
            var sx = tx;
            shownScores.forEach(function (s) {
              var cd = currencyDef(project, s.currency); var nm = cd ? cd.name : s.currency;
              var val = (Number(s.value) || 0) * cnt; var stxt = nm + " " + (val > 0 ? "+" : "") + val;
              var sw = ctx.measureText(stxt).width + 14;
              if (sx + sw > pad + contentW - 12) return;
              if (draw) {
                ctx.fillStyle = "rgba(216,178,90,.18)"; _roundRect(ctx, sx, ty, sw, 20, 6); ctx.fill();
                ctx.fillStyle = val > 0 ? "#5fb37a" : (val < 0 ? "#e0654f" : col.text);
                ctx.fillText(stxt, sx + 7, ty + 3);
              }
              sx += sw + 6;
            });
          }
          yy += cardH + cardGap;
        });
        yy += groupGap;
      });
      _font(ctx, "normal", 12, fam);
      var d = new Date(), ds = d.getFullYear() + "." + (d.getMonth() + 1) + "." + d.getDate();
      if (draw) { ctx.fillStyle = "rgba(233,233,239,.4)"; ctx.fillText(title + " · " + ds, pad, yy); }
      yy += 22;
      return yy;
    }

    return Promise.all(proms).then(function () {
      var mc = document.createElement("canvas"), mx = mc.getContext("2d");
      mx.textBaseline = "top";
      var H = Math.ceil(render(mx, false)) + 8;
      var canvas = document.createElement("canvas");
      canvas.width = W * dpr; canvas.height = H * dpr;
      var ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr); ctx.textBaseline = "top";
      ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
      render(ctx, true);
      return canvas;
    });
  }

  function _download(name, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 600);
  }
  function saveResultImage(project, state, baseName) {
    baseName = (baseName || "cyoa").replace(/[\\/:*?"<>|]+/g, "_");
    return buildResultCanvas(project, state).then(function (canvas) {
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          if (blob) {
            // 브라우저가 WebP 인코딩을 지원하면 webp, 아니면(Safari 등) 같은 그림을 png로 저장
            if (blob.type === "image/webp") { _download(baseName + ".webp", blob); resolve("webp"); }
            else { _download(baseName + ".png", blob); resolve("png"); }
            return;
          }
          // 캔버스 오염 등으로 null → png 재시도
          canvas.toBlob(function (b2) {
            if (b2) { _download(baseName + ".png", b2); resolve("png"); } else resolve(null);
          }, "image/png");
        }, "image/webp", 0.92);
      });
    });
  }

  /* ---------------- 새 프로젝트 ---------------- */
  function newProject() {
    var pid = genId("page");
    return {
      format: "cyoa-tool", version: 1,
      customJs: "",
      meta: { id: genId("proj"), title: "새 CYOA", author: "", description: "", lang: "ko" },
      start: { title: "", subtitle: "", text: "", buttonLabel: "", image: null, imageMode: "card", layout: defaultStartLayout() },
      settings: { flow: "paged", startPageId: pid, allowNegativeCurrency: false, showLockedChoices: true, enableBuildCode: true, allowBrightnessToggle: true },
      style: { bg: "#0e0f14", text: "#e9e9ef", accent: "#d8b25a", card: "#1a1b22", cardBorder: "#33343d", font: "system-ui", fontUrl: "", rowImageHeight: 200, maxWidth: 980, layoutPreset: "default", choicePreset: "card", pageTransition: "none", transitionSpeed: "normal", customCss: "" },
      currencies: [{ id: "pt", name: "포인트", start: 100, color: "#d8b25a", allowNegative: false }],
      variables: [],
      groups: [],
      globalRequirements: [],
      pages: [{ id: pid, title: "시작", type: "story", text: "여기에 이야기를 작성하세요.\n엔터로 줄을 바꾸고, 빈 줄로 문단을 나눌 수 있어요.", image: null, layout: defaultBlockLayout("page"), rows: [], links: [] }]
    };
  }

  /* ---------------- 노출 ---------------- */
  global.CYOA = {
    genId: genId, escapeHtml: escapeHtml, safeColor: safeColor, safeFontUrl: safeFontUrl, clone: clone, sanitizeHtml: sanitizeHtml,
    interpolate: interpolate, resolveWord: resolveWord,
    findPage: findPage, findChoice: findChoice, findRowOfChoice: findRowOfChoice,
    allChoices: allChoices, currencyDef: currencyDef, variableDef: variableDef,
    computeVars: computeVars,
    groupDef: groupDef, globalReqDef: globalReqDef, countGroupSelected: countGroupSelected,
    rollRandomChoice: rollRandomChoice, collectBuildSummary: collectBuildSummary, invertStyle: invertStyle,
    backpackCategories: backpackCategories, renderBackpackPanel: renderBackpackPanel,
    newState: newState, isSelected: isSelected, getCount: getCount, isMulti: isMulti,
    computeCurrencies: computeCurrencies, evaluateRequirements: evaluateRequirements,
    choiceStatus: choiceStatus, toggleChoice: toggleChoice, changeCount: changeCount, pruneInvalid: pruneInvalid,
    navigate: navigate, goBack: goBack,
    applyTheme: applyTheme, normalizeStyle: normalizeStyle, renderStage: renderStage, renderStartScreen: renderStartScreen,
    defaultBlockLayout: defaultBlockLayout, normalizeBlockLayout: normalizeBlockLayout,
    defaultStartLayout: defaultStartLayout, normalizeStartLayout: normalizeStartLayout,
    currencyBadgesHTML: currencyBadgesHTML,
    encodeBuildCode: encodeBuildCode, applyBuildCode: applyBuildCode,
    buildResultCanvas: buildResultCanvas, saveResultImage: saveResultImage,
    pageAudio: pageAudio,
    hooks: { on: hooksOn, emit: hooksEmit }, runCustomJs: runCustomJs, resetHooks: resetHooks,
    newProject: newProject
  };
})(window);
