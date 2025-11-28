// server.js
// Node.js + Express 기반 서버
// - GET /api/qr : QR 토큰 생성 (AES-256-GCM 암호화)
// - POST /api/qr : QR 토큰 검증 및 delta / riskLevel 계산
// - 정적 페이지: /, /generator, /attend

require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

// 간단한 출석 인증 로그 메모리 저장소
// - POST /api/qr 요청이 성공할 때마다 한 줄씩 추가
// - GET /api/attend-log 에서 교수용 /generator 페이지로 전달
const ATTEND_LOG = [];
const MAX_ATTEND_LOG = 500;

// --- QR용 AES-256-GCM 키 초기화 --- //
// - .env에 QR_SECRET_KEY가 있으면 base64 디코딩 후 32바이트면 사용
// - 없거나 잘못된 경우, 서버 시작 시 랜덤 32바이트 키를 한 번 생성하여 유지
let QR_KEY;

const secretKeyBase64 = process.env.QR_SECRET_KEY;

if (secretKeyBase64) {
  const buf = Buffer.from(secretKeyBase64, "base64");
  if (buf.length === 32) {
    QR_KEY = buf;
    console.log("[QR_KEY] Loaded from env (QR_SECRET_KEY)");
  } else {
    console.warn(
      "[QR_KEY] QR_SECRET_KEY is not 32 bytes after base64 decode. Ignoring and generating random key."
    );
  }
}

if (!QR_KEY) {
  QR_KEY = crypto.randomBytes(32);
  const generatedBase64 = QR_KEY.toString("base64");
  console.log("[QR_KEY] Generated random 32-byte key for this run.");
  console.log(
    "[QR_KEY] (If you want to persist it, put this in .env as QR_SECRET_KEY)"
  );
  console.log(`QR_SECRET_KEY=${generatedBase64}`);
}

app.use(express.json());

// 정적 파일 제공
const publicDir = path.join(__dirname, "public");
app.use("/public", express.static(publicDir));

// 라우팅: 인덱스, generator, attend
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/generator", (req, res) => {
  res.sendFile(path.join(publicDir, "generator.html"));
});

app.get("/attend", (req, res) => {
  res.sendFile(path.join(publicDir, "attend.html"));
});

// GET /api/qr
// - 10바이트 바이너리 payload를 생성 후 AES-256-GCM 으로 암호화
//   구조 (총 10바이트):
//   [0]      : version (1바이트, 현재 1)
//   [1..4]   : tsLow = Date.now() & 0xffffffff (ms 단위 하위 32비트, uint32 BE)
//   [5]      : roomCode (1바이트, 예: 1)
//   [6..9]   : randomNonce (4바이트 난수)
// - AES-256-GCM(iv 12바이트, authTag 16바이트) 로 암호화 후
//   iv||tag||ciphertext 를 base64 로 인코딩하여 cipher 필드로 반환
app.get("/api/qr", (req, res) => {
  try {
    const nowMs = Date.now();
    // ms 단위 시각의 하위 32비트만 사용 (약 49.7일 주기로 래핑)
    const tsLow = (nowMs & 0xffffffff) >>> 0; // uint32
    const version = 1;
    const roomCode = 1;

    const payload = Buffer.alloc(10);
    payload.writeUInt8(version, 0);
    payload.writeUInt32BE(tsLow, 1);
    payload.writeUInt8(roomCode, 5);
    // 4바이트 난수 채우기
    const nonceBuf = crypto.randomBytes(4);
    nonceBuf.copy(payload, 6);

    const iv = crypto.randomBytes(12); // GCM 권장 12바이트 IV
    const cipher = crypto.createCipheriv("aes-256-gcm", QR_KEY, iv);

    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag(); // 16바이트

    const combined = Buffer.concat([iv, authTag, ciphertext]);
    const cipherBase64 = combined.toString("base64");

    res.json({ cipher: cipherBase64 });
  } catch (err) {
    console.error("GET /api/qr 오류:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/qr
// - body: { cipher: "<브라우저가 생성한 QR 텍스트>", studentId }
// - 복호화/검증은 하지 않고, 학생 정보 + QR 텍스트 + 서버 수신 시각만 기록
// - 최종 delta / risk / label 계산은 /generator 페이지에서 수행
app.post("/api/qr", (req, res) => {
  const { cipher, studentId } = req.body || {};

  if (!cipher || !studentId) {
    return res.status(400).json({ ok: false, error: "invalid_request" });
  }

  const serverRecvTs = Date.now();

  // 서버 로그 출력: timestamp, ip, studentId, cipher
  const logTime = new Date().toISOString();
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress;
  console.log(
    `[QR_AUTH] ts=${logTime} ip=${ip} studentId=${studentId} cipher="${cipher}"`
  );

  // 메모리 출석 로그에 추가 (생성자 페이지에서 조회용)
  ATTEND_LOG.push({
    id: ATTEND_LOG.length + 1,
    logTime,
    ip,
    studentId,
    cipher,
    serverRecvTs,
  });
  if (ATTEND_LOG.length > MAX_ATTEND_LOG) {
    ATTEND_LOG.splice(0, ATTEND_LOG.length - MAX_ATTEND_LOG);
  }

  res.json({
    ok: true,
    studentId,
    serverRecvTs,
    cipher,
  });
});

// GET /api/attend-log
// - 최근 출석 인증 시도 로그를 반환
// - 생성자(/generator) 페이지에서 학생별 delta / riskLevel 모니터링용
app.get("/api/attend-log", (req, res) => {
  res.json({
    items: ATTEND_LOG,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다. (0.0.0.0 바인딩)`);
});


