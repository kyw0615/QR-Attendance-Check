// generator.js
// /generator 페이지에서 qrcode.js를 사용해 ECC = M 고정으로 렌더링한다.
// - QR 토큰은 브라우저에서 직접 생성 (서버에 의존하지 않음)
// - 학생이 찍은 QR 정보는 서버로 전달된 뒤, /api/attend-log 를 통해 조회
// - 최종 인증 판정(delta / risk / label)은 이 페이지에서 수행

const qrContainer = document.getElementById("qrContainer");
const tokenLenEl = document.getElementById("tokenLen");
const renderTimeEl = document.getElementById("renderTime");
const fpsEl = document.getElementById("fps");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const profLogTableBody = document.querySelector("#profLogTable tbody");
const fpsSelect = document.getElementById("fpsSelect");

let qr;
let running = false;
// 토큰 생성 시각 기록: cipher 문자열 → 생성된 Date.now()
const tokenCreatedAt = new Map();
let lastFpsUpdate = performance.now();
let frameCount = 0;
let lastTokenUpdate = 0;
let targetFps = 60;
let consecutiveErrors = 0;

// 기본 FPS 기준: 약 16.67ms 간격 (렌더링 주기)
const FRAME_INTERVAL_60 = 1000 / 60;
// 토큰 갱신 최소 간격 (ms) - 선택된 FPS에 따라 동적으로 계산
let minTokenInterval = Math.round(1000 / targetFps);

function ensureQrInstance() {
  if (!qr) {
    // qrcode.js: correctLevel 옵션으로 ECC 설정
    qr = new QRCode(qrContainer, {
      text: "init",
      width: 320,
      height: 320,
      correctLevel: QRCode.CorrectLevel.M, // ECC=M 고정
    });
  }
}

// 브라우저에서 직접 QR 토큰 생성
// 형식 예: "1:<tsLow-36진수>:<랜덤문자열>"
function makeLocalToken() {
  const now = Date.now();
  const tsLow = (now & 0xffffffff) >>> 0;
  const nonce = Math.random().toString(36).slice(2, 8);
  const token = `1:${tsLow.toString(36)}:${nonce}`;
  tokenCreatedAt.set(token, now);
  return token;
}

async function updateToken() {
  try {
    const start = performance.now();
    const cipher = makeLocalToken();

    ensureQrInstance();
    qr.clear();
    qr.makeCode(cipher);

    const end = performance.now();
    tokenLenEl.textContent = cipher.length.toString();
    renderTimeEl.textContent = (end - start).toFixed(2);
    statusEl.textContent = "Token updated (local)";
    consecutiveErrors = 0;
  } catch (err) {
    console.error("QR 토큰 생성/렌더 오류:", err);
    statusEl.textContent = "에러 발생: " + err.message;
    consecutiveErrors += 1;
    // 너무 자주 실패하면 상태만 갱신하고, 루프는 계속 유지
    if (consecutiveErrors >= 10) {
      statusEl.textContent =
        "에러가 반복되고 있습니다. 네트워크/서버 상태를 확인해 주세요.";
    }
  }
}

function renderLoop(now) {
  if (!running) return;

  // 프레임 카운팅
  frameCount += 1;

  // 선택된 FPS 기준으로 토큰 갱신: 직전 갱신 이후 minTokenInterval 이상 지났을 때만
  if (now - lastTokenUpdate >= minTokenInterval) {
    lastTokenUpdate = now;
    updateToken();
  }

  // 대략적인 FPS 계산 (1초마다 갱신)
  if (now - lastFpsUpdate >= 1000) {
    fpsEl.textContent = frameCount.toString();
    frameCount = 0;
    lastFpsUpdate = now;
  }

  requestAnimationFrame(renderLoop);
}

startBtn.addEventListener("click", () => {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  statusEl.textContent = "초기화 중...";
  lastFpsUpdate = performance.now();
  frameCount = 0;
  lastTokenUpdate = 0;

  // 렌더 루프 시작 (토큰 갱신은 루프 안에서 60fps 기준으로 처리)
  requestAnimationFrame(renderLoop);
});

// FPS 선택 변경 시 목표 FPS와 토큰 갱신 간격 업데이트
fpsSelect.addEventListener("change", () => {
  const value = parseInt(fpsSelect.value, 10);
  if (!Number.isFinite(value) || value <= 0) return;
  targetFps = value;
  minTokenInterval = Math.round(1000 / targetFps);
  statusEl.textContent = `목표 FPS가 ${targetFps}로 설정되었습니다.`;
});

function classifyDelta(delta) {
  if (delta < 250) return { risk: "normal", label: "신뢰" };
  if (delta < 600) return { risk: "suspect", label: "의심" };
  return { risk: "high", label: "실패" };
}

// 교수용: 서버에서 최근 출석 인증 로그를 가져와 테이블에 표시
async function refreshAttendLog() {
  try {
    const res = await fetch("/api/attend-log");
    if (!res.ok) return;
    const data = await res.json();
    const items = data.items || [];
    profLogTableBody.innerHTML = "";
    for (const row of items) {
      // 이 생성 세션에서 만든 토큰만 대상으로 삼는다.
      const createdAt = tokenCreatedAt.get(row.cipher);
      if (!createdAt) continue;

      const delta = row.serverRecvTs - createdAt;
      if (delta < 0) continue; // 시계 차이 등으로 이상하면 스킵
      const { risk, label } = classifyDelta(delta);

      const tr = document.createElement("tr");
      if (risk === "normal") {
        tr.classList.add("risk-normal-row");
      } else if (risk === "suspect") {
        tr.classList.add("risk-suspect-row");
      } else if (risk === "high") {
        tr.classList.add("risk-high-row");
      }
      const timeText = row.logTime || "";
      tr.innerHTML = `
        <td>${row.id}</td>
        <td>${row.studentId}</td>
        <td>${delta}</td>
        <td>${risk}</td>
        <td>${label}</td>
        <td>${timeText}</td>
      `;
      profLogTableBody.appendChild(tr);
    }
  } catch {
    // 조용히 무시 (로그 페이지에만 영향)
  }
}

// 1초마다 출석 로그 새로고침
setInterval(refreshAttendLog, 1000);


