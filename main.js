/* ============================================================
   キャッフィーの琵琶湖サバイバル ― 進行とカメラ
   ------------------------------------------------------------
   このファイルの担当:
     - カメラの起動と姿勢推定(MediaPipe PoseLandmarker)
     - 体の位置を「-1(左) 〜 +1(右)」に変換して game.js に渡す
     - 画面遷移(タイトル → 基準合わせ → カウントダウン → プレイ → 結果)
     - ボタン・設定・記録の管理

   湖や障害物の描画と当たり判定は game.js の担当です。
   ============================================================ */

import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* ------------------------------------------------------------
   調整用パラメータ
   ------------------------------------------------------------ */
const CONFIG = {
  MODEL_URL: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  WASM_URL: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  MAX_POSES: 3,

  POSE_INTERVAL_MS: 33,        // 姿勢推定の実行間隔（描画は毎フレーム行う）
  CALIB_SECONDS: 3,
  COUNTDOWN_SECONDS: 3,
  HANDS_HOLD_SECONDS: 0.6,     // 「両手を挙げた」と判定するまでの保持時間
  PERSON_HOLD_SECONDS: 0.4,
  DEADZONE: 0.06,              // この範囲の微動は無視する
  KEYBOARD_TAKEOVER_SECONDS: 2.5,
  KEYBOARD_SPEED: 1.6,         // キー操作のときの移動速度（1秒あたり）

  SETTINGS_KEY: "biwako_survival_settings_v1",
  RANKING_KEY: "biwako_survival_ranking_v2",
  RANKING_MAX: 5,
};

const LM = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_WRIST: 15, R_WRIST: 16 };

/* ------------------------------------------------------------
   DOM
   ------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const videoEl = $("input-video");
const overlayCanvas = $("overlay-canvas");
const overlayCtx = overlayCanvas.getContext("2d");
const statusEl = $("status");
const trackBadge = $("track-badge");

const hudEl = $("hud");
const hudScore = $("hud-score");
const hudTime = $("hud-time");
const hudDodged = $("hud-dodged");
const hudLives = $("hud-lives");

const screens = {
  title: $("overlay-title"),
  calib: $("overlay-calib"),
  countdown: $("overlay-countdown"),
  result: $("overlay-result"),
  error: $("overlay-error"),
};

const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const btnRecalib = $("btn-recalib");
const btnSound = $("btn-sound");
const btnPlay = $("btn-play");
const btnCalibCancel = $("btn-calib-cancel");
const btnRetry = $("btn-retry");
const btnBackTitle = $("btn-back-title");
const btnReload = $("btn-reload");

const calibBar = $("calib-bar");
const calibNum = $("calib-num");
const countdownNum = $("countdown-num");

const setSensitivity = $("set-sensitivity");
const setSmoothing = $("set-smoothing");
const setMirror = $("set-mirror");

/* ------------------------------------------------------------
   設定（localStorage に保存）
   ------------------------------------------------------------ */
const defaultSettings = { sensitivity: 1.5, smoothing: 7, mirror: true, difficulty: "normal" };
let settings = Object.assign({}, defaultSettings);

