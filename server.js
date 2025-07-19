const WebSocket = require("ws");
const { Session, Cloud } = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ port: PORT });
let clients = [];

// Scratch 用クラウド変数管理
let scratchCloud = null;
let scratchVars = {};

// TurboWarp 用クラウド変数管理
let turboSocket = null;
let turboVars = {};

// Scratch Cloud に接続
async function connectToScratchCloud() {
  try {
    const session = await Session.createAsync(USERNAME, PASSWORD);
    scratchCloud = await Cloud.createAsync(session, PROJECT_ID);
    scratchVars = { ...scratchCloud.vars };
    console.log("✅ Scratch Cloud 接続成功");

    scratchCloud.on("set", (name, value) => {
      scratchVars[name] = value;
      broadcast("scratch", { type: "update", name, value });
    });
  } catch (err) {
    console.error("❌ Scratch Cloud 接続失敗:", err);
    process.exit(1);
  }
}

// TurboWarp Cloud に接続
function connectToTurboWarpCloud() {
  turboSocket = new WebSocket("wss://clouddata.turbowarp.org", {
    headers: {
      "User-Agent": "CatMario_server/1.0 (https://github.com/neguchi-SMM2/CatMario_server)"
    }
  });

  turboSocket.on("open", () => {
    turboSocket.send(JSON.stringify({
      method: "handshake",
      user: "server-bot",
      project_id: PROJECT_ID
    }));
    console.log("✅ TurboWarp Cloud 接続成功");
  });

  turboSocket.on("message", msg => {
    try {
      // Bufferを文字列に変換
      let msgString;
      if (Buffer.isBuffer(msg)) {
        msgString = msg.toString('utf8');
      } else {
        msgString = msg;
      }
      
      // 複数のJSONメッセージが連結されている場合を処理
      // 改行で分割して各JSONを個別に処理
      const messages = msgString.trim().split('\n').filter(line => line.trim());
      
      messages.forEach(message => {
        try {
          const data = JSON.parse(message);
          if (data.method === "set") {
            turboVars[data.name] = data.value;
            broadcast("turbowarp", { type: "update", name: data.name, value: data.value });
          }
        } catch (parseErr) {
          // 単一のJSONメッセージ解析失敗
          console.error("⚠️ 個別JSON解析失敗:", parseErr.message);
          console.log("問題のあるメッセージ:", message);
        }
      });
      
    } catch (err) {
      console.error("⚠️ TurboWarp メッセージ処理失敗:", err);
      // デバッグ用：実際のメッセージ内容を表示
      if (Buffer.isBuffer(msg)) {
        console.log("Buffer内容:", msg.toString('utf8'));
      } else {
        console.log("メッセージ内容:", msg);
      }
    }
  });

  turboSocket.on("close", () => {
    console.warn("⚠️ TurboWarp 接続切断 → 再接続");
    setTimeout(connectToTurboWarpCloud, 2000);
  });

  turboSocket.on("error", err => {
    console.error("❌ TurboWarp エラー:", err);
  });
}

// クライアント全体に通知
function broadcast(mode, message) {
  const msg = JSON.stringify(message);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg); // 全クライアントに送信（必要に応じて mode フィルタ可能）
    }
  });
}

// クラウド変数の書き込み
async function setCloudVar(mode, name, value) {
  if (mode === "scratch" && scratchCloud) {
    await scratchCloud.set(name, String(value));
  } else if (mode === "turbowarp" && turboSocket?.readyState === WebSocket.OPEN) {
    turboSocket.send(JSON.stringify({
      method: "set",
      name,
      value: String(value),
      user: "server-bot",
      project_id: PROJECT_ID
    }));
  } else {
    throw new Error("無効な mode またはクラウド接続エラー");
  }
}

// WebSocket 接続処理
wss.on("connection", ws => {
  console.log("🔌 クライアント接続");
  clients.push(ws);

  // ✅ 初期クラウド変数送信
  ws.send(JSON.stringify({ type: "all", mode: "scratch", vars: scratchVars }));
  ws.send(JSON.stringify({ type: "all", mode: "turbowarp", vars: turboVars }));

  ws.on("message", async msg => {
    try {
      const data = JSON.parse(msg);
      const mode = data.mode;

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (!["scratch", "turbowarp"].includes(mode)) {
        ws.send(JSON.stringify({ type: "error", message: "modeを'scratch'または'turbowarp'に指定してください" }));
        return;
      }

      if (data.type === "set" && data.name && data.value !== undefined) {
        await setCloudVar(mode, data.name, data.value);
      } else if (data.type === "get") {
        const vars = mode === "scratch" ? scratchVars : turboVars;
        ws.send(JSON.stringify({ type: "all", mode, vars }));
      } else {
        ws.send(JSON.stringify({ type: "error", message: "不明な type です" }));
      }
    } catch (err) {
      console.error("⚠️ メッセージ処理エラー:", err);
      ws.send(JSON.stringify({ type: "error", message: "JSON パースエラーまたは形式不正" }));
    }
  });

  ws.on("close", () => {
    clients = clients.filter(c => c !== ws);
    console.log("❌ クライアント切断");
  });
});

// サーバー起動
connectToScratchCloud();
connectToTurboWarpCloud();
