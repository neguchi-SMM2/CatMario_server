const WebSocket = require("ws");
const { Session, Cloud } = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ port: PORT });
let clients = [];

// Scratch用
let scratchCloud = null;
let scratchVars = {};

// TurboWarp用
let turboSocket = null;
let turboVars = {};

// Scratch接続
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
  } catch (e) {
    console.error("❌ Scratch接続失敗:", e);
    process.exit(1);
  }
}

// TurboWarp接続
function connectToTurboWarpCloud() {
  turboSocket = new WebSocket("wss://clouddata.turbowarp.org");

  turboSocket.on("open", () => {
    turboSocket.send(JSON.stringify({
      method: "handshake",
      user: "server-bot",
      project_id: PROJECT_ID
    }));
    console.log("✅ TurboWarp Cloud 接続成功");
  });

  turboSocket.on("message", msg => {
    const data = JSON.parse(msg);
    if (data.method === "set") {
      turboVars[data.name] = data.value;
      broadcast("turbowarp", { type: "update", name: data.name, value: data.value });
    }
  });

  turboSocket.on("close", () => {
    console.warn("⚠️ TurboWarp 接続切断 → 再接続");
    setTimeout(connectToTurboWarpCloud, 2000);
  });

  turboSocket.on("error", err => {
    console.error("❌ TurboWarpエラー:", err);
  });
}

// クライアントにモード別に送信
function broadcast(mode, message) {
  const msg = JSON.stringify(message);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg); // 全クライアントに送信
    }
  });
}

// モードごとのクラウド変数操作
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
    throw new Error("無効な mode またはクラウド未接続");
  }
}

// WebSocket処理
wss.on("connection", ws => {
  console.log("🔌 クライアント接続");
  clients.push(ws);

  ws.on("message", async msg => {
    try {
      const data = JSON.parse(msg);
      const mode = data.mode;

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (!["scratch", "turbowarp"].includes(mode)) {
        ws.send(JSON.stringify({ type: "error", message: "modeを指定してください（scratchまたはturbowarp）" }));
        return;
      }

      if (data.type === "set" && data.name && data.value !== undefined) {
        await setCloudVar(mode, data.name, data.value);
      } else if (data.type === "get") {
        const vars = mode === "scratch" ? scratchVars : turboVars;
        ws.send(JSON.stringify({ type: "all", mode, vars }));
      } else {
        ws.send(JSON.stringify({ type: "error", message: "不明なtypeです" }));
      }
    } catch (e) {
      console.error("⚠️ メッセージエラー:", e);
      ws.send(JSON.stringify({ type: "error", message: "メッセージ形式が無効です" }));
    }
  });

  ws.on("close", () => {
    clients = clients.filter(c => c !== ws);
    console.log("❌ クライアント切断");
  });
});

// 起動
connectToScratchCloud();
connectToTurboWarpCloud();
