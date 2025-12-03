// generator.js
// /generator 페이지에서 qrcode.js를 사용해 ECC = M 고정으로 렌더링한다.
// - QR 토큰은 "교수 브라우저에서 직접 AES-256-GCM 으로 암호화"해서 생성한다.
//   (세션 키는 브라우저 메모리에만 존재하고 서버에는 절대 전달되지 않음)
// - 학생이 찍은 QR(cipher 문자열)은 서버로 전달되고, 서버는 단순히 로그/중계만 한다.
// - 최종 인증 판정(delta / risk / label)과, 필요시 복호화/검증은 이 페이지에서 수행한다.

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
// 서버/클라이언트 시계 차이(ms). 서버시간 ≈ Date.now() + timeOffsetMs
let timeOffsetMs = 0;

let lastFpsUpdate = performance.now();
let frameCount = 0;
let lastTokenUpdate = 0;
let targetFps = 60;
let consecutiveErrors = 0;

// === 세션별 AES-256-GCM 키 관리 (교수 브라우저 전용) ===
// - 세션이 시작될 때 32바이트 랜덤 키를 생성하여, 이 페이지 내에서만 사용한다.
// - 서버는 이 키를 알 수 없으며, 단순히 cipher 문자열을 운반/저장만 한다.
let sessionAesKeyPromise = null; // Promise<CryptoKey>

function ensureSessionKey() {
  if (!sessionAesKeyPromise) {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    sessionAesKeyPromise = crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }
  return sessionAesKeyPromise;
}

// 10바이트 payload 생성 (서버의 /api/qr 과 동일한 구조 유지)
// [0]      : version (1바이트)
// [1..4]   : tsLow = Date.now() & 0xffffffff (uint32 BE)
// [5]      : roomCode (1바이트, 예: 1)
// [6..9]   : randomNonce (4바이트 난수)
function buildPayload(nowMs) {
  const payload = new Uint8Array(10);
  const view = new DataView(payload.buffer);

  const version = 1;
  const tsLow = (nowMs & 0xffffffff) >>> 0;
  const roomCode = 1;

  payload[0] = version;
  // BE로 쓰기
  view.setUint32(1, tsLow, false);
  payload[5] = roomCode;

  const nonceBytes = new Uint8Array(4);
  crypto.getRandomValues(nonceBytes);
  payload.set(nonceBytes, 6);

  return payload;
}

function concatUint8Arrays(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 서버 시간과 클라이언트 시간 동기화
async function syncServerTime() {
  try {
    const t0 = Date.now();
    const res = await fetch("/api/server-time");
    const data = await res.json();
    const t3 = Date.now();

    const serverTime = data.serverTime;
    const rtt = t3 - t0;
    const clientAtServerStamp = t0 + rtt / 2;

    // 서버 시각 - (그때의 클라 시각) = 시계 차이
    timeOffsetMs = serverTime - clientAtServerStamp;
    console.log("[TimeSync] offset(ms) =", timeOffsetMs);
  } catch (e) {
    console.error("[TimeSync] 서버 시간 동기화 실패", e);
    // 실패하면 예전처럼 동작
    timeOffsetMs = 0;
  }
}

// 기본 FPS 기준: 약 16.67ms 간격 (렌더링 주기)
const FRAME_INTERVAL_60 = 1000 / 60;
// 토큰 갱신 최소 간격 (ms) - 선택된 FPS에 따라 동적으로 계산
let minTokenInterval = Math.round(1000 / targetFps);

// 브라우저에서 직접 QR 토큰(cipher) 생성
// - 서버의 /api/qr 과 동일한 10바이트 payload 구조를 만들고
// - 이 페이지에서 가지고 있는 세션 키로 AES-256-GCM 암호화한 뒤
//   iv(12바이트) + ciphertext+authTag 를 base64 로 인코딩한 문자열을 반환한다.
async function makeLocalToken() {

  const clientNow = Date.now();
  // ✅ 서버 기준 현재 시각으로 보정
  const now = clientNow + timeOffsetMs;

  // const now = Date.now();
  const key = await ensureSessionKey();

  const payload = buildPayload(now);

  // GCM 권장 12바이트 IV
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    payload
  );
  const ciphertext = new Uint8Array(ciphertextBuf); // 포함된 authTag 포함

  const combined = concatUint8Arrays(iv, ciphertext);
  const cipherBase64 = bytesToBase64(combined);

  // 생성 시각 기록: cipher 문자열 → 생성된 Date.now()
  tokenCreatedAt.set(cipherBase64, now);
  return cipherBase64;
}

