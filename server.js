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
    
    this.cloudData = {
      scratch: { 
        connection: null, 
        vars: {}, 
        reconnectDelay: 5000,
        isAvailable: false,
        lastAttempt: 0,
        failedAttempts: 0,
        reconnectTimer: null
      },
      turbowarp: { 
        connection: null, 
        vars: {}, 
        reconnectDelay: 2000,
        isAvailable: false,
        lastAttempt: 0,
        failedAttempts: 0,
        reconnectTimer: null
      }
    };
    
    this.messageQueue = new Map();
    this.batchTimeout = null;
    
    this.LONG_RECONNECT_INTERVAL = 900000; // 15分
    this.MAX_FAILED_ATTEMPTS = 3;
    this.BATCH_DELAY = 50; // バッチ処理の遅延
  }

  scheduleBroadcast(mode, name, value) {
    if (!this.cloudData[mode].isAvailable) {
      console.log(`📵 ${mode}は利用不可のためブロードキャストをスキップ`);
      return;
    }
    
    const key = mode;
    if (!this.messageQueue.has(key)) {
      this.messageQueue.set(key, { type: "batch_update", mode, updates: {} });
    }
    this.messageQueue.get(key).updates[name] = value;
    
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }
    this.batchTimeout = setTimeout(() => this.flushBroadcasts(), this.BATCH_DELAY);
  }

  flushBroadcasts() {
    for (const [mode, message] of this.messageQueue) {
      if (this.cloudData[mode].isAvailable) {
        this.broadcast(JSON.stringify(message));
      }
    }
    this.messageQueue.clear();
    this.batchTimeout = null;
  }

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
    
    // デッドクライアントを削除
    for (const deadClient of deadClients) {
      this.clients.delete(deadClient);
    }
  }

  // エラータイプの判定
  isNetworkError(error) {
    const message = error.message || '';
    return message.includes("502") || 
           message.includes("Unexpected server response: 502") ||
           message.includes("ECONNRESET") ||
           message.includes("ENOTFOUND") ||
           message.includes("ETIMEDOUT");
  }

  // サービス切断処理
  forceDisconnectService(mode, reason = "強制切断") {
    const data = this.cloudData[mode];
    
    if (data.connection) {
      try {
        if (mode === "scratch") {
          data.connection.close();
        } else if (mode === "turbowarp" && data.connection.readyState === WebSocket.OPEN) {
          data.connection.terminate();
        }
      } catch (err) {
        console.warn(`⚠️ ${mode} 接続切断時エラー:`, err.message);
      }
    }
    
    data.connection = null;
    data.isAvailable = false;
    
    console.log(`🔌 ${mode} ${reason}`);
    this.broadcast(JSON.stringify({
      type: "connection_status",
      mode,
      status: "disconnected",
      message: `${mode} Cloud が${reason}されました`,
      timestamp: new Date().toISOString()
    }));
  }

  async connectToScratchCloud() {
    const data = this.cloudData.scratch;
    
    // 既に接続済みの場合
    if (data.connection && data.isAvailable) {
      console.log("✅ Scratch Cloud は既に接続済み");
      return true;
    }

    // 連続失敗による長期待機中の場合
    if (data.failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
      const timeSinceLastAttempt = Date.now() - data.lastAttempt;
      if (timeSinceLastAttempt < this.LONG_RECONNECT_INTERVAL) {
        const remainingTime = Math.ceil((this.LONG_RECONNECT_INTERVAL - timeSinceLastAttempt) / 1000);
        console.log(`⏳ Scratch Cloud 再接続まで ${remainingTime}秒待機中... (連続失敗: ${data.failedAttempts}回)`);
        return false;
      }
    }

    try {
      console.log("🔄 Scratch Cloud 接続試行中...");
      data.lastAttempt = Date.now();
      
      const session = await Session.createAsync(USERNAME, PASSWORD);
      const cloud = await Cloud.createAsync(session, PROJECT_ID);
      
      data.connection = cloud;
      data.vars = { ...cloud.vars };
      data.isAvailable = true;
      data.failedAttempts = 0;
      data.reconnectDelay = 5000; // 初期値にリセット
      
      console.log("✅ Scratch Cloud 接続成功");
      this.broadcast(JSON.stringify({
        type: "connection_status",
        mode: "scratch",
        status: "connected",
        message: "Scratch Cloud に接続しました",
        timestamp: new Date().toISOString()
      }));

      // イベントハンドラー設定
      cloud.on("set", (name, value) => {
        data.vars[name] = value;
        this.scheduleBroadcast("scratch", name, value);
      });

      cloud.on("close", () => {
        console.warn("⚠️ Scratch Cloud 接続切断");
        this.handleDisconnection("scratch");
      });

      cloud.on("error", (err) => {
        console.error("❌ Scratch Cloud エラー:", err.message);
        this.handleError("scratch", err);
      });

      return true;

    } catch (err) {
      console.error("❌ Scratch Cloud 接続失敗:", err.message);
      this.handleError("scratch", err);
      return false;
    }
  }

  connectToTurboWarpCloud() {
    const data = this.cloudData.turbowarp;
    
    // 既に接続済みの場合
    if (data.connection?.readyState === WebSocket.OPEN && data.isAvailable) {
      console.log("✅ TurboWarp Cloud は既に接続済み");
      return true;
    }

    // 連続失敗による長期待機中の場合
    if (data.failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
      const timeSinceLastAttempt = Date.now() - data.lastAttempt;
      if (timeSinceLastAttempt < this.LONG_RECONNECT_INTERVAL) {
        const remainingTime = Math.ceil((this.LONG_RECONNECT_INTERVAL - timeSinceLastAttempt) / 1000);
        console.log(`⏳ TurboWarp Cloud 再接続まで ${remainingTime}秒待機中... (連続失敗: ${data.failedAttempts}回)`);
        return false;
      }
    }

    try {
      console.log("🔄 TurboWarp Cloud 接続試行中...");
      data.lastAttempt = Date.now();
      
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
        
        data.connection = socket;
        data.isAvailable = true;
        data.failedAttempts = 0;
        data.reconnectDelay = 2000; // 初期値にリセット
        
        console.log("✅ TurboWarp Cloud 接続成功");
        this.broadcast(JSON.stringify({
          type: "connection_status",
          mode: "turbowarp",
          status: "connected",
          message: "TurboWarp Cloud に接続しました",
          timestamp: new Date().toISOString()
        }));
      });

      socket.on("message", msg => {
        this.handleTurboWarpMessage(msg);
      });

      socket.on("close", (code, reason) => {
        console.warn(`⚠️ TurboWarp 接続切断 (code: ${code}, reason: ${reason})`);
        this.handleDisconnection("turbowarp");
      });

      socket.on("error", err => {
        console.error("❌ TurboWarp エラー:", err.message);
        this.handleError("turbowarp", err);
      });

      return true;

    } catch (err) {
      console.error("❌ TurboWarp Cloud 接続失敗:", err.message);
      this.handleError("turbowarp", err);
      return false;
    }
  }

  handleTurboWarpMessage(msg) {
    try {
      const msgString = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg;
      const messages = msgString.trim().split('\n').filter(Boolean);
      const updates = {};
      let hasUpdates = false;

      for (const message of messages) {
        try {
          const msgData = JSON.parse(message);
          if (msgData.method === "set") {
            this.cloudData.turbowarp.vars[msgData.name] = msgData.value;
            updates[msgData.name] = msgData.value;
            hasUpdates = true;
          }
        } catch (parseErr) {
          console.warn("⚠️ JSON解析失敗:", parseErr.message);
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
  }

  // エラー処理の統一
  handleError(mode, error) {
    const data = this.cloudData[mode];

    if (this.isNetworkError(error)) {
      console.warn(`⚠️ ネットワークエラー検出 - ${mode}を切断し、長期再接続モードへ`);
      this.forceDisconnectService(mode, "ネットワークエラーにより切断");
      data.failedAttempts = this.MAX_FAILED_ATTEMPTS;
      data.lastAttempt = Date.now();
      this.scheduleLongTermReconnect(mode);
    } else {
      data.failedAttempts++;
      data.isAvailable = false;
      data.connection = null;
      
      this.broadcast(JSON.stringify({
        type: "connection_status",
        mode,
        status: "disconnected",
        message: `${mode} Cloud 接続失敗 (${data.failedAttempts}回目)`,
        timestamp: new Date().toISOString()
      }));

      this.scheduleReconnect(mode);
    }
  }

  // 長期再接続スケジューラー
  scheduleLongTermReconnect(mode) {
    const data = this.cloudData[mode];
    
    if (data.reconnectTimer) {
      clearTimeout(data.reconnectTimer);
      data.reconnectTimer = null;
    }
    
    console.log(`⏰ ${mode} 長期再接続を${this.LONG_RECONNECT_INTERVAL / 1000}秒後に実行`);
    
    data.reconnectTimer = setTimeout(async () => {
      data.reconnectTimer = null;
      console.log(`🔄 ${mode} 長期再接続を開始...`);
      
      try {
        let success = false;
        if (mode === "scratch") {
          success = await this.connectToScratchCloud();
        } else {
          success = this.connectToTurboWarpCloud();
        }
        
        if (!success) {
          console.log(`❌ ${mode} 再接続失敗 - 次回は${this.LONG_RECONNECT_INTERVAL / 1000}秒後`);
          this.scheduleLongTermReconnect(mode);
        } else {
          console.log(`✅ ${mode} 再接続成功`);
        }
      } catch (err) {
        console.error(`❌ ${mode} 再接続処理エラー:`, err.message);
        this.handleError(mode, err);
      }
    }, this.LONG_RECONNECT_INTERVAL);
  }

  handleDisconnection(mode) {
    const data = this.cloudData[mode];
    data.connection = null;
    data.isAvailable = false;
    
    this.broadcast(JSON.stringify({
      type: "connection_status",
      mode,
      status: "disconnected",
      message: `${mode} Cloud との接続が切断されました`,
      timestamp: new Date().toISOString()
    }));
    
    this.scheduleReconnect(mode);
  }

  scheduleReconnect(mode) {
    const data = this.cloudData[mode];
    
    if (data.reconnectTimer) {
      clearTimeout(data.reconnectTimer);
    }

    let delay;
    if (data.failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
      delay = this.LONG_RECONNECT_INTERVAL;
      console.log(`⏰ ${mode} 長期再接続を ${delay/1000}秒後に実行 (失敗回数: ${data.failedAttempts})`);
    } else {
      delay = Math.min(data.reconnectDelay, 30000);
      console.log(`⏰ ${mode} 短期再接続を ${delay}ms後に実行`);
    }

    data.reconnectTimer = setTimeout(async () => {
      data.reconnectTimer = null;
      
      try {
        let success = false;
        if (mode === "scratch") {
          success = await this.connectToScratchCloud();
        } else {
          success = this.connectToTurboWarpCloud();
        }
        
        if (!success && data.failedAttempts < this.MAX_FAILED_ATTEMPTS) {
          data.reconnectDelay = Math.min(data.reconnectDelay * 1.5, 30000);
        }
      } catch (err) {
        console.error(`❌ ${mode} 再接続処理エラー:`, err.message);
        this.handleError(mode, err);
      }
    }, delay);
  }

  async setCloudVar(mode, name, value) {
    const data = this.cloudData[mode];
    const strValue = String(value);
    
    if (!data.isAvailable || !data.connection) {
      throw new Error(`${mode} Cloud は利用できません`);
    }

    if (mode === "scratch") {
      await data.connection.set(name, strValue);
    } else if (mode === "turbowarp") {
      const socket = data.connection;
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("TurboWarp Cloud 接続が無効です");
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

  // レスポンステンプレート
  static responses = {
    invalidMode: JSON.stringify({ 
      type: "error", 
      message: "modeを'scratch'または'turbowarp'に指定してください" 
    }),
    success: JSON.stringify({ 
      type: "success", 
      message: "変数設定完了" 
    }),
    unknownType: JSON.stringify({ 
      type: "error", 
      message: "不明な type です" 
    }),
    parseError: JSON.stringify({ 
      type: "error", 
      message: "JSON パースエラーまたは形式不正" 
    }),
    pong: JSON.stringify({ 
      type: "pong",
      timestamp: new Date().toISOString()
    }),
    serviceUnavailable: (mode) => JSON.stringify({ 
      type: "error", 
      message: `${mode} Cloud は現在利用できません`,
      timestamp: new Date().toISOString()
    })
  };

  handleConnection(ws) {
    console.log("🔌 クライアント接続");
    this.clients.add(ws);

    // 現在のクラウド変数状態を送信
    for (const [mode, data] of Object.entries(this.cloudData)) {
      if (data.isAvailable) {
        ws.send(JSON.stringify({
          type: "all",
          mode,
          vars: data.vars,
          timestamp: new Date().toISOString()
        }));
      }
    }

    // サービス状態を送信
    ws.send(JSON.stringify({
      type: "service_status",
      services: {
        scratch: this.cloudData.scratch.isAvailable,
        turbowarp: this.cloudData.turbowarp.isAvailable
      },
      timestamp: new Date().toISOString()
    }));

    ws.on("message", async msg => {
      try {
        const data = JSON.parse(msg);

        // Ping処理
        if (data.type === "ping") {
          ws.send(CloudManager.responses.pong);
          return;
        }

        const { mode, type, name, value } = data;

        // Mode検証
        if (!["scratch", "turbowarp"].includes(mode)) {
          ws.send(CloudManager.responses.invalidMode);
          return;
        }

        // サービス可用性チェック
        if (!this.cloudData[mode].isAvailable) {
          ws.send(CloudManager.responses.serviceUnavailable(mode));
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
                  message: `変数設定失敗: ${err.message}`,
                  timestamp: new Date().toISOString()
                }));
              }
            } else {
              ws.send(JSON.stringify({ 
                type: "error", 
                message: "name と value は必須です",
                timestamp: new Date().toISOString()
              }));
            }
            break;

          case "get":
            ws.send(JSON.stringify({ 
              type: "all", 
              mode, 
              vars: this.cloudData[mode].vars,
              timestamp: new Date().toISOString()
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

    ws.on("close", (code, reason) => {
      this.clients.delete(ws);
      console.log(`❌ クライアント切断 (code: ${code}, reason: ${reason})`);
    });

    ws.on("error", (err) => {
      console.error("❌ WebSocket クライアントエラー:", err.message);
      this.clients.delete(ws);
    });
  }

  async start() {
    console.log("🚀 サーバー起動中...");

    // WebSocketサーバー設定
    this.wss.on("connection", ws => this.handleConnection(ws));

    console.log("📡 クラウドサービスへの接続を開始...");

    // 両サービスへの並列接続試行
    const scratchPromise = this.connectToScratchCloud().catch(err => {
      console.warn("⚠️ Scratch Cloud 初期接続失敗:", err.message);
      return false;
    });

    const turbowarpPromise = Promise.resolve().then(() => {
      try {
        return this.connectToTurboWarpCloud();
      } catch (err) {
        console.warn("⚠️ TurboWarp Cloud 初期接続失敗:", err.message);
        return false;
      }
    });

    const [scratchConnected, turbowarpConnected] = await Promise.all([
      scratchPromise,
      turbowarpPromise
    ]);

    // 接続結果の報告
    const connectedServices = [];
    if (scratchConnected) connectedServices.push("Scratch");
    if (turbowarpConnected) connectedServices.push("TurboWarp");

    if (connectedServices.length > 0) {
      console.log(`✅ 接続成功: ${connectedServices.join(", ")} Cloud`);
    } else {
      console.log("⚠️ すべてのクラウドサービスへの接続に失敗しましたが、サーバーは継続します");
      console.log(`📝 各サービスは${this.LONG_RECONNECT_INTERVAL / 1000}秒間隔で再接続を試行します`);
    }

    console.log(`📡 WebSocketサーバーがポート ${PORT} で待機中`);
    console.log("🔌 クライアント接続を待機しています...");

    // ヘルスチェック（5分間隔）
    setInterval(() => {
      const scratchStatus = this.cloudData.scratch.isAvailable ? "接続" : "切断";
      const turboStatus = this.cloudData.turbowarp.isAvailable ? "接続" : "切断";
      console.log(`💡 ヘルスチェック - Scratch: ${scratchStatus}, TurboWarp: ${turboStatus}, クライアント: ${this.clients.size}件`);
    }, 300000);

    // グレースフルシャットダウン設定
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  shutdown() {
    console.log("🛑 サーバーシャットダウン開始...");

    // タイマーのクリーンアップ
    for (const data of Object.values(this.cloudData)) {
      if (data.reconnectTimer) {
        clearTimeout(data.reconnectTimer);
        data.reconnectTimer = null;
      }
    }

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    // クライアントにシャットダウン通知
    this.broadcast(JSON.stringify({ 
      type: "server_shutdown", 
      message: "サーバーがシャットダウンします",
      timestamp: new Date().toISOString()
    }));

    // 接続クローズ
    this.cloudData.scratch.connection?.close();
    this.cloudData.turbowarp.connection?.close();
    this.wss.close();

    console.log("✅ シャットダウン完了");
    process.exit(0);
  }
}

// サーバー起動処理
if (require.main === module) {
  const server = new CloudManager();

  // エラーハンドリング
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未処理のPromise拒否:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('❌ 未処理の例外:', err);

    // ポート使用エラー
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ ポート ${PORT} は既に使用されています`);
      process.exit(1);
    }

    // ネットワークエラーの場合は個別処理
    if (err.message && (
      err.message.includes("502") || 
      err.message.includes("Unexpected server response") ||
      err.message.includes("ECONNRESET") ||
      err.message.includes("ETIMEDOUT")
    )) {
      console.warn("⚠️ ネットワークエラー検出 - 問題のあるサービスを長期再接続モードに移行");
      
      // 各サービスの状態をチェックして問題があるものを処理
      for (const [mode, data] of Object.entries(server.cloudData)) {
        if (data.connection && data.isAvailable) {
          try {
            // 接続状態の簡易チェック
            if ((mode === "scratch" && !data.connection) || 
                (mode === "turbowarp" && data.connection.readyState !== WebSocket.OPEN)) {
              server.handleError(mode, err);
            }
          } catch (checkErr) {
            // チェック中にエラーが出た場合もネットワークエラーとして処理
            server.handleError(mode, err);
          }
        }
      }
      return;
    }

    console.warn("⚠️ 例外を記録しましたがサーバーを継続します");
  });

  // サーバー起動
  server.start().catch(err => {
    console.error("❌ サーバー起動失敗:", err);
    process.exit(1);
  });
}
