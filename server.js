const WebSocket = require("ws");
const { Session, Cloud } = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT = process.env.PORT || 3000;

class CloudManager {
  constructor() {
    this.wss = new WebSocket.Server({ port: PORT });
    this.clients = new Set(); // Array → Set に変更（削除が O(1)）
    
    // 統合されたクラウド変数管理
    this.cloudData = {
      scratch: { connection: null, vars: {}, reconnectDelay: 5000 },
      turbowarp: { connection: null, vars: {}, reconnectDelay: 2000 }
    };
    
    this.messageQueue = new Map(); // バッチ処理用
    this.batchTimeout = null;
  }

  // 🚀 バッチブロードキャスト（複数の変更を一度に送信）
  scheduleBroadcast(mode, name, value) {
    const key = mode;
    if (!this.messageQueue.has(key)) {
      this.messageQueue.set(key, { type: "batch_update", mode, updates: {} });
    }
    this.messageQueue.get(key).updates[name] = value;
    
    // 50ms 以内の変更をまとめて送信
    clearTimeout(this.batchTimeout);
    this.batchTimeout = setTimeout(() => this.flushBroadcasts(), 50);
  }

  flushBroadcasts() {
    for (const [mode, message] of this.messageQueue) {
      this.broadcast(JSON.stringify(message));
    }
    this.messageQueue.clear();
  }

