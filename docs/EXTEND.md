# 확장 가이드 (숙련자용)

이 툴은 코드를 몰라도 쓸 수 있지만, **원하는 기능을 직접 구현**하고 싶은 사람을 위해 두 가지 확장 지점을 제공합니다.

| 확장 | 무엇 | 어디서 |
|---|---|---|
| **커스텀 CSS** | 외형(색·여백·애니메이션 등) | 설정(⚙) → 테마 → **커스텀 CSS** |
| **커스텀 JS** | 동작(렌더에 끼어들기, 요소 추가, 외부 연동 등) | 설정(⚙) → **확장 — 커스텀 JS (고급)** |

둘 다 `project.json` 에 함께 저장되고 **내보내기(단일 파일·공유 뷰어 세트)에 자동 포함**되므로, Neocities에 올린 작품에서도 그대로 동작합니다.

---

## 1. 커스텀 CSS

설정 → 테마 → **커스텀 CSS** 칸에 적은 내용은 페이지 전역에 주입됩니다(`#cyoa-custom-css`).
엔진이 쓰는 CSS 변수(`--bg`, `--text`, `--accent`, `--card`, `--card-border`, `--font`, `--max-width`, `--layout-max-width`, `--row-img-height` 등)와 클래스(`.cyoa-page`, `.cyoa-row`, `.choice`, `.choice.selected`, `.nav-link` …)를 활용할 수 있습니다.

```css
/* 선택된 선택지에 강조 테두리 */
.choice.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
```

---

## 2. 커스텀 JS — 훅(hook)

설정 → **확장 — 커스텀 JS (고급)** 칸에 적은 스크립트는 **작품이 로드될 때 1회 실행**됩니다.
실행 시 다음 세 가지가 인자로 주어집니다.

| 인자 | 설명 |
|---|---|
| `CYOA` | 엔진 전역 API(아래 표). `window.CYOA` 와 동일 |
| `project` | 현재 작품 데이터 객체 |
| `api` | 확장용 헬퍼. 현재 `api.on(이벤트, 콜백)` 제공 |

### 라이프사이클 이벤트

`api.on("이벤트", function (ctx) { … })` 으로 등록합니다. 콜백은 매번 새 `ctx` 를 받습니다.

| 이벤트 | 발생 시점 | `ctx` 필드 |
|---|---|---|
| `"render"` | 페이지(무대)가 그려진 직후 — 재생/미리보기에서만 | `project`, `state`, `mountEl`, `mode`, `stage` |
| `"startscreen"` | 시작 화면이 그려진 직후 | `project`, `mountEl`, `screen`, `mode` |
| `"select"` | 선택지를 고르거나 해제·카운트 변경한 직후(최종 상태 기준) | `project`, `state`, `choiceId`, `selected`, `count` |
| `"navigate"` | 이동 링크로 페이지를 옮긴 직후 | `project`, `state`, `link`, `from`, `to` |
| `"roll"` | 🎲 랜덤 선택이 확정된 직후 (`select` 도 함께 발생) | `project`, `state`, `row`, `choiceId` |

> **편집 캔버스는 훅을 발생시키지 않습니다.** 훅은 재생(`mode === "play"`) 렌더에서만 발행되므로, 작성자 스크립트가 에디터 편집 화면을 건드리지 않습니다.
> 한 훅에서 오류가 나도 `try/catch` 로 격리되어 **화면이 깨지지 않습니다**(오류는 콘솔에 기록).

### 작성 → 테스트

1. 설정 → **확장 — 커스텀 JS** 칸에 코드를 적습니다.
2. **▶ 미리보기에 적용** 을 누르면 스크립트가 (재)실행되고 오른쪽 ▶ 미리보기에 반영됩니다.
3. 오류가 있으면 토스트로 알려주고, 자세한 내용은 브라우저 콘솔에 출력됩니다.

---

## `window.CYOA` 주요 API

| 함수 | 용도 |
|---|---|
| `CYOA.findPage(project, id)` / `findChoice(project, id)` / `findRowOfChoice(project, id)` | 데이터 탐색 |
| `CYOA.computeCurrencies(project, state)` | 현재 통화 합계 `{ id: 값 }` |
| `CYOA.evaluateRequirements(reqs, project, state)` | 요구조건 평가 `{ ok, reasons }` |
| `CYOA.isSelected(state, id)` / `getCount(state, id)` | 선택/카운트 조회 |
| `CYOA.choiceStatus(project, choice, row, state)` | 선택지 상태 `{ selected, locked, hidden, … }` |
| `CYOA.interpolate(text, project, state)` | `{{cur:…}}`·`{{word:…}}`·`{{if:…}}` 치환 |
| `CYOA.computeVars(project, state)` | 현재 변수 값 `{ id: 값 }` |
| `CYOA.collectBuildSummary(project, state)` | 행 순서대로 선택 요약 `[{ row, title, choices }]` — 결과 이미지·백팩이 쓰는 데이터 |
| `CYOA.backpackCategories(project, state)` | 백팩 분류(그룹 우선, 없으면 행별) `[{ title, choices }]` |
| `CYOA.countGroupSelected(project, state, groupId)` | 그룹에 태그된 선택지 중 선택된 개수 |
| `CYOA.groupDef / globalReqDef(project, id)` | 그룹·글로벌 조건 세트 정의 조회 |
| `CYOA.rollRandomChoice(project, state, row)` | 행에서 무작위 선택 실행(성공 시 choice id) |
| `CYOA.invertStyle(style)` | 명도 반전 팔레트(🌓 밝기 전환이 쓰는 함수) |
| `CYOA.hooks.on(name, fn)` | 훅 등록(= `api.on`) |
| `CYOA.renderStage / renderStartScreen / renderBackpackPanel` | 엔진 렌더러(직접 호출은 보통 불필요) |

