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
    
    // 900秒（15分）の再接続間隔
    this.LONG_RECONNECT_INTERVAL = 900000; // 900秒
    this.MAX_FAILED_ATTEMPTS = 3; // 連続失敗回数の上限
  }

  // バッチブロードキャスト
  scheduleBroadcast(mode, name, value) {
    // 接続が利用可能な場合のみブロードキャストを実行
    if (!this.cloudData[mode].isAvailable) {
      console.log(`📵 ${mode}は利用不可のためブロードキャストをスキップ`);
      return;
    }
    
    const key = mode;
    if (!this.messageQueue.has(key)) {
      this.messageQueue.set(key, { type: "batch_update", mode, updates: {} });
    }
    this.messageQueue.get(key).updates[name] = value;
    
    clearTimeout(this.batchTimeout);
    this.batchTimeout = setTimeout(() => this.flushBroadcasts(), 50);
  }

  flushBroadcasts() {
    for (const [mode, message] of this.messageQueue) {
      if (this.cloudData[mode].isAvailable) {
        this.broadcast(JSON.stringify(message));
      }
    }
    this.messageQueue.clear();
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
    
    for (const deadClient of deadClients) {
      this.clients.delete(deadClient);
    }
  }

  // Scratch Cloud 接続（改善版）
  async connectToScratchCloud() {
    const data = this.cloudData.scratch;
    
    if (data.connection && data.isAvailable) {
      console.log("✅ Scratch Cloud は既に接続済み");
      return true;
    }
    
    // 連続失敗回数が上限に達している場合は長い間隔で再試行
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
      data.failedAttempts = 0; // 成功時はカウンターリセット
      data.reconnectDelay = 5000; // 遅延もリセット
      
      console.log("✅ Scratch Cloud 接続成功");
      
      // 利用可能状態をクライアントに通知
      this.broadcast(JSON.stringify({
        type: "connection_status",
        mode: "scratch",
        status: "connected",
        message: "Scratch Cloud に接続しました"
      }));

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
        this.handleDisconnection("scratch");
      });

      return true;
      
    } catch (err) {
      console.error("❌ Scratch Cloud 接続失敗:", err.message);
      data.failedAttempts++;
      data.isAvailable = false;
      data.connection = null;
      
      // 失敗状態をクライアントに通知
      this.broadcast(JSON.stringify({
        type: "connection_status",
        mode: "scratch",
        status: "disconnected",
        message: `Scratch Cloud 接続失敗 (${data.failedAttempts}回目)`
      }));
      
      // 長期間隔での再接続をスケジュール
      this.scheduleReconnect("scratch");
      return false;
    }
  }

  // TurboWarp Cloud 接続（改善版）
  connectToTurboWarpCloud() {
    const data = this.cloudData.turbowarp;
    
    if (data.connection?.readyState === WebSocket.OPEN && data.isAvailable) {
      console.log("✅ TurboWarp Cloud は既に接続済み");
      return true;
    }
    
    // 連続失敗回数チェック
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
        data.reconnectDelay = 2000;
        
        console.log("✅ TurboWarp Cloud 接続成功");
        
        // 接続成功をクライアントに通知
        this.broadcast(JSON.stringify({
          type: "connection_status",
          mode: "turbowarp",
          status: "connected",
          message: "TurboWarp Cloud に接続しました"
        }));
      });

      socket.on("message", msg => {
        try {
          const msgString = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg;
          const messages = msgString.trim().split('\n').filter(Boolean);
          
          const updates = {};
          let hasUpdates = false;
          
          for (const message of messages) {
            try {
              const msgData = JSON.parse(message);
              if (msgData.method === "set") {
                data.vars[msgData.name] = msgData.value;
                updates[msgData.name] = msgData.value;
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
        console.warn("⚠️ TurboWarp 接続切断");
        this.handleDisconnection("turbowarp");
      });

      socket.on("error", err => {
        console.error("❌ TurboWarp エラー:", err.message);
        data.failedAttempts++;
        this.handleDisconnection("turbowarp");
      });
      
      return true;
      
    } catch (err) {
      console.error("❌ TurboWarp Cloud 接続失敗:", err.message);
      data.failedAttempts++;
      data.isAvailable = false;
      data.connection = null;
      
      this.broadcast(JSON.stringify({
        type: "connection_status",
        mode: "turbowarp",
        status: "disconnected",
        message: `TurboWarp Cloud 接続失敗 (${data.failedAttempts}回目)`
      }));
      
      this.scheduleReconnect("turbowarp");
      return false;
    }
  }

  // 切断処理の統一化
  handleDisconnection(mode) {
    const data = this.cloudData[mode];
    data.connection = null;
    data.isAvailable = false;
    
    // 切断をクライアントに通知
    this.broadcast(JSON.stringify({
      type: "connection_status",
      mode,
      status: "disconnected",
      message: `${mode} Cloud との接続が切断されました`
    }));
    
    this.scheduleReconnect(mode);
  }

  // 改善された再接続スケジューリング
  scheduleReconnect(mode) {
    const data = this.cloudData[mode];
    
    // 既存のタイマーをクリア
    if (data.reconnectTimer) {
      clearTimeout(data.reconnectTimer);
    }
    
    // 連続失敗回数に応じて遅延を決定
    let delay;
    if (data.failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
      delay = this.LONG_RECONNECT_INTERVAL; // 900秒
      console.log(`⏰ ${mode} 長期再接続を ${delay/1000}秒後に実行 (失敗回数: ${data.failedAttempts})`);
    } else {
      delay = Math.min(data.reconnectDelay, 30000);
      console.log(`⏰ ${mode} 短期再接続を ${delay}ms後に実行`);
    }
    
    data.reconnectTimer = setTimeout(async () => {
      try {
        let success = false;
        if (mode === "scratch") {
          success = await this.connectToScratchCloud();
        } else {
          success = this.connectToTurboWarpCloud();
        }
        
        if (!success && data.failedAttempts < this.MAX_FAILED_ATTEMPTS) {
          // 短期間隔での失敗の場合、遅延を増加
          data.reconnectDelay = Math.min(data.reconnectDelay * 1.5, 30000);
        }
      } catch (err) {
        console.error(`❌ ${mode} 再接続処理エラー:`, err.message);
        data.failedAttempts++;
      }
    }, delay);
  }

  // 利用可能なサービスのみを対象とするクラウド変数設定
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

  static responses = {
    invalidMode: JSON.stringify({ type: "error", message: "modeを'scratch'または'turbowarp'に指定してください" }),
    success: JSON.stringify({ type: "success", message: "変数設定完了" }),
    unknownType: JSON.stringify({ type: "error", message: "不明な type です" }),
    parseError: JSON.stringify({ type: "error", message: "JSON パースエラーまたは形式不正" }),
    pong: JSON.stringify({ type: "pong" }),
    serviceUnavailable: (mode) => JSON.stringify({ 
      type: "error", 
      message: `${mode} Cloud は現在利用できません` 
    })
  };

  handleConnection(ws) {
    console.log("🔌 クライアント接続");
    this.clients.add(ws);

    // 利用可能なサービスの初期データのみ送信
    for (const [mode, data] of Object.entries(this.cloudData)) {
      if (data.isAvailable) {
        ws.send(JSON.stringify({
          type: "all",
          mode,
          vars: data.vars
        }));
      }
    }
    
    // 接続状態を送信
    ws.send(JSON.stringify({
      type: "service_status",
      services: {
        scratch: this.cloudData.scratch.isAvailable,
        turbowarp: this.cloudData.turbowarp.isAvailable
      }
    }));

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
        
        // サービスが利用不可の場合の処理
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

    ws.on("error", (err) => {
      console.error("❌ WebSocket クライアントエラー:", err.message);
      this.clients.delete(ws);
    });
  }

  async start() {
    console.log("🚀 サーバー起動中...");
    
    this.wss.on("connection", ws => this.handleConnection(ws));
    
    // 両方のサービスに接続を試行（失敗しても続行）
    console.log("📡 クラウドサービスへの接続を開始...");
    
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
    
    const connectedServices = [];
    if (scratchConnected) connectedServices.push("Scratch");
    if (turbowarpConnected) connectedServices.push("TurboWarp");
    
    if (connectedServices.length > 0) {
      console.log(`✅ 接続成功: ${connectedServices.join(", ")} Cloud`);
    } else {
      console.log("⚠️ すべてのクラウドサービスへの接続に失敗しましたが、サーバーは継続します");
      console.log("📝 各サービスは900秒間隔で再接続を試行します");
    }

    console.log(`📡 WebSocketサーバーがポート ${PORT} で待機中`);
    console.log("🔌 クライアント接続を待機しています...");

    // ヘルスチェック（5分間隔） - ログのみ、クライアント通知なし
    setInterval(() => {
      const scratchStatus = this.cloudData.scratch.isAvailable ? "接続" : "切断";
      const turboStatus = this.cloudData.turbowarp.isAvailable ? "接続" : "切断";
      console.log(`💡 ヘルスチェック - Scratch: ${scratchStatus}, TurboWarp: ${turboStatus}, クライアント: ${this.clients.size}件`);
    }, 300000);

    // グレースフルシャットダウン
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  shutdown() {
    console.log("🛑 サーバーシャットダウン開始...");
    
    // 再接続タイマーをクリア
    for (const data of Object.values(this.cloudData)) {
      if (data.reconnectTimer) {
        clearTimeout(data.reconnectTimer);
      }
    }
    
    // すべてのクライアントに切断通知
    this.broadcast(JSON.stringify({ 
      type: "server_shutdown", 
      message: "サーバーがシャットダウンします" 
    }));
    
    // 接続クローズ
    this.cloudData.scratch.connection?.close();
    this.cloudData.turbowarp.connection?.close();
    this.wss.close();
    
    console.log("✅ シャットダウン完了");
    process.exit(0);
  }
}

if (require.main === module) {
  const server = new CloudManager();
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未処理のPromise拒否:', reason);
  });
  
  process.on('uncaughtException', (err) => {
    console.error('❌ 未処理の例外:', err);
    
    // 502エラーや接続エラーは致命的ではないので継続
    if (err.message && (
      err.message.includes("502") || 
      err.message.includes("Unexpected server response") ||
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("ETIMEDOUT")
    )) {
      console.warn("⚠️ 非致命的な接続エラーを検出 - サーバー継続");
      return;
    }
    
    // ポート使用エラーは致命的
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ ポート ${PORT} は既に使用されています`);
      process.exit(1);
    }
    
    // その他の致命的エラーも継続を試みる
    console.warn("⚠️ 例外を記録しましたがサーバーを継続します");
  });
  
  server.start().catch(err => {
    console.error("❌ サーバー起動失敗:", err);
    process.exit(1);
  });
}