function loadSettings() {
  try {
    const raw = localStorage.getItem(CONFIG.SETTINGS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* 読めなくても既定値で動く */ }
}
function saveSettings() {
  try { localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* ------------------------------------------------------------
   記録（難易度ごとに保存）
   ------------------------------------------------------------ */
function loadRanking() {
  try {
    const raw = localStorage.getItem(CONFIG.RANKING_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === "object") ? obj : {};
  } catch (e) { return {}; }
}
function rankingFor(diff) {
  const all = loadRanking();
  return Array.isArray(all[diff]) ? all[diff] : [];
}
function addScore(diff, score) {
  const all = loadRanking();
  const list = Array.isArray(all[diff]) ? all[diff] : [];
  list.push(score);
  list.sort((a, b) => b - a);
  all[diff] = list.slice(0, CONFIG.RANKING_MAX);
  try { localStorage.setItem(CONFIG.RANKING_KEY, JSON.stringify(all)); } catch (e) {}
  return all[diff];
}
function bestFor(diff) {
  const list = rankingFor(diff);
  return list.length ? list[0] : 0;
}

/* ------------------------------------------------------------
   状態
   ------------------------------------------------------------ */
const S = { BOOT: "BOOT", TITLE: "TITLE", CALIB: "CALIB", COUNTDOWN: "COUNTDOWN", PLAY: "PLAY", RESULT: "RESULT", ERROR: "ERROR" };
let state = S.BOOT;
let stateTimer = 0;

let poseLandmarker = null;
let landmarks = null;
let lastDetect = 0;

let smoothedX = null;
let calib = { centerX: 0.5, shoulderWidth: 0.2 };
let calibSamplesX = [];
let calibSamplesW = [];

let personTimer = 0;
let handsTimer = 0;
let keyboardX = 0;
let keyboardActive = 0; // キー操作してからの残り猶予（秒）
let keyLeft = false, keyRight = false;

let lastHudUpdate = 0;
let lastCountdownShown = -1;

/* ------------------------------------------------------------
   画面切り替え
   ------------------------------------------------------------ */
function showScreen(name) {
  for (const key in screens) screens[key].hidden = key !== name;
  hudEl.hidden = name !== "play";
  updateButtons();
}

function updateButtons() {
  const canStart = state === S.TITLE || state === S.RESULT;
  const canStop = state === S.CALIB || state === S.COUNTDOWN || state === S.PLAY;
  btnStart.disabled = !canStart;
  btnStop.disabled = !canStop;
  btnRecalib.disabled = !(landmarks && (state === S.PLAY || state === S.COUNTDOWN));
}

function setStatus(text) { statusEl.textContent = text; }

/* ------------------------------------------------------------
   状態遷移
   ------------------------------------------------------------ */
function enterState(next) {
  state = next;
  stateTimer = 0;
  handsTimer = 0;

  if (next === S.TITLE) {
    Game.stop();
    Game.resetRun();
    refreshTitleBest();
    showScreen("title");
  } else if (next === S.CALIB) {
    calibSamplesX = [];
    calibSamplesW = [];
    calibBar.style.strokeDashoffset = "327";
    showScreen("calib");
  } else if (next === S.COUNTDOWN) {
    lastCountdownShown = -1;
    showScreen("countdown");
  } else if (next === S.PLAY) {
    Game.setDifficulty(settings.difficulty);
    Game.start();
    buildLifePips();
    showScreen("play");
  } else if (next === S.RESULT) {
    showScreen("result");
  } else if (next === S.ERROR) {
    showScreen("error");
  }
}

function showError(message) {
  state = S.ERROR;
  $("error-message").textContent = message;
  showScreen("error");
  setStatus("エラーが発生しました");
}

/* ------------------------------------------------------------
   姿勢の解析
   ------------------------------------------------------------ */
function pickMainPerson(result) {
  if (!result || !result.landmarks || result.landmarks.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const lms of result.landmarks) {
    const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
    let cx;
    if (ls && rs && (ls.visibility === undefined || (ls.visibility > 0.3 && rs.visibility > 0.3))) {
      cx = (ls.x + rs.x) / 2;
    } else if (lms[LM.NOSE]) {
      cx = lms[LM.NOSE].x;
    } else continue;
    const d = Math.abs(cx - 0.5);
    if (d < bestDist) { bestDist = d; best = lms; }
  }
  return best;
}

function extractHorizontal(lms) {
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER], nose = lms[LM.NOSE];
  let rawX = null, shoulderWidth = null;
  const ok = ls && rs && (ls.visibility === undefined || (ls.visibility > 0.3 && rs.visibility > 0.3));
  if (ok) {
    rawX = (ls.x + rs.x) / 2;
    shoulderWidth = Math.abs(rs.x - ls.x);
  } else if (nose) {
    rawX = nose.x;
  }
  if (rawX === null) return null;
  // 鏡像で表示しているので、操作感覚を鏡に合わせて左右を反転する
  return { x: settings.mirror ? 1 - rawX : rawX, shoulderWidth };
}

function areHandsRaised(lms) {
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
  const lw = lms[LM.L_WRIST], rw = lms[LM.R_WRIST];
  if (!ls || !rs || !lw || !rw) return false;
  return lw.y < ls.y - 0.02 && rw.y < rs.y - 0.02;
}

/* 体のズレ量を -1〜+1 に変換する */
function poseToNormalized() {
  if (smoothedX === null) return null;
  let rel = (smoothedX - calib.centerX) / (calib.shoulderWidth || 0.2);
  if (Math.abs(rel) < CONFIG.DEADZONE) rel = 0;
  else rel -= Math.sign(rel) * CONFIG.DEADZONE;
  // 感度が高いほど、少ない動きで画面端まで届く
  const edgeRel = 2.25 / settings.sensitivity;
  return Math.max(-1, Math.min(1, rel / edgeRel));
}

/* ------------------------------------------------------------
   カメラ小窓に骨格を描く
   ------------------------------------------------------------ */
function drawOverlay() {
  const wrap = overlayCanvas.parentElement;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (!cw || !ch) return;
  if (overlayCanvas.width !== cw || overlayCanvas.height !== ch) {
    overlayCanvas.width = cw;
    overlayCanvas.height = ch;
  }
  overlayCtx.clearRect(0, 0, cw, ch);
  if (!landmarks) return;

  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  // video は object-fit: cover なので、はみ出した分を考慮して座標を合わせる
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  const toPx = (lm) => ({ x: ox + lm.x * dw, y: oy + lm.y * dh });

  const ls = landmarks[LM.L_SHOULDER], rs = landmarks[LM.R_SHOULDER];
  const lw = landmarks[LM.L_WRIST], rw = landmarks[LM.R_WRIST];
  const nose = landmarks[LM.NOSE];

  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = "rgba(79,195,232,0.9)";
  if (ls && rs) {
    const a = toPx(ls), b = toPx(rs);
    overlayCtx.beginPath();
    overlayCtx.moveTo(a.x, a.y);
    overlayCtx.lineTo(b.x, b.y);
    overlayCtx.stroke();
    // 肩の中心（＝操作に使っている点）
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    overlayCtx.fillStyle = "#ffd07a";
    overlayCtx.beginPath();
    overlayCtx.arc(mid.x, mid.y, 4.5, 0, Math.PI * 2);
    overlayCtx.fill();
  }
  overlayCtx.fillStyle = "rgba(234,248,255,0.95)";
  for (const p of [nose, ls, rs, lw, rw]) {
    if (!p) continue;
    const q = toPx(p);
    overlayCtx.beginPath();
    overlayCtx.arc(q.x, q.y, 3, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

/* ------------------------------------------------------------
   HUD
   ------------------------------------------------------------ */
function buildLifePips() {
  const st = Game.getStats();
  hudLives.innerHTML = "";
  for (let i = 0; i < st.maxLives; i++) {
    const s = document.createElement("span");
    s.className = "pip";
    hudLives.appendChild(s);
  }
}
function updateHud() {
  const st = Game.getStats();
  hudScore.textContent = st.score;
  hudTime.textContent = st.remain;
  hudDodged.textContent = st.dodged;
  const pips = hudLives.children;
  for (let i = 0; i < pips.length; i++) {
    pips[i].classList.toggle("lost", i >= st.lives);
  }
}

/* ------------------------------------------------------------
   タイトル・結果の表示
   ------------------------------------------------------------ */
function difficultyLabel(key) {
  return (Game.DIFFICULTY[key] || Game.DIFFICULTY.normal).label;
}
function refreshTitleBest() {
  $("title-difficulty").textContent = difficultyLabel(settings.difficulty);
  $("title-best").textContent = bestFor(settings.difficulty);
}

function showResult(reason) {
  const st = Game.getStats();
  const prevBest = bestFor(settings.difficulty);
  const isRecord = st.score > prevBest;
  const top = addScore(settings.difficulty, st.score);

  const titles = {
    life: "つかまってしまった…",
    time: "サバイバル成功！",
    manual: "ストップしました",
  };
  $("result-title").textContent = titles[reason] || "サバイバル終了！";
  $("result-score").textContent = st.score;
  $("result-dodged").textContent = st.dodged;
  $("result-time").textContent = Math.floor(st.elapsed);
  $("result-difficulty").textContent = difficultyLabel(settings.difficulty);
  $("result-best").textContent = top.length ? top[0] : st.score;
  $("new-record").hidden = !isRecord;

  const list = $("ranking-list");
  list.innerHTML = "";
  let marked = false;
  top.forEach((s, i) => {
    const li = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = (i + 1) + ".";
    const val = document.createElement("span");
    val.textContent = s;
    li.appendChild(rank);
    li.appendChild(val);
    if (!marked && s === st.score) { li.classList.add("me"); marked = true; }
    list.appendChild(li);
  });

  if (reason === "time") Sound.clear();
  else if (reason === "life") Sound.gameover();
  else Sound.ambient(0.05, 1.2);
  if (isRecord) Sound.record();

  enterState(S.RESULT);
}

/* ------------------------------------------------------------
   操作（ボタン・キーボード）
   ------------------------------------------------------------ */
function requestStart() {
  Sound.unlock();
  Sound.click();
  if (state === S.TITLE || state === S.RESULT) enterState(S.CALIB);
}
function requestStop() {
  Sound.unlock();
  Sound.click();
  if (state === S.PLAY) {
    Game.stop();
    showResult("manual");
  } else if (state === S.CALIB || state === S.COUNTDOWN) {
    enterState(S.TITLE);
  }
}
/* 今立っている位置を「中央」として即座に取り直す */
function recalibrateNow() {
  if (!landmarks) return;
  const h = extractHorizontal(landmarks);
  if (!h) return;
  calib.centerX = h.x;
  if (h.shoulderWidth) calib.shoulderWidth = h.shoulderWidth;
  smoothedX = h.x;
  Sound.unlock();
  Sound.ready();
  setStatus("基準位置を合わせ直しました");
}

btnStart.addEventListener("click", requestStart);
btnPlay.addEventListener("click", requestStart);
btnRetry.addEventListener("click", requestStart);
btnStop.addEventListener("click", requestStop);
btnCalibCancel.addEventListener("click", requestStop);
btnRecalib.addEventListener("click", recalibrateNow);
btnBackTitle.addEventListener("click", () => { Sound.unlock(); Sound.click(); enterState(S.TITLE); });
btnReload.addEventListener("click", () => location.reload());

btnSound.addEventListener("click", () => {
  Sound.unlock();
  const on = Sound.setEnabled(!Sound.isEnabled());
  btnSound.textContent = on ? "♪ 音 ON" : "♪ 音 OFF";
  btnSound.setAttribute("aria-pressed", String(on));
  if (on) Sound.click();
});

/* 難易度ボタン */
document.querySelectorAll(".btn-diff").forEach((btn) => {
  btn.addEventListener("click", () => {
    Sound.unlock();
    Sound.click();
    settings.difficulty = btn.dataset.difficulty;
    saveSettings();
    document.querySelectorAll(".btn-diff").forEach((b) => b.classList.toggle("is-selected", b === btn));
    Game.setDifficulty(settings.difficulty);
    refreshTitleBest();
  });
});

/* 設定 */
function applySettingsToUI() {
  setSensitivity.value = settings.sensitivity;
  setSmoothing.value = settings.smoothing;
  setMirror.checked = settings.mirror;
  $("set-sensitivity-value").textContent = Number(settings.sensitivity).toFixed(1);
  $("set-smoothing-value").textContent = Number(settings.smoothing).toFixed(1);
  videoEl.classList.toggle("mirrored", settings.mirror);
  overlayCanvas.classList.toggle("mirrored", settings.mirror);
  document.querySelectorAll(".btn-diff").forEach((b) => {
    b.classList.toggle("is-selected", b.dataset.difficulty === settings.difficulty);
  });
}
setSensitivity.addEventListener("input", () => {
  settings.sensitivity = parseFloat(setSensitivity.value);
  $("set-sensitivity-value").textContent = settings.sensitivity.toFixed(1);
  saveSettings();
});
setSmoothing.addEventListener("input", () => {
  settings.smoothing = parseFloat(setSmoothing.value);
  $("set-smoothing-value").textContent = settings.smoothing.toFixed(1);
  saveSettings();
});
setMirror.addEventListener("change", () => {
  settings.mirror = setMirror.checked;
  videoEl.classList.toggle("mirrored", settings.mirror);
  overlayCanvas.classList.toggle("mirrored", settings.mirror);
  smoothedX = null;
  saveSettings();
});

/* キーボード（カメラが使えないときのフォールバック） */
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { keyLeft = true; keyboardActive = CONFIG.KEYBOARD_TAKEOVER_SECONDS; e.preventDefault(); }
  else if (e.key === "ArrowRight") { keyRight = true; keyboardActive = CONFIG.KEYBOARD_TAKEOVER_SECONDS; e.preventDefault(); }
  else if (e.key === " " || e.key === "Enter") {
    if (state === S.TITLE || state === S.RESULT) { requestStart(); e.preventDefault(); }
  } else if (e.key === "Escape") {
    requestStop();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") keyLeft = false;
  if (e.key === "ArrowRight") keyRight = false;
});
window.addEventListener("pointerdown", () => Sound.unlock(), { once: true });

/* ------------------------------------------------------------
   カメラと姿勢推定モデルの用意
   ------------------------------------------------------------ */
async function setupCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("このブラウザはカメラに対応していません。別のブラウザでお試しください。");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
      throw new Error("カメラの使用が許可されませんでした。アドレスバーのカメラアイコンから許可し直し、ページを再読み込みしてください。");
    }
    if (err && (err.name === "NotFoundError" || err.name === "DevicesNotFoundError")) {
      throw new Error("カメラが見つかりませんでした。カメラが接続されているか確認してください。");
    }
    throw new Error("カメラを起動できませんでした。ほかのアプリ（Zoom・Teamsなど）がカメラを使っていないか確認してください。");
  }
  videoEl.srcObject = stream;
  await videoEl.play();
  await new Promise((resolve) => {
    if (videoEl.readyState >= 2) return resolve();
    videoEl.onloadeddata = () => resolve();
  });
}

async function setupPose() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_URL);
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CONFIG.MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: CONFIG.MAX_POSES,
    });
  } catch (err) {
    throw new Error("姿勢推定モデルの読み込みに失敗しました。通信環境を確認して、ページを再読み込みしてください。");
  }
}

