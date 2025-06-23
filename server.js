const WebSocket = require("ws");
const CloudSession = require("scratchcloud");

// Scratchアカウント情報（Render環境変数から取得）
const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = process.env.SCRATCH_PROJECT_ID;

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });
let clients = [];

// Scratch Cloud接続
CloudSession.create(USERNAME, PASSWORD, PROJECT_ID).then(cloud => {
  console.log("✅ Scratch Cloud に接続しました");

  // Scratch クラウド変数の変更検知
  cloud.on("set", (name, value) => {
    console.log(`☁ ${name} = ${value}`);
    const msg = JSON.stringify({ type: "update", name, value });
    clients.forEach(ws => ws.send(msg));
  });

  // WebSocket クライアント接続処理
  wss.on("connection", (ws) => {
    console.log("🔌 クライアント接続");
    clients.push(ws);

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        console.log("📩 受信:", data);

        // クライアントから: クラウド変数を書き換え
        if (data.type === "set" && data.name && data.value !== undefined) {
          cloud.set(data.name, data.value);
        }
        // クラウド変数の一覧送信要求
        else if (data.type === "get") {
          const vars = cloud.getAll();
          ws.send(JSON.stringify({ type: "all", vars }));
        }
      } catch (e) {
        console.error("⚠️ 無効なメッセージ", e);
      }
    });

    ws.on("close", () => {
      console.log("❌ クライアント切断");
      clients = clients.filter(client => client !== ws);
    });
  });

}).catch(err => {
  console.error("❌ Scratchログインに失敗", err);
});
