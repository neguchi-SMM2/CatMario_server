const WebSocket = require("ws");
const { Session, Cloud } = require("scratchcloud");

const USERNAME = process.env.SCRATCH_USERNAME;
const PASSWORD = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT = process.env.PORT || 3000;

class CloudManager {
  constructor() {
    this.wss = new WebSocket.Server({ port: PORT });
    this.clients = new Set();
    
    // 統合されたクラウド変数管理
    this.cloudData = {
      scratch: { connection: null, vars: {}, reconnectDelay: 5000, isReconnecting: false },
      turbowarp: { connection: null, vars: {}, reconnectDelay: 2000, isReconnecting: false }
    };
    
    this.messageQueue = new Map();
    this.batchTimeout = null;

    // 🚀 プロセスレベルのエラーハンドリング強化
    this.setupGlobalErrorHandlers();
  }

  // 🚀 グローバルエラーハンドラーを設定
  setupGlobalErrorHandlers() {
    // キャッチされていない例外をキャッチ
    process.on('uncaughtException', (err) => {
      console.error('❌ キャッチされていない例外:', err);
      console.error('Stack trace:', err.stack);
      console.log('🔄 サーバーは継続して動作します');
      
      // Scratch接続が原因の場合は再接続を試行
      if (err.message.includes('scratchcloud') || err.message.includes('callback')) {
        console.log('🔄 Scratch Cloud接続をリセットします');
        this.resetScratchConnection();
      }
    });

    // 未処理のPromise拒否をキャッチ
    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ 未処理のPromise拒否:', reason);
      console.error('Promise:', promise);
      console.log('🔄 サーバーは継続して動作します');
    });

    // 警告をキャッチ
    process.on('warning', (warning) => {
      console.warn('⚠️ Node.js警告:', warning.message);
      console.warn('Stack trace:', warning.stack);
    });
  }

  // 🚀 Scratch接続をリセット
  resetScratchConnection() {
    try {
      if (this.cloudData.scratch.connection) {
        // 既存の接続を安全に切断
        try {
          this.cloudData.scratch.connection.close();
        } catch (closeErr) {
          console.warn('⚠️ 接続クローズ時のエラー（無視します）:', closeErr.message);
        }
        this.cloudData.scratch.connection = null;
      }
      
      // 少し待ってから再接続を試行
      setTimeout(() => {
        if (!this.cloudData.scratch.isReconnecting) {
          this.connectToScratchCloud();
        }
      }, 2000);
      
    } catch (err) {
      console.error('❌ 接続リセット中のエラー:', err.message);
    }
  }

  // バッチブロードキャスト
  scheduleBroadcast(mode, name, value) {
    try {
      const key = mode;
      if (!this.messageQueue.has(key)) {
        this.messageQueue.set(key, { type: "batch_update", mode, updates: {} });
      }
      this.messageQueue.get(key).updates[name] = value;
      
      clearTimeout(this.batchTimeout);
      this.batchTimeout = setTimeout(() => this.flushBroadcasts(), 50);
    } catch (err) {
      console.error('❌ バッチブロードキャストスケジュール失敗:', err.message);
    }
  }

  flushBroadcasts() {
    try {
      for (const [mode, message] of this.messageQueue) {
        this.broadcast(JSON.stringify(message));
      }
      this.messageQueue.clear();
    } catch (err) {
      console.error('❌ バッチブロードキャスト送信失敗:', err.message);
      this.messageQueue.clear(); // メッセージキューをクリア
    }
  }

  // ブロードキャスト
  broadcast(message) {
    if (this.clients.size === 0) return;
    
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
    
    for (const deadClient of deadClients) {
      this.clients.delete(deadClient);
    }
  }

  // 🚀 Scratch Cloud 接続（エラーハンドリング大幅強化）
  async connectToScratchCloud() {
    if (this.cloudData.scratch.connection || this.cloudData.scratch.isReconnecting) {
      return;
    }

    this.cloudData.scratch.isReconnecting = true;
    
    try {
      console.log("🔄 Scratch Cloud 接続試行中...");
      
      // タイムアウト付きで接続を試行
      const session = await Promise.race([
        Session.createAsync(USERNAME, PASSWORD),
        new Promise((_, reject) => setTimeout(() => reject(new Error('接続タイムアウト')), 15000))
      ]);

      const cloud = await Promise.race([
        Cloud.createAsync(session, PROJECT_ID),
        new Promise((_, reject) => setTimeout(() => reject(new Error('クラウド接続タイムアウト')), 15000))
      ]);
      
      this.cloudData.scratch.connection = cloud;
      this.cloudData.scratch.vars = { ...cloud.vars };
      this.cloudData.scratch.reconnectDelay = 5000; // 再接続遅延をリセット
      console.log("✅ Scratch Cloud 接続成功");

      // 🚀 イベントハンドラーをtry-catchで包む
      cloud.on("set", (name, value) => {
        try {
          this.cloudData.scratch.vars[name] = value;
          this.scheduleBroadcast("scratch", name, value);
        } catch (err) {
          console.error("❌ Scratch set イベント処理失敗:", err.message);
        }
      });

      cloud.on("close", () => {
        try {
          console.warn("⚠️ Scratch Cloud 接続切断");
          this.cloudData.scratch.connection = null;
          this.scheduleReconnect("scratch");
        } catch (err) {
          console.error("❌ Scratch close イベント処理失敗:", err.message);
        }
      });

      cloud.on("error", (err) => {
        try {
          console.error("❌ Scratch Cloud エラー:", err.message);
          this.cloudData.scratch.connection = null;
          this.scheduleReconnect("scratch");
        } catch (handlerErr) {
          console.error("❌ Scratch error イベントハンドラー失敗:", handlerErr.message);
        }
      });

    } catch (err) {
      console.error("❌ Scratch Cloud 接続失敗:", err.message);
      console.log("⚠️ Scratch Cloudなしでサーバーを継続します");
      this.cloudData.scratch.connection = null;
      
      // 失敗時も再接続をスケジュール
      setTimeout(() => {
        this.scheduleReconnect("scratch");
      }, 5000);
      
    } finally {
      this.cloudData.scratch.isReconnecting = false;
    }
  }

  // TurboWarp Cloud 接続
  connectToTurboWarpCloud() {
    if (this.cloudData.turbowarp.connection?.readyState === WebSocket.OPEN || 
        this.cloudData.turbowarp.isReconnecting) {
      return;
    }

    this.cloudData.turbowarp.isReconnecting = true;
    
    try {
      const socket = new WebSocket("wss://clouddata.turbowarp.org", {
        headers: {
          "User-Agent": "CatMario_server/1.0 (https://github.com/neguchi-SMM2/CatMario_server)"
        }
      });

      socket.on("open", () => {
        try {
          socket.send(JSON.stringify({
            method: "handshake",
            user: "server-bot",
            project_id: PROJECT_ID
          }));
          console.log("✅ TurboWarp Cloud 接続成功");
          this.cloudData.turbowarp.connection = socket;
          this.cloudData.turbowarp.reconnectDelay = 2000; // 再接続遅延をリセット
          this.cloudData.turbowarp.isReconnecting = false;
        } catch (err) {
          console.error("❌ TurboWarp open イベント処理失敗:", err.message);
        }
      });

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
        try {
          console.warn("⚠️ TurboWarp 接続切断");
          this.cloudData.turbowarp.connection = null;
          this.cloudData.turbowarp.isReconnecting = false;
          this.scheduleReconnect("turbowarp");
        } catch (err) {
          console.error("❌ TurboWarp close イベント処理失敗:", err.message);
        }
      });

      socket.on("error", err => {
        try {
          console.error("❌ TurboWarp エラー:", err.message);
          this.cloudData.turbowarp.connection = null;
          this.cloudData.turbowarp.isReconnecting = false;
        } catch (handlerErr) {
          console.error("❌ TurboWarp error イベントハンドラー失敗:", handlerErr.message);
        }
      });

    } catch (err) {
      console.error("❌ TurboWarp接続作成失敗:", err.message);
      this.cloudData.turbowarp.isReconnecting = false;
    }
  }

  // 再接続スケジューリング
  scheduleReconnect(mode) {
    try {
      const data = this.cloudData[mode];
      if (data.isReconnecting) return; // 既に再接続処理中の場合はスキップ
      
      const delay = Math.min(data.reconnectDelay, 30000);
      
      console.log(`⏰ ${mode} 再接続を ${delay}ms 後に実行`);
      setTimeout(() => {
        if (mode === "scratch") {
          this.connectToScratchCloud();
        } else {
          this.connectToTurboWarpCloud();
        }
        data.reconnectDelay = Math.min(data.reconnectDelay * 1.5, 30000);
      }, delay);
    } catch (err) {
      console.error(`❌ ${mode} 再接続スケジュール失敗:`, err.message);
    }
  }

  // クラウド変数書き込み
  async setCloudVar(mode, name, value) {
    const data = this.cloudData[mode];
    const strValue = String(value);
    
    if (mode === "scratch") {
      if (!data.connection) {
        throw new Error("Scratch Cloud 未接続");
      }
      
      try {
        await data.connection.set(name, strValue);
      } catch (err) {
        // 接続エラーの場合は再接続を試行
        if (err.message.includes('callback') || err.message.includes('websocket')) {
          console.warn("⚠️ Scratch接続エラーを検出、再接続します");
          this.resetScratchConnection();
        }
        throw err;
      }
      
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

  // プリコンパイル済み応答パターン
  static responses = {
    invalidMode: JSON.stringify({ type: "error", message: "modeを'scratch'または'turbowarp'に指定してください" }),
    success: JSON.stringify({ type: "success", message: "変数設定完了" }),
    unknownType: JSON.stringify({ type: "error", message: "不明な type です" }),
    parseError: JSON.stringify({ type: "error", message: "JSON パースエラーまたは形式不正" }),
    pong: JSON.stringify({ type: "pong" })
  };

  // WebSocket クライアント処理
  handleConnection(ws) {
    try {
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
          try {
            ws.send(CloudManager.responses.parseError);
          } catch (sendErr) {
            console.error("⚠️ エラー応答送信失敗:", sendErr.message);
          }
        }
      });

      ws.on("close", () => {
        try {
          this.clients.delete(ws);
          console.log("❌ クライアント切断");
        } catch (err) {
          console.error("❌ クライアント切断処理エラー:", err.message);
        }
      });

      ws.on("error", (err) => {
        try {
          console.error("❌ WebSocket クライアントエラー:", err.message);
          this.clients.delete(ws);
        } catch (handlerErr) {
          console.error("❌ WebSocketエラーハンドラー失敗:", handlerErr.message);
        }
      });

    } catch (err) {
      console.error("❌ クライアント接続処理失敗:", err.message);
    }
  }

  // サーバー開始
  async start() {
    try {
      console.log("🚀 サーバー起動中...");
      
      this.wss.on("connection", ws => this.handleConnection(ws));
      
      // 並行接続で起動時間短縮
      await Promise.allSettled([
        this.connectToScratchCloud(),
        Promise.resolve(this.connectToTurboWarpCloud())
      ]);

      console.log(`📡 WebSocketサーバーがポート ${PORT} で待機中`);
      console.log("🔌 クライアント接続を待機しています...");

      // 定期的なヘルスチェック（5分間隔）
      setInterval(() => {
        try {
          const scratchStatus = this.cloudData.scratch.connection ? "接続" : "切断";
          const turboStatus = this.cloudData.turbowarp.connection?.readyState === WebSocket.OPEN ? "接続" : "切断";
          console.log(`💡 ヘルスチェック - Scratch: ${scratchStatus}, TurboWarp: ${turboStatus}, クライアント: ${this.clients.size}件`);
        } catch (err) {
          console.error("❌ ヘルスチェック失敗:", err.message);
        }
      }, 300000);

      // グレースフルシャットダウン
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

    } catch (err) {
      console.error("❌ サーバー起動失敗:", err);
      throw err;
    }
  }

  shutdown() {
    try {
      console.log("🛑 サーバーシャットダウン開始...");
      
      this.broadcast(JSON.stringify({ type: "server_shutdown", message: "サーバーがシャットダウンします" }));
      
      if (this.cloudData.scratch.connection) {
        try {
          this.cloudData.scratch.connection.close();
        } catch (err) {
          console.warn("⚠️ Scratch接続クローズ失敗:", err.message);
        }
      }
      
      if (this.cloudData.turbowarp.connection) {
        try {
          this.cloudData.turbowarp.connection.close();
        } catch (err) {
          console.warn("⚠️ TurboWarp接続クローズ失敗:", err.message);
        }
      }
      
      this.wss.close();
      
      console.log("✅ シャットダウン完了");
      process.exit(0);
    } catch (err) {
      console.error("❌ シャットダウン処理失敗:", err.message);
      process.exit(1);
    }
  }
}

// メイン実行部分
if (require.main === module) {
  const server = new CloudManager();
  server.start().catch(err => {
    console.error("❌ サーバー起動失敗:", err);
    // サーバー起動失敗時も即座に終了せず、再試行の機会を与える
    setTimeout(() => {
      console.log("🔄 サーバー再起動を試行します...");
      process.exit(1);
    }, 5000);
  });
}