  // 🚀 効率化されたブロードキャスト
  broadcast(message) {
    if (this.clients.size === 0) return; // 早期リターン
    
    const deadClients = new Set();
    
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          console.warn("⚠️ 送信失敗:", err.message);
          deadClients.add(ws);
        }
      } else {
        deadClients.add(ws);
      }
    }
    
    // 無効なクライアントを一括削除
    for (const deadClient of deadClients) {
      this.clients.delete(deadClient);
    }
  }

  // 🚀 Scratch Cloud 接続（エラーハンドリング改善）
  async connectToScratchCloud() {
    if (this.cloudData.scratch.connection) return; // 既に接続中の場合は何もしない
    
    try {
      console.log("🔄 Scratch Cloud 接続試行中...");
      const session = await Session.createAsync(USERNAME, PASSWORD);
      const cloud = await Cloud.createAsync(session, PROJECT_ID);
      
      this.cloudData.scratch.connection = cloud;
      this.cloudData.scratch.vars = { ...cloud.vars };
      console.log("✅ Scratch Cloud 接続成功");

      cloud.on("set", (name, value) => {
        this.cloudData.scratch.vars[name] = value;
        this.scheduleBroadcast("scratch", name, value);
      });

      // 🚀 指数バックオフによる再接続
      cloud.on("close", () => {
        console.warn("⚠️ Scratch Cloud 接続切断");
        this.cloudData.scratch.connection = null;
        this.scheduleReconnect("scratch");
      });

      cloud.on("error", (err) => {
        console.error("❌ Scratch Cloud エラー:", err.message);
        this.cloudData.scratch.connection = null;
        this.scheduleReconnect("scratch");
      });

    } catch (err) {
      console.error("❌ Scratch Cloud 接続失敗:", err.message);
      console.log("⚠️ Scratch Cloudなしでサーバーを継続します");
      this.cloudData.scratch.connection = null;
    }
  }

  // 🚀 TurboWarp Cloud 接続（メッセージ処理効率化）
  connectToTurboWarpCloud() {
    if (this.cloudData.turbowarp.connection?.readyState === WebSocket.OPEN) return;
    
    const socket = new WebSocket("wss://clouddata.turbowarp.org", {
      headers: {
        "User-Agent": "CatMario_server/1.0 (https://github.com/neguchi-SMM2/CatMario_server)"
      }
    });

    socket.on("open", () => {
      socket.send(JSON.stringify({
        method: "handshake",
        user: "server-bot",
        project_id: PROJECT_ID
      }));
      console.log("✅ TurboWarp Cloud 接続成功");
      this.cloudData.turbowarp.connection = socket;
    });

    // 🚀 効率化されたメッセージ処理
    socket.on("message", msg => {
      try {
        const msgString = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg;
        const messages = msgString.trim().split('\n').filter(Boolean);
        
        const updates = {};
        let hasUpdates = false;
        
        for (const message of messages) {
          try {
            const data = JSON.parse(message);
            if (data.method === "set") {
              this.cloudData.turbowarp.vars[data.name] = data.value;
              updates[data.name] = data.value;
              hasUpdates = true;
            }
          } catch (parseErr) {
            console.error("⚠️ JSON解析失敗:", parseErr.message);
          }
        }
        
        // 複数の更新を一度にブロードキャスト
        if (hasUpdates) {
          this.broadcast(JSON.stringify({
            type: "batch_update",
            mode: "turbowarp",
            updates
          }));
        }
        
      } catch (err) {
        console.error("⚠️ TurboWarp メッセージ処理失敗:", err.message);
      }
    });

    socket.on("close", () => {
      console.warn("⚠️ TurboWarp 接続切断");
      this.cloudData.turbowarp.connection = null;
      this.scheduleReconnect("turbowarp");
    });

    socket.on("error", err => {
      console.error("❌ TurboWarp エラー:", err.message);
      this.cloudData.turbowarp.connection = null;
    });
  }

  // 🚀 指数バックオフによる再接続スケジューリング
  scheduleReconnect(mode) {
    const data = this.cloudData[mode];
    const delay = Math.min(data.reconnectDelay, 30000); // 最大30秒
    
    console.log(`⏰ ${mode} 再接続を ${delay}ms 後に実行`);
    setTimeout(() => {
      try {
        if (mode === "scratch") {
          this.connectToScratchCloud().catch(err => {
            console.warn(`⚠️ ${mode} 再接続失敗:`, err.message);
          });
        } else {
          this.connectToTurboWarpCloud();
        }
        // 再接続遅延を増加（指数バックオフ）
        data.reconnectDelay = Math.min(data.reconnectDelay * 1.5, 30000);
      } catch (err) {
        console.error(`❌ ${mode} 再接続処理エラー:`, err.message);
      }
    }, delay);
  }

  // 🚀 効率化されたクラウド変数書き込み
  async setCloudVar(mode, name, value) {
    const data = this.cloudData[mode];
    const strValue = String(value);
    
    if (mode === "scratch") {
      if (!data.connection) {
        throw new Error("Scratch Cloud 未接続");
      }
      await data.connection.set(name, strValue);
    } else if (mode === "turbowarp") {
      const socket = data.connection;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("TurboWarp Cloud 未接続");
      }
      socket.send(JSON.stringify({
        method: "set",
        name,
        value: strValue,
        user: "server-bot",
        project_id: PROJECT_ID
      }));
    } else {
      throw new Error(`無効なmode: ${mode}`);
    }
  }

  // 🚀 プリコンパイル済み応答パターン
  static responses = {
    invalidMode: JSON.stringify({ type: "error", message: "modeを'scratch'または'turbowarp'に指定してください" }),
    success: JSON.stringify({ type: "success", message: "変数設定完了" }),
    unknownType: JSON.stringify({ type: "error", message: "不明な type です" }),
    parseError: JSON.stringify({ type: "error", message: "JSON パースエラーまたは形式不正" }),
    pong: JSON.stringify({ type: "pong" })
  };

  // WebSocket クライアント処理
  handleConnection(ws) {
    console.log("🔌 クライアント接続");
    this.clients.add(ws);

    // 初期データ送信
    const initData = {
      scratch: { type: "all", mode: "scratch", vars: this.cloudData.scratch.vars },
      turbowarp: { type: "all", mode: "turbowarp", vars: this.cloudData.turbowarp.vars }
    };
    
    ws.send(JSON.stringify(initData.scratch));
    ws.send(JSON.stringify(initData.turbowarp));

    ws.on("message", async msg => {
      try {
        const data = JSON.parse(msg);
        
        // 🚀 ping処理を最優先
        if (data.type === "ping") {
          ws.send(CloudManager.responses.pong);
          return;
        }

        const { mode, type, name, value } = data;

        if (!["scratch", "turbowarp"].includes(mode)) {
          ws.send(CloudManager.responses.invalidMode);
          return;
        }

        switch (type) {
          case "set":
            if (name && value !== undefined) {
              try {
                await this.setCloudVar(mode, name, value);
                ws.send(CloudManager.responses.success);
              } catch (err) {
                ws.send(JSON.stringify({ 
                  type: "error", 
                  message: `変数設定失敗: ${err.message}` 
                }));
              }
            } else {
              ws.send(JSON.stringify({ 
                type: "error", 
                message: "name と value は必須です" 
              }));
            }
            break;

          case "get":
            ws.send(JSON.stringify({ 
              type: "all", 
              mode, 
              vars: this.cloudData[mode].vars 
            }));
            break;

          default:
            ws.send(CloudManager.responses.unknownType);
        }
      } catch (err) {
        console.error("⚠️ メッセージ処理エラー:", err);
        ws.send(CloudManager.responses.parseError);
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      console.log("❌ クライアント切断");
    });

    // 🚀 エラーハンドリング追加
    ws.on("error", (err) => {
      console.error("❌ WebSocket クライアントエラー:", err.message);
      this.clients.delete(ws);
    });
  }

  // サーバー開始
  async start() {
    console.log("🚀 サーバー起動中...");
    
    this.wss.on("connection", ws => this.handleConnection(ws));
    
    // 並行接続で起動時間短縮
    await Promise.allSettled([
      this.connectToScratchCloud(),
      Promise.resolve(this.connectToTurboWarpCloud())
    ]);

    console.log(`📡 WebSocketサーバーがポート ${PORT} で待機中`);
    console.log("🔌 クライアント接続を待機しています...");

    // 🚀 定期的なヘルスチェック（5分間隔）
    setInterval(() => {
      const scratchStatus = this.cloudData.scratch.connection ? "接続" : "切断";
      const turboStatus = this.cloudData.turbowarp.connection?.readyState === WebSocket.OPEN ? "接続" : "切断";
      console.log(`💡 ヘルスチェック - Scratch: ${scratchStatus}, TurboWarp: ${turboStatus}, クライアント: ${this.clients.size}件`);
    }, 300000);

    // 🚀 グレースフルシャットダウン
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  shutdown() {
    console.log("🛑 サーバーシャットダウン開始...");
    
    // すべてのクライアントに切断通知
    this.broadcast(JSON.stringify({ type: "server_shutdown", message: "サーバーがシャットダウンします" }));
    
    // 接続クローズ
    this.cloudData.scratch.connection?.close();
    this.cloudData.turbowarp.connection?.close();
    this.wss.close();
    
    console.log("✅ シャットダウン完了");
    process.exit(0);
  }
}

// 🚀 メイン実行部分をシンプル化
if (require.main === module) {
  const server = new CloudManager();
  
  // 🔧 修正：未処理のエラーをキャッチ
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未処理のPromise拒否:', reason);
    // サーバーは継続する（クラッシュしない）
  });
  
  process.on('uncaughtException', (err) => {
    console.error('❌ 未処理の例外:', err);
    // 重大なエラーの場合のみ終了
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ ポート ${PORT} は既に使用されています`);
      process.exit(1);
    }
  });
  
  server.start().catch(err => {
    console.error("❌ サーバー起動失敗:", err);
    process.exit(1);
  });
}