async function updateToken() {
  try {
    const start = performance.now();
    const cipher = await makeLocalToken();

    // show.html과 동일하게 매번 새 인스턴스 생성 (더 안정적)
    qrContainer.innerHTML = "";
    qr = new QRCode(qrContainer, {
      text: cipher,
      width: 320,
      height: 320,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M, // ECC=M 고정
    });

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

// startBtn.addEventListener("click", () => {
//   if (running) return;
//   running = true;
//   startBtn.disabled = true;
//   statusEl.textContent = "초기화 중...";
//   lastFpsUpdate = performance.now();
//   frameCount = 0;
//   lastTokenUpdate = 0;

//   // 렌더 루프 시작 (토큰 갱신은 루프 안에서 60fps 기준으로 처리)
//   requestAnimationFrame(renderLoop);
// });
startBtn.addEventListener("click", async () => {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  statusEl.textContent = "초기화 중...";

  // ✅ 토큰 생성 시작 전에 서버와 시계 먼저 맞추기
  await syncServerTime();

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

// 통계 기반 이상치 탐지: 평균과 표준편차를 이용하여 이상치 판정
function calculateMeanStd(values) {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  return { mean, std };
}

// 이상치를 제외하고 평균 재계산 (반복적으로)
function calculateRobustMean(studentAverages, thresholdStd = 2.0) {
  if (studentAverages.length === 0) return { mean: 0, std: 0, included: [] };
  
  let currentValues = [...studentAverages];
  let prevMean = 0;
  let iterations = 0;
  const maxIterations = 10;
  
  while (iterations < maxIterations) {
    const { mean, std } = calculateMeanStd(currentValues);
    
    // 수렴 확인 (변화가 거의 없으면 종료)
    if (Math.abs(mean - prevMean) < 0.1) break;
    
    // 이상치 제외: 평균에서 thresholdStd * std 이상 벗어난 값 제거
    const filtered = currentValues.filter(val => {
      const zScore = Math.abs((val - mean) / (std || 1));
      return zScore <= thresholdStd;
    });
    
    if (filtered.length === 0 || filtered.length === currentValues.length) break;
    
    currentValues = filtered;
    prevMean = mean;
    iterations++;
  }
  
  const { mean, std } = calculateMeanStd(currentValues);
  return { mean, std, included: currentValues };
}

// 교수용: 서버에서 최근 출석 인증 로그를 가져와 테이블에 표시
// 같은 학번이면 집계하여 하나의 행으로 표시
// 통계 기반 이상치 탐지로 의심률 측정
async function refreshAttendLog() {
  try {
    const res = await fetch("/api/attend-log");
    if (!res.ok) return;
    const data = await res.json();
    const items = data.items || [];
    
    // 학번별로 데이터 집계
    const studentData = new Map(); // studentId -> { deltas: [] }
    
    for (const row of items) {
      // 이 생성 세션에서 만든 토큰만 대상으로 삼는다.
      const createdAt = tokenCreatedAt.get(row.cipher);
      if (!createdAt) continue;

      const delta = row.serverRecvTs - createdAt;
      if (delta < 0) continue; // 시계 차이 등으로 이상하면 스킵
      
      const studentId = row.studentId;
      if (!studentData.has(studentId)) {
        studentData.set(studentId, {
          deltas: [],
        });
      }
      
      const student = studentData.get(studentId);
      student.deltas.push(delta);
    }
    
    // 각 학생의 평균 지연시간 계산
    const studentAverages = [];
    const studentAvgMap = new Map(); // studentId -> 평균 지연시간
    
    for (const [studentId, data] of studentData.entries()) {
      if (data.deltas.length === 0) continue;
      const avg = data.deltas.reduce((a, b) => a + b, 0) / data.deltas.length;
      studentAverages.push(avg);
      studentAvgMap.set(studentId, avg);
    }
    
    // 이상치를 제외한 강건한 평균 계산 (표준편차 2배 이상 벗어난 값 제외)
    const robustStats = calculateRobustMean(studentAverages, 2.0);
    const globalMean = robustStats.mean;
    const globalStd = robustStats.std;
    
    // 테이블 업데이트: 학번별로 하나의 행만 표시
    profLogTableBody.innerHTML = "";
    
    // 학번별로 정렬 (학번 순서대로)
    const sortedStudents = Array.from(studentData.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    );
    
    for (const [studentId, data] of sortedStudents) {
      const deltas = data.deltas;
      const count = deltas.length;
      if (count === 0) continue;
      
      const avgDelta = Math.round(deltas.reduce((a, b) => a + b, 0) / count);
      const minDelta = Math.min(...deltas);
      const maxDelta = Math.max(...deltas);
      
      // 통계 기반 의심률 계산
      // 학생의 평균이 전체 평균에서 얼마나 벗어났는지 측정
      const studentAvg = studentAvgMap.get(studentId);
      let suspectRate = 0;

      if (globalStd > 0) {
        const diff = studentAvg - globalMean;
        const absDiff = Math.abs(diff);

        // 1) 평균으로부터 ±50ms 이내는 의심하지 않음 (데드존)
        if (absDiff <= 50) {
          suspectRate = 0;
        } else {
          const zScore = Math.abs(diff / globalStd);

          // 2) Z-score 기준을 조금 더 빡세게 조정
          // - 0~1σ: 0% (데드존 + 거의 정상)
          // - 1~2σ: 30~70%
          // - 2~3σ: 70~95%
          // - 3σ 이상: 95~100%
          if (zScore < 1.0) {
            suspectRate = 0;
          } else if (zScore < 2.0) {
            suspectRate = Math.round(30 + (zScore - 1.0) * 40); // 30-70%
          } else if (zScore < 3.0) {
            suspectRate = Math.round(70 + (zScore - 2.0) * 25); // 70-95%
          } else {
            suspectRate = Math.round(95 + Math.min((zScore - 3.0) * 5, 5)); // 95-100%
          }
        }
      }
      
      // 의심률에 따라 행 색상 결정
      const tr = document.createElement("tr");
      if (suspectRate === 0) {
        tr.classList.add("risk-normal-row");
      } else if (suspectRate < 50) {
        tr.classList.add("risk-suspect-row");
      } else {
        tr.classList.add("risk-high-row");
      }
      
      tr.innerHTML = `
        <td>${studentId}</td>
        <td>${count}</td>
        <td>${avgDelta}</td>
        <td>${minDelta}</td>
        <td>${maxDelta}</td>
        <td>${suspectRate}%</td>
      `;
      profLogTableBody.appendChild(tr);
    }
  } catch {
    // 조용히 무시 (로그 페이지에만 영향)
  }
}

// 1초마다 출석 로그 새로고침!
setInterval(refreshAttendLog, 1000);




