# 개선 방향 분석 — 유명 인터랙티브 CYOA 벤치마킹

> 2026-07 조사. 인터랙티브 CYOA 생태계의 사실상 표준 도구와 유명 작품을 조사해
> 본 툴과 기능을 비교하고, 개선 우선순위를 도출한 보고서.

## 조사 배경

인터랙티브 CYOA 커뮤니티(r/InteractiveCYOA, r/makeyourchoice)에서 유통되는 유명 작품
(Worm CYOA V6 계열, Lt. Ouroboros CYOA Plus 등)은 대부분 아래 도구로 제작되어
**Neocities 정적 호스팅**에 배포된다 — 본 툴과 동일한 배포 모델이라 직접 비교가 유효하다.

- [Interactive CYOA Creator (ICC, MeanDelay)](https://meandelay.itch.io/interactive-cyoa-creator) — 원조. 2021년 이후 유지보수 중단.
- [ICC 기능 레퍼런스](https://icctutorial.pages.dev/appendix/reference/) · [백팩/빌드 공유 문서](https://icctutorial.pages.dev/mechanics/backpack-and-choice-import/)
- [ICCPlus (wahaha303)](https://github.com/wahaha303/ICCPlus) · [ICC Plus 2](https://hikawasisters.neocities.org/ICCPlus/) — 활발히 유지보수되는 후계 포크.
- 유명 작품 예: [Ouroboros CYOA Plus](https://begiotsuda.neocities.org/Ouroboros_CYOA/), [Worm CYOA V6 계열](https://interactivewormcyoav6.neocities.org/)

## 기능 비교 (본 툴 vs ICC/ICCPlus)

| 기능 | 본 툴 | ICC/ICCPlus | 판정 |
|---|---|---|---|
| 포인트/통화, 요구조건(AND·OR·비교), 변수, 동적 텍스트, 애드온, 다중 선택 스테퍼, BGM, 커스텀 CSS/JS, 결과 이미지 | ✅ | ✅ | 동등 이상 |
| 연결망 그래프 뷰, 이미지 편집기(크롭·압축), 오프닝 자유 배치, 분기 서사형 혼합 | ✅ | ❌ | **본 툴 우위** |
| 실시간 백팩(선택 요약 패널, 카테고리별 표시, 패널에서 해제) | ✅ (이번에 추가) | ✅ 핵심 기능 | 격차 해소 |
| 다중 저장 슬롯(작품별, ICCPlus는 99슬롯+오토세이브) | ✅ (이번에 추가: 10슬롯+오토세이브) | ✅ | 격차 해소 |
| 플레이어측 밝기(다크/라이트) 토글 | ✅ (이번에 추가) | ✅ | 격차 해소 |
| 랜덤 선택(주사위/롤) — "출신을 굴려라" 연출 | ✅ (이번에 추가) | ✅ | 격차 해소 |
| 그룹(행을 가로지르는 선택지 묶음 → 백팩 분류·요구조건) | ✅ (이번에 추가) | ✅ | 격차 해소 |
| 글로벌 요구조건(조건 세트 정의·재사용) | ✅ (이번에 추가) | ✅ | 격차 해소 |
| 선택지 검색 / 목차 내비게이션 | ❌ | 서드파티 스크립트(IntCyoaEnhancer)로 보완 | **후속 과제** |

## 이번에 구현한 개선 (우선순위: 사용자 선정)

1. **플레이어 편의** — 🎒 실시간 백팩 패널(그룹별 분류, 패널에서 선택 해제), 💾 저장 슬롯(작품별 10개, 빌드 코드와 같은 포맷), 🌓 플레이어측 밝기 토글(제작자가 설정에서 끌 수 있음).
2. **랜덤/주사위** — 행 단위 🎲 랜덤 선택 버튼. 요구조건을 통과하고 예산이 감당되는 후보 중에서만 굴리며, 룰렛 하이라이트 연출 후 확정.
3. **제작 로직 강화** — **그룹**(설정에서 정의, 선택지에 태그, 요구조건 「그룹 내 선택 수」 비교, 백팩 분류에 활용)과 **글로벌 요구조건**(조건 세트를 한 번 정의해 여러 곳에서 참조, `{{if:global:id}}` 동적 텍스트 지원, 순환 참조 가드).
4. **조건부 점수(코스트 할인/수정자)** — ICCPlus의 "행 할인" 개념을 일반화. 점수 항목에 선택적 `requirements`를 달면 조건 충족 시에만 적용(할인·조건부 비용·조건부 보상). 통화 참조 조건의 재귀를 막기 위해 통화 계산을 2-패스(무조건→base, 조건부는 base로 평가)로 구현. 재생 중엔 활성 항목만 표시.
5. **IndexedDB 자동저장(B)** — 에디터 자동저장(이미지 내장으로 커짐)을 localStorage(~5MB)에서 IndexedDB(수백 MB급)로 전환. 미지원 환경은 localStorage 폴백, 기존 localStorage 자동저장은 첫 로드 시 1회 자동 이관 후 정리. 300ms 디바운스 + beforeunload flush. (뷰어 저장 슬롯·진행은 빌드코드=선택상태만이라 작아서 localStorage 유지.)
6. **웹폰트 URL(C)** — 설정 → 테마에 `fontUrl`(웹폰트 스타일시트 URL) 추가. `applyTheme`가 별도 `#cyoa-font-face` `<style>`에 `@import url("…")` 주입, 폰트 이름은 기존 `font` 칸. 보안: `safeFontUrl`이 **https 스타일시트 URL만** 허용하고 `"'()<> \` 공백 등을 배제해 `url()` 컨텍스트 탈출·CSS 주입을 차단(프로토콜상대는 https로 승격, http·javascript는 거부).
7. **이미지 템플릿(D)** — 선택지 `layout.imagePos: "background"`(이미지가 카드 전체를 채우고 제목·설명이 스크림 위에 오버레이 — r/makeyourchoice 스타일)와 행 `bgImage`(행 전체 배경, 테마색 스크림). 배경 URL은 `element.style.backgroundImage`에 `JSON.stringify`로 넣어 단일 속성 대입 → CSS 규칙 주입 불가. **이로써 ICC/ICCPlus 이식 후보 A·B·C·D 모두 완료.**

## 후속 과제 (이번 범위 제외)

- **검색/목차 내비게이션**: 수천 선택지 규모 작품에서 필수. 스크롤형 목차(페이지 점프) + 선택지 제목 검색 오버레이. (ICC 후보를 모두 소진했으므로, 다음 개선은 이쪽이 유력.)
- (참고) ICC2(intcyoacreator)는 **라이선스가 없어 코드 복사 불가**, ICCPlus는 MIT지만 Svelte라 어차피 개념 재구현이 유일한 경로. YouTube BGM은 본 툴의 파일/URL BGM으로 대체 가능해 보류.
