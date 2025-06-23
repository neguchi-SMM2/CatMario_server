const WebSocket = require("ws");
const CloudSession = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = process.env.SCRATCH_PROJECT_ID;

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });
let clients = [];

CloudSession(USERNAME, PASSWORD, PROJECT_ID).then(cloud => {
  console.log("✅ Scratch Cloud に接続しました");

  cloud.on("set", (name, value) => {
    console.log(`☁ ${name} = ${value}`);
    const msg = JSON.stringify({ type: "update", name, value });
    clients.forEach(ws => ws.send(msg));
  });

  wss.on("connection", (ws) => {
    console.log("🔌 クライアント接続");
    clients.push(ws);

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        console.log("📩 受信:", data);

        if (data.type === "set" && data.name && data.value !== undefined) {
          cloud.set(data.name, data.value);
        } else if (data.type === "get") {
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
