## 실시간 QR 출석 시스템

Node.js + Express + 브라우저 JS로 만든 **지연 시간 기반 QR 출석 시스템**입니다.  
QR 생성기(`/generator`)에서 토큰을 만들고, 학생 스캐너(`/attend`)가 찍은 결과를 서버를 거쳐 다시 생성기로 돌려보내 **delta(ms)·Risk를 생성기에서 계산**합니다.

---

### 1. 어떻게 돌아가는지

- **`/generator` (교수)**: 브라우저에서 QR 토큰 직접 생성 → 화면에 띄움 → `/api/attend-log`를 폴링해서 학생 로그를 받고 delta/Risk 계산.
- **`/attend` (학생)**: 휴대폰 카메라로 QR 스캔 → 인식된 텍스트(`cipher`)와 `studentId`를 `POST /api/qr`로 전송.
- **`server.js` (서버)**: `POST /api/qr` 요청마다 `studentId + cipher + serverRecvTs`를 메모리에 저장 → `GET /api/attend-log`로 그대로 돌려줌.

---

### 2. 실행 방법

```bash
cd "/Users/kimyougwoo/융보프2/qr code"
npm install       # 최초 1회
npm start         # 서버 실행 (기본 포트 3000)
```

- 접속 URL:
  - `http://localhost:3000/` → 인덱스
  - `http://localhost:3000/generator` → QR 생성(교수용)
  - `http://localhost:3000/attend` → 출석 스캔(학생용)

---

### 3. iPhone / HTTPS 테스트 (ngrok)

- iOS Safari에서 카메라를 쓰려면 **HTTPS**가 필요합니다.
- `NGROK_SETUP.md` 참고 (요약: `npm install -g ngrok` → `ngrok config add-authtoken ...` → `npm run dev:ngrok` → `https://...ngrok-free.app` 로 접속).

---

### 4. 요약

- **인터페이스**: `/generator` 우측 테이블에서 `Student ID / Delta(ms) / Risk / Label / Time`을 바로 볼 수 있음.
- **FPS 조절**: `/generator`에서 목표 FPS(15/30/60)를 선택해 QR 갱신 속도와 delta 분포 변화를 실험 가능.
- **보안 수준**: 토큰 생성·판정이 브라우저 쪽에 있으므로 **연구/실험 단계의 구현**이며, 실서비스에서는 서버 사이드 토큰/검증이 필요함.

