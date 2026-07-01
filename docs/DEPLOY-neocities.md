# Neocities 배포 가이드

완성한 CYOA를 [Neocities](https://neocities.org)에 올리는 방법입니다.
Neocities는 **정적 파일만** 서빙하므로(서버 코드 없음), 이 툴의 결과물은 그대로 호환됩니다.

준비물: Neocities 계정(무료) 하나.

---

## 방법 A — 단일 파일 (가장 쉬움) ⭐

이미지가 적당하다면 이 방법을 추천합니다. 올릴 파일이 **하나**뿐입니다.

1. 에디터 상단 **⬆ neocities 내보내기 → ① 단일 파일 (index.html) 내보내기** 클릭.
   - `index.html` 파일이 다운로드됩니다. (엔진·스타일·데이터·이미지가 모두 들어 있음)
2. Neocities에 로그인 → 대시보드의 **Edit site / Files**.
3. **Upload** 버튼으로 방금 받은 `index.html` 을 올립니다. (기존 `index.html` 은 덮어쓰기)
4. 끝. `https://<당신아이디>.neocities.org` 로 접속하면 작품이 바로 열립니다.

> 단일 파일은 이미지가 많을수록 용량이 커집니다. 페이지 로딩이 느리면 **방법 C**를 쓰세요.

---

## 방법 B — 공유 뷰어 세트 (다중 파일) ⭐ 음악/이미지 많을 때

이미지·음악이 많아 단일 파일이 무거워질 때 권장합니다. 에디터가 필요한 파일을 한 번에 내려줍니다.

1. 에디터 상단 **⬆ neocities 내보내기 → ② 공유 뷰어 세트 내려받기 (5개 파일)** 클릭.
   - `index.html` · `viewer.js` · `engine.js` · `styles.css` · `project.json` 5개가 다운로드됩니다.
2. 이 **5개 파일을 모두** Neocities에 업로드합니다(같은 폴더, 파일명 그대로).
3. (이미지를 경로로 쓴 경우) `images/` 폴더, (음악을 경로로 쓴 경우) `audio/` 폴더도 만들어 해당 파일들을 올립니다.
4. `https://<당신아이디>.neocities.org` 접속 → `index.html` 이 나머지를 불러와 재생합니다.
   - 첫 화면에 **제목·소개 + ▶ 시작하기** 시작 화면이 뜹니다. (설정에서 끌 수 있음)

> Neocities 무료 플랜은 `.html .css .js .json .png .jpg .svg .mp3 .ogg` 등 일반 웹 파일을 허용합니다.
> 파일이 서로를 불러오므로 **5개를 모두** 올려야 합니다(하나라도 빠지면 빈 화면).

---

## 방법 C — 이미지 분리 (이미지가 많을 때)

단일 파일이 너무 커질 때, 이미지를 별도 파일로 분리합니다.

1. 에디터에서 **③ 이미지 분리 내보내기** 클릭.
   - 이미지 파일들(`page0.png`, `p0_r0_c0.png` …)과 `project.json` 이 각각 다운로드됩니다.
   - 이 `project.json` 의 이미지 경로는 `images/<파일명>` 으로 바뀌어 있습니다.
2. Neocities에 **방법 B의 공유 뷰어 세트 5개 파일**을 올립니다(`index.html` · `viewer.js` · `engine.js` · `styles.css` · `project.json`).
3. Neocities Files에서 **New Folder** 로 `images` 폴더를 만들고, 받은 이미지 파일들을 그 안에 업로드합니다.
4. 완료. 경로가 맞으면 이미지가 정상 표시됩니다. (배경 음악도 같은 방식으로 `audio/` 폴더 사용)

---

## 확인 & 문제 해결

- **빈 화면 / “project.json 을 불러올 수 없습니다”**
  - 방법 B·C에서 **5개 파일**(`index.html` `viewer.js` `engine.js` `styles.css` `project.json`)이 모두, `index.html` 과 **같은 폴더**에 있는지 확인. 하나라도 빠지면 빈 화면이 됩니다.
  - 파일명 대소문자 정확히 일치(`viewer.js`, `engine.js`, `styles.css`).
- **이미지가 안 보임 (방법 C)**
  - `images/` 폴더 이름과 그 안의 파일명이 `project.json` 의 경로와 일치하는지 확인.
- **수정하고 싶을 때**
  - 에디터에서 다시 편집 → 내보내기 → Neocities에 같은 이름으로 다시 업로드(덮어쓰기).
  - 원본 편집을 위해 **저장(JSON)** 백업을 꼭 보관하세요. (단일 파일 `index.html` 만으로는 재편집이 번거롭습니다.)
- **공유 링크 / 빌드코드**
  - 뷰어의 **빌드코드** 버튼은 현재 선택 상태를 URL(`#code=…`)로 복사합니다. 그 링크를 열면 같은 선택이 복원됩니다.

---

## 로컬에서 미리 확인하기

업로드 전 로컬에서 배포본을 그대로 확인하려면:

```bash
python3 -m http.server 8765
# 단일 파일: 내보낸 index.html 을 더블클릭(브라우저)해도 동작
# 다중 파일: http://localhost:8765/index.html
```
