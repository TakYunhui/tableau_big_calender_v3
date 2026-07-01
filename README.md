# tableau_big_calender_v2

Tableau Dashboard Extension 기반 조회기간 선택 UI다.

배포 URL:
`https://takyunhui.github.io/tableau_big_calender_v2/`

Manifest:
[`docs/calender.trex`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/calender.trex)

## 목적

- Tableau 기본 날짜 UI보다 빠르게 기간을 선택
- 단일 날짜 / 기간 조회를 한 확장에서 같이 처리
- 자주 쓰는 기간을 빠른선택으로 즉시 반영
- 작은 확장영역 안에서도 날짜와 버튼이 읽히게 최적화

## 현재 기능

### 기간 조회 모드

- 시작일 / 종료일 개별 선택
- 달력 range 선택
- 적용 버튼으로 Tableau 파라미터 반영
- 빠른선택 지원

빠른선택 기준:
- `오늘`: 오늘 하루
- `어제`: 어제 하루
- `이번주`: 이번주 월요일 ~ 오늘
- `이번달`: 이번달 1일 ~ 오늘
- `지난달`: 지난달 1일 ~ 지난달 말일
- `금년 누계`: 올해 1월 1일 ~ 오늘
- `전년 동월`: 작년 같은 달 1일 ~ 말일
- `전년 누계`: 작년 1월 1일 ~ 12월 31일
- `1분기`: 올해 1~3월
- `2분기`: 올해 4~6월
- `3분기`: 올해 7~9월
- `4분기`: 올해 10~12월

### 단일 날짜 모드

- 조회일 1개만 선택
- 빠른선택 지원

단일 날짜 빠른선택:
- `오늘`
- `어제`
- `전월 말`

## 최근 반영 사항

- 날짜 표시 형식을 확장프로그램 쪽에서 `Y. n. j` 기본값으로 통일
- 단일 날짜 모드 라벨을 `조회` 기준으로 정리
- 빠른선택 버튼을 그룹형 UI로 재구성
  - `최근`
  - `월`
  - `누계·전년`
  - `분기`
- 그룹별 버튼 색상 분리
- `최근 + 월`을 같은 줄에, 그 아래 `누계·전년`, 그 아래 `분기` 배치
- 태블릿/WebView 자동 글자 확대 억제
  - `-webkit-text-size-adjust: none`
  - `text-size-adjust: none`
- 스크립트 / 스타일 캐시버스터 적용

## 동작 방식

- Tableau dashboard에서 날짜형 파라미터를 읽음
- 설정된 시작 / 종료 파라미터에 날짜를 반영
- `ParameterChanged` 이벤트를 구독해서 외부 변경도 UI에 동기화
- 달력 또는 빠른선택에서 값을 바꾼 뒤 적용 버튼으로 최종 반영

## 주요 파일

- [`docs/index.html`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/index.html)
  - 메인 UI
- [`docs/main.js`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/main.js)
  - 날짜 계산, 빠른선택, Tableau 연동
- [`docs/styles.css`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/styles.css)
  - 레이아웃, 버튼, 그룹 스타일
- [`docs/config.html`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/config.html)
  - 설정 UI
- [`docs/config.js`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/config.js)
  - 파라미터 매핑 설정 로직
- [`docs/calender.trex`](/abs/path/C:/Users/lenovo/OneDrive/Desktop/tableau_big_calender_v2/docs/calender.trex)
  - Tableau Extension manifest

## 배포 메모

- GitHub Pages의 `docs/`를 사용
- Tableau에서 `.trex` manifest를 통해 확장을 로드
- 캐시 이슈가 있을 수 있어 CSS/JS 버전 문자열과 manifest URL 버전을 같이 관리