> 전체 노출 목록은 `engine.js` 의 `global.CYOA = { … }` 정의를 참고하세요.

---

## 예제

### A. 읽기 진행률 바

선택한 선택지 수에 따라 채워지는 막대를 페이지 위에 띄웁니다.

```js
var bar = document.createElement("div");
bar.style.cssText = "position:fixed;top:0;left:0;height:4px;background:var(--accent);width:0;transition:width .3s;z-index:9999";
document.body.appendChild(bar);

api.on("render", function (ctx) {
  var totalChoices = CYOA.allChoices(ctx.project).length || 1;
  var picked = ctx.state.selected.length;
  bar.style.width = Math.min(100, picked / totalChoices * 100) + "%";
});
```

### B. 선택 로그(분석/디버그)

플레이어가 무엇을 골랐는지 콘솔에 남기고, 페이지 상단에 작은 배지를 답니다.

```js
api.on("render", function (ctx) {
  console.log("선택 수:", ctx.state.selected.length, ctx.state.selected);
  var badge = ctx.stage.querySelector(".__pick_badge") || (function () {
    var b = document.createElement("div");
    b.className = "__pick_badge";
    b.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:8px";
    ctx.stage.insertBefore(b, ctx.stage.firstChild);
    return b;
  })();
  badge.textContent = "선택한 항목: " + ctx.state.selected.length + "개";
});
```

### C. 선택·이동 이벤트에 반응

`"select"` 와 `"navigate"` 훅으로 “무엇이 방금 바뀌었는지”에 정확히 반응합니다(전체 렌더를 다시 훑지 않고).

```js
api.on("select", function (ctx) {
  // ctx.choiceId 가 방금 토글됨. ctx.selected(선택여부)·ctx.count(다중카운트)
  if (ctx.selected) console.log("선택:", ctx.choiceId, "×" + ctx.count);
});
api.on("navigate", function (ctx) {
  // 페이지 전환: ctx.from → ctx.to
  console.log("이동:", ctx.from, "→", ctx.to, "(" + (ctx.link.label || "") + ")");
});
```

### D. 🎲 랜덤 결과에 연출 더하기

`"roll"` 훅으로 무작위 선택이 확정된 순간에 반응합니다(수동 선택과 구분됨).

```js
api.on("roll", function (ctx) {
  var c = CYOA.findChoice(ctx.project, ctx.choiceId);
  // 예: 뽑힌 결과를 토스트처럼 잠깐 띄우기
  var tip = document.createElement("div");
  tip.textContent = "🎲 운명의 선택: " + (c ? c.title : ctx.choiceId);
  tip.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
    "background:var(--card);color:var(--accent);border:1px solid var(--card-border);" +
    "padding:10px 18px;border-radius:10px;z-index:9999";
  document.body.appendChild(tip);
  setTimeout(function () { tip.remove(); }, 2200);
});
```

### E. 빌드 요약 데이터 활용

`collectBuildSummary` 로 결과 이미지·백팩과 같은 데이터를 받아 **나만의 엔딩 문구**를 만듭니다.

```js
api.on("render", function (ctx) {
  var summary = CYOA.collectBuildSummary(ctx.project, ctx.state);
  var picks = summary.reduce(function (n, g) { return n + g.choices.length; }, 0);
  if (picks >= 5) console.log("풀빌드 달성!", summary);
});
```

---

## 신뢰·보안 모델 (중요)

커스텀 JS는 **임의의 자바스크립트**입니다. 그래서 실행 시점을 신뢰 경계로 나눕니다.

- **내가 내보낸 작품**(단일 파일, 또는 공유 뷰어 세트의 **기본 `project.json`**) → **자동 실행**됩니다. 내 코드이므로 커스텀 CSS와 같은 신뢰 수준입니다.
- **`?p=` 로 다른 프로젝트를 불러올 때, 또는 파일을 드롭해 열 때** → 신뢰 플래그가 있는 내 배포 페이지라도 **자동 실행하지 않고** “사용자 정의 스크립트를 실행할까요?” **확인**을 거칩니다. (신뢰는 *페이지*가 아니라 *번들된 프로젝트 출처*에 묶입니다 — 누군가 `viewer.html?p=<외부 URL>` 링크로 임의 스크립트를 실행시키는 것을 막기 위함.)
- **에디터** → 로드만으로는 실행하지 않습니다. 설정의 **▶ 미리보기에 적용** 을 눌렀을 때만 실행됩니다.

> 출처를 모르는 작품의 스크립트는 실행하지 마세요. 실행을 허용하면 그 페이지 안에서 임의 코드가 동작할 수 있습니다.
