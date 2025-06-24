const WebSocket = require("ws");
const { Session, Cloud } = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });
let clients = [];

(async () => {
  try {
    // 1. ScratchアカウントでSessionを作成
    const session = await Session.createAsync(USERNAME, PASSWORD);

    // 2. Cloudセッションを作成
    const cloud = await Cloud.createAsync(session, PROJECT_ID);

    console.log("✅ Scratch Cloud に接続しました");

    // 仮に初期取得されるクラウド変数がある場合、全て一度キャッシュ
    cloud.vars && console.log("初期クラウド変数:", cloud.vars);

    // 3. クラウド変数更新検知
    cloud.on("set", (name, value) => {
      console.log(`☁ ${name} = ${value}`);
      const msg = JSON.stringify({ type: "update", name, value });
      clients.forEach(ws => ws.send(msg));
    });

    // WebSocketでクライアント接続受付
    wss.on("connection", ws => {
      console.log("🔌 クライアント接続");
      clients.push(ws);

      ws.on("message", async message => {
        try {
          const data = JSON.parse(message);
          console.log("📩 受信:", data);

          if (data.type === "set" && data.name && data.value !== undefined) {
            // クラウド変数に書き込む
            await cloud.set(data.name, String(data.value));
          } else if (data.type === "get") {
            // 全クラウド変数を返す
            const vars = cloud.vars; 
            ws.send(JSON.stringify({ type: "all", vars }));
          } else if (data.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch (e) {
          console.error("⚠️ 無効なメッセージ", e);
        }
      });

      ws.on("close", () => {
        console.log("❌ クライアント切断");
        clients = clients.filter(c => c !== ws);
      });
    });

  } catch (err) {
    console.error("❌ Scratchへの接続に失敗しました", err);
    process.exit(1);
  }
})();
