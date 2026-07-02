# 🧭 CYOA 에디터

브라우저에서 바로 동작하는 **인터랙티브 CYOA(Choose Your Own Adventure) 제작 도구**입니다.
설치·빌드 과정 없이(순수 HTML/CSS/JS) 에디터로 작품을 만들고, Neocities·GitHub Pages 같은 **정적 호스팅에 그대로 배포**할 수 있습니다.

## 특징

- **두 장르를 한 작품에서** — 포인트-빌드형(r/makeyourchoice 스타일)과 분기 서사형(Twine 스타일)을 자유롭게 혼합
- **코드 없이 제작** — 트리 + 캔버스 + 인스펙터로 편집, 실수해도 ↩ 되돌리기(Ctrl+Z)
- **풍부한 게임 장치** — 통화(포인트) 예산, 변수·깃발, 동적 텍스트(`{{if:…}}`), 요구조건(그룹·글로벌 세트 포함), 🎲 랜덤 선택
- **플레이어 편의** — 🎒 실시간 백팩(선택 요약·저장 슬롯), 🌓 밝기 전환, 빌드코드 공유, 🖼 결과 이미지 추출
- **제작 보조** — 🕸 연결망(의존 관계) 그래프, 내장 이미지 편집기(크롭·압축), 플레이어 미리보기(viewport 시뮬레이션)
- **숙련자 확장** — 커스텀 CSS/JS와 라이프사이클 훅(`api.on("render", …)`)으로 나만의 기능 구현

## 빠른 시작

```bash
git clone https://github.com/suhyukjin1004-source/cyoa-editor.git
cd cyoa-editor
python3 -m http.server 8765
```

브라우저에서 열기:

- 에디터: <http://localhost:8765/editor.html>
- 뷰어(플레이): <http://localhost:8765/viewer.html>

## GitHub Pages로 바로 사용하기

이 저장소는 정적 파일만으로 구성되어 GitHub Pages로 그대로 호스팅됩니다.
저장소 **Settings → Pages → Deploy from a branch → `main` / `/ (root)`** 를 켜면:

- 에디터: `https://<계정>.github.io/cyoa-editor/editor.html`
- 뷰어: `https://<계정>.github.io/cyoa-editor/viewer.html`

## 문서

| 문서 | 내용 |
|---|---|
| [docs/README.md](docs/README.md) | **상세 매뉴얼** — 핵심 개념, 데이터 형식, 전체 기능 설명 |
| [docs/EXTEND.md](docs/EXTEND.md) | 확장 가이드 — 커스텀 CSS/JS, 훅, 엔진 API |
| [docs/DEPLOY-neocities.md](docs/DEPLOY-neocities.md) | Neocities 배포 절차 |
| [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) | 유명 CYOA 툴(ICC/ICCPlus) 벤치마킹 분석 |

## 라이선스

[MIT](LICENSE)
