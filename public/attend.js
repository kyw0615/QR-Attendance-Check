// attend.js
// /attend 페이지에서 카메라로 QR을 실시간 스캔하여
// 인식된 cipher(암호문)를 서버 /api/qr(POST)에 보내고,
// 서버는 학생정보 + QR 텍스트 + 수신 시각만 기록한다.
// 최종 delta / risk / label 계산은 /generator 페이지에서 수행되므로,
// 여기서는 "전송 성공" 여부만 표시한다.

const videoEl = document.getElementById("video");
const canvasEl = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const startBtn2 = document.getElementById("startBtn");
const stopBtn2 = document.getElementById("stopBtn");
const studentIdInput = document.getElementById("studentId");
const resultTableBody = document.querySelector("#resultTable tbody");

let scanRunning = false;
let videoStream = null;
let scanIndex = 0;
let lastSentCipher = null;

// 카메라 열기 (가능하면 후면 카메라)
async function startCamera() {
  // 일부 환경에서는 navigator.mediaDevices 자체가 없을 수 있으므로 방어 코드
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      "이 브라우저에서는 카메라 API(MediaDevices.getUserMedia)를 지원하지 않습니다. 최신 Chrome/Edge/모바일 브라우저 또는 HTTPS 환경에서 시도해 주세요."
    );
  }
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      // qr_detect.html 과 유사하게, 조금 높은 해상도를 힌트로 줘서
      // 카메라가 더 잘 포커싱하도록 유도
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };
  videoStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = videoStream;
  await videoEl.play();
}

// 카메라 스트림 정리
function stopCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
  videoEl.srcObject = null;
}

// 서버로 스캔 결과 전송
async function sendToServer(cipher, studentId) {
  try {
    const res = await fetch("/api/qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cipher, studentId }),
    });
    const data = await res.json();
    if (!data.ok) {
      statusEl.textContent = `서버 응답 오류: ${data.error || "unknown"}`;
      return;
    }

    // 응답값: studentId, serverRecvTs, cipher 만 사용
    scanIndex += 1;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${scanIndex}</td>
      <td>${data.studentId}</td>
      <td>-</td>
      <td>pending</td>
      <td>서버에 전송됨</td>
    `;
    resultTableBody.appendChild(tr);
    statusEl.textContent = `마지막 전송: studentId=${data.studentId}`;
  } catch (err) {
    console.error("POST /api/qr 실패:", err);
    statusEl.textContent = "서버 통신 오류: " + err.message;
  }
}

// 스캔 루프: requestAnimationFrame 으로 매 프레임 비디오를 캔버스로 그린 뒤 jsQR 로 디코딩
async function scanLoop() {
  if (!scanRunning) return;

  if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
    const width = videoEl.videoWidth;
    const height = videoEl.videoHeight;
    if (width && height) {
      canvasEl.width = width;
      canvasEl.height = height;
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(videoEl, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);

      const qrCode = jsQR(imageData.data, width, height, {
        inversionAttempts: "dontInvert",
      });

      if (qrCode && qrCode.data) {
        const cipher = qrCode.data;
        const studentId = studentIdInput.value.trim();

        // 같은 cipher 를 너무 자주 보내는 것 방지 (간단한 디바운싱)
        if (cipher !== lastSentCipher) {
          lastSentCipher = cipher;
          statusEl.textContent = "QR 인식 성공, 서버에 전송 중...";
          sendToServer(cipher, studentId);
        }
      }
    }
  }

  requestAnimationFrame(scanLoop);
}

startBtn2.addEventListener("click", async () => {
  const studentId = studentIdInput.value.trim();
  if (!studentId) {
    alert("학번을 먼저 입력하세요.");
    return;
  }
  if (scanRunning) return;

  try {
    await startCamera();
    scanRunning = true;
    statusEl.textContent = "스캔 중...";
    requestAnimationFrame(scanLoop);
  } catch (err) {
    console.error("카메라 시작 실패:", err);
    statusEl.textContent = "카메라를 열 수 없습니다: " + err.message;
  }
});

stopBtn2.addEventListener("click", () => {
  scanRunning = false;
  stopCamera();
  statusEl.textContent = "스캔 중지됨.";
});