/* ------------------------------------------------------------
   メインループ
   ------------------------------------------------------------ */
let lastFrame = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // --- 姿勢推定（間引いて実行。描画は毎フレーム） ---
  if (poseLandmarker && videoEl.readyState >= 2 && now - lastDetect >= CONFIG.POSE_INTERVAL_MS) {
    lastDetect = now;
    try {
      landmarks = pickMainPerson(poseLandmarker.detectForVideo(videoEl, now));
    } catch (e) {
      landmarks = null;
    }
  }

  // --- 追跡状態 ---
  if (landmarks) { personTimer += dt; } else { personTimer = 0; }
  const tracked = personTimer >= CONFIG.PERSON_HOLD_SECONDS;
  trackBadge.dataset.state = tracked ? "on" : "off";
  trackBadge.textContent = tracked ? "追跡中" : "未検出";

  // --- 体の位置を平滑化（フレームレート非依存） ---
  const h = landmarks ? extractHorizontal(landmarks) : null;
  if (h) {
    if (smoothedX === null) smoothedX = h.x;
    else smoothedX += (h.x - smoothedX) * (1 - Math.exp(-settings.smoothing * dt));
  }

  // --- 両手を挙げるジェスチャー ---
  if (landmarks && areHandsRaised(landmarks)) handsTimer += dt; else handsTimer = 0;

  // --- 入力（キー操作が優先。しばらく操作がなければ体の位置に戻る） ---
  if (keyboardActive > 0) keyboardActive = Math.max(0, keyboardActive - dt);
  if (keyLeft || keyRight) {
    const dir = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    keyboardX = Math.max(-1, Math.min(1, keyboardX + dir * CONFIG.KEYBOARD_SPEED * dt));
  }
  let input = null;
  if (keyboardActive > 0) {
    input = keyboardX;
  } else {
    input = poseToNormalized();
    if (input !== null) keyboardX = input; // キー操作へ切り替わったときに飛ばない
  }
  if (input === null) {
    // 誰もいないときは、ゆっくり左右に漂わせる（待機演出）
    input = state === S.PLAY ? 0 : Math.sin(now / 1000 * 0.5) * 0.45;
  }
  Game.setInput(input);

  // --- 状態ごとの処理 ---
  stateTimer += dt;
  switch (state) {
    case S.TITLE:
      if (handsTimer >= CONFIG.HANDS_HOLD_SECONDS) enterState(S.CALIB);
      break;

    case S.CALIB: {
      const p = Math.min(1, stateTimer / CONFIG.CALIB_SECONDS);
      calibBar.style.strokeDashoffset = String(327 * (1 - p));
      const shown = Math.max(1, Math.ceil(CONFIG.CALIB_SECONDS - stateTimer));
      if (calibNum.textContent !== String(shown)) {
        calibNum.textContent = String(shown);
        Sound.beep();
      }
      if (h) {
        calibSamplesX.push(h.x);
        if (h.shoulderWidth) calibSamplesW.push(h.shoulderWidth);
      }
      if (stateTimer >= CONFIG.CALIB_SECONDS) {
        calib.centerX = calibSamplesX.length
          ? calibSamplesX.reduce((a, b) => a + b, 0) / calibSamplesX.length
          : 0.5;
        calib.shoulderWidth = calibSamplesW.length
          ? calibSamplesW.reduce((a, b) => a + b, 0) / calibSamplesW.length
          : 0.2;
        smoothedX = calib.centerX;
        Sound.ready();
        enterState(S.COUNTDOWN);
      }
      break;
    }

    case S.COUNTDOWN: {
      const remain = CONFIG.COUNTDOWN_SECONDS - stateTimer;
      const shown = remain > 0 ? Math.ceil(remain) : 0;
      if (shown !== lastCountdownShown) {
        lastCountdownShown = shown;
        countdownNum.textContent = shown > 0 ? String(shown) : "GO!";
        // アニメーションをやり直す
        countdownNum.style.animation = "none";
        void countdownNum.offsetWidth;
        countdownNum.style.animation = "";
        if (shown > 0) Sound.beep(); else Sound.go();
      }
      if (stateTimer >= CONFIG.COUNTDOWN_SECONDS + 0.35) enterState(S.PLAY);
      break;
    }

    case S.RESULT:
      if (handsTimer >= CONFIG.HANDS_HOLD_SECONDS) enterState(S.CALIB);
      break;
  }

  // --- ゲーム世界の更新と描画 ---
  Game.update(dt);
  Game.render({
    showLanes: state === S.PLAY || state === S.COUNTDOWN,
    showObstacles: state === S.PLAY,
    showCharacter: state !== S.ERROR,
  });

  drawOverlay();

  // --- HUD とステータス文言（頻繁に書き換えすぎない） ---
  if (now - lastHudUpdate > 100) {
    lastHudUpdate = now;
    if (state === S.PLAY) updateHud();
    updateButtons();
    if (state !== S.ERROR) {
      if (!tracked) setStatus("カメラの前に立ってください");
      else if (state === S.CALIB) setStatus("中央でじっとしていてください");
      else if (state === S.PLAY) setStatus("体を左右に動かしてよけよう");
      else setStatus("追跡できています");
    }
  }

  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
async function main() {
  loadSettings();
  applySettingsToUI();

  btnSound.textContent = Sound.isEnabled() ? "♪ 音 ON" : "♪ 音 OFF";
  btnSound.setAttribute("aria-pressed", String(Sound.isEnabled()));

  Game.init($("game-canvas"));
  Game.setDifficulty(settings.difficulty);
  Game.on("hit", () => Sound.hit());
  Game.on("dodge", () => Sound.dodge());
  Game.on("gameover", (e) => showResult(e.reason));

  refreshTitleBest();
  showScreen("title");

  // 湖の風景だけは、カメラの準備を待たずに動かし始める
  requestAnimationFrame(loop);

  try {
    setStatus("カメラを準備しています…");
    await setupCamera();
    setStatus("姿勢推定モデルを読み込んでいます…");
    await setupPose();
    setStatus("カメラの前に立ってください");
    enterState(S.TITLE);
  } catch (err) {
    showError(err && err.message ? err.message : "初期化中に不明なエラーが発生しました。ページを再読み込みしてください。");
  }
}

main();
