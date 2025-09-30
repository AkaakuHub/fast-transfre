/**
 * Fast Transfer V2 サーバーマネージャー
 * 100GB対応・階層チャンク受信の実装
 */
class ServerManagerV2 {
    constructor() {
        this.ws = null;
        this.roomCode = null;
        this.webrtc = new WebRTCManagerV2();

        // 受信統計
        this.receiveStartTime = null;
        this.lastProgressUpdate = Date.now();
        this.lastBytesReceived = 0;

        // 受信ファイル管理
        this.receiveManager = null;
        this.receivedFile = null;

        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    connectToServer() {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('🚀 V2サーバー接続完了');
            this.createRoom();
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleServerMessage(data);
        };

        this.ws.onerror = (error) => {
            console.error('❌ WebSocketエラー:', error);
            this.showError('サーバー接続エラー');
        };

        this.ws.onclose = () => {
            console.log('🔌 サーバー切断');
            this.updateStatus('disconnected', '❌ サーバー切断');
        };
    }

    // サーバーメッセージ処理
    handleServerMessage(data) {
        console.log('📥 V2サーバー受信:', data.type, data);

        switch (data.type) {
            case 'room-created':
                this.roomCode = data.roomCode;
                this.updateRoomCode(data.roomCode);
                this.updateStatus('waiting', '⏳ クライアントの接続を待機中...');
                console.log('🏠 ルーム作成完了:', data.roomCode);
                this.webrtc.init(true); // ホストとしてWebRTC V2初期化
                break;

            case 'client-joined':
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('👤 クライアント参加');
                this.createOffer();
                break;

            case 'answer':
                this.handleAnswer(data.answer);
                break;

            case 'ice-candidate':
                this.handleIceCandidate(data.candidate);
                break;

            case 'error':
                console.error('❌ サーバーエラー:', data.message);
                this.showError(data.message);
                break;
        }
    }

    // ルーム作成
    createRoom() {
        this.sendToServer({ type: 'create-room' });
    }

    // Offer作成
    async createOffer() {
        try {
            console.log('🎯 V2 Offer作成開始');
            const offer = await this.webrtc.createOffer();
            console.log('🎯 V2 Offer作成完了:', offer);
            this.sendToServer({
                type: 'offer',
                offer: offer
            });
            console.log('🎯 V2 Offer送信完了');
        } catch (error) {
            console.error('❌ V2 Offer作成エラー:', error);
            this.showError('接続開始エラー: ' + error.message);
        }
    }

    // Answer処理
    async handleAnswer(answer) {
        try {
            console.log('🎯 V2 Answer受信:', answer);
            await this.webrtc.setRemoteDescription(answer);
            console.log('🎯 V2 Answer設定完了');
        } catch (error) {
            console.error('❌ V2 Answer設定エラー:', error);
            this.showError('接続応答エラー: ' + error.message);
        }
    }

    // ICE Candidate処理
    async handleIceCandidate(candidate) {
        try {
            console.log('🧊 V2 ICE Candidate受信:', candidate);
            await this.webrtc.addIceCandidate(candidate);
            console.log('🧊 V2 ICE Candidate追加完了');
        } catch (error) {
            console.error('❌ V2 ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信
    sendToServer(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 V2サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ V2 WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    // ルームコード表示更新
    updateRoomCode(code) {
        const roomCodeEl = document.getElementById('roomCode');
        roomCodeEl.textContent = code;
    }

    // UIセットアップ
    setupUI() {
        // コピーボタン
        const copyBtn = document.getElementById('copyBtn');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(this.roomCode).then(() => {
                copyBtn.textContent = '✅ コピーしました！';
                setTimeout(() => {
                    copyBtn.textContent = '📋 コードをコピー';
                }, 2000);
            });
        });

        // ダウンロードボタン
        const downloadBtn = document.getElementById('downloadBtn');
        downloadBtn.addEventListener('click', () => {
            this.downloadFile();
        });

        // WebRTCイベント
        this.webrtc.onStatusChange = (state, message) => {
            this.updateStatus(state, message);
        };

        this.webrtc.onProgress = (progress) => {
            this.updateProgress(progress);
        };

        this.webrtc.onStatsUpdate = (stats) => {
            this.updateDetailedStats(stats);
        };

        this.webrtc.onFileReceived = (fileData) => {
            this.handleFileReceived(fileData);
        };

        // サーバー送信メソッド設定
        this.webrtc.sendToServer = (data) => {
            this.sendToServer(data);
        };
    }

    // 進捗更新
    updateProgress(progress) {
        const progressBar = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        if (progressBar) {
            progressBar.style.display = 'block';
        }
        if (progressFill) {
            progressFill.style.width = `${progress}%`;
        }
        if (progressText) {
            progressText.textContent = `${progress.toFixed(1)}%`;
        }

        // 受信速度計算
        this.calculateReceiveSpeed();
    }

    // 詳細統計更新
    updateDetailedStats(stats) {
        const mainChunksCompleted = document.getElementById('mainChunksCompleted');
        const subChunksCompleted = document.getElementById('subChunksCompleted');
        const receiveSpeed = document.getElementById('receiveSpeed');
        const failedChunks = document.getElementById('failedChunks');

        if (mainChunksCompleted) {
            mainChunksCompleted.textContent = `${stats.mainChunksCompleted}/${stats.totalMainChunks}`;
        }
        if (subChunksCompleted) {
            subChunksCompleted.textContent = `${stats.chunksCompleted}/${stats.totalChunks}`;
        }
        if (receiveSpeed) {
            receiveSpeed.textContent = this.calculateReceiveSpeed() + ' MB/s';
        }
        if (failedChunks) {
            failedChunks.textContent = stats.failedChunks;
        }
    }

    // 受信速度計算
    calculateReceiveSpeed() {
        if (!this.receiveStartTime || !this.webrtc.receiveManager) return 0;

        const now = Date.now();
        const timeDiff = (now - this.lastProgressUpdate) / 1000; // 秒
        const bytesDiff = this.webrtc.receiveManager.totalReceived - this.lastBytesReceived;

        if (timeDiff > 0) {
            const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
            this.lastProgressUpdate = now;
            this.lastBytesReceived = this.webrtc.receiveManager.totalReceived;
            return speedMBps.toFixed(1);
        }

        return 0;
    }

    // ファイル受信完了処理
    handleFileReceived(fileData) {
        console.log('✅ ファイル受信完了:', fileData.name);
        this.receivedFile = fileData;

        const fileInfo = document.getElementById('fileInfo');
        const fileName = document.getElementById('fileName');
        const fileSize = document.getElementById('fileSize');
        const downloadSection = document.getElementById('downloadSection');

        fileName.textContent = `📄 ${fileData.name}`;
        fileSize.textContent = `📏 ${this.formatFileSize(fileData.size)}`;
        fileInfo.style.display = 'block';
        downloadSection.style.display = 'block';

        this.updateStatus('completed', '✅ ファイル受信完了！ダウンロード可能です');
    }

    // ファイルダウンロード
    downloadFile() {
        if (!this.receivedFile) return;

        const blob = new Blob([this.receivedFile.data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.receivedFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('💾 ファイルダウンロード完了:', this.receivedFile.name);
    }

    // ファイルサイズ整形
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // エラー表示
    showError(message) {
        const errorEl = document.getElementById('error');
        errorEl.textContent = message;
        errorEl.style.display = 'block';

        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }

    // ステータス更新
    updateStatus(state, message) {
        const statusEl = document.getElementById('status');
        statusEl.innerHTML = `<span class="${state}">${message}</span>`;
    }
}

// 初期化
const serverV2 = new ServerManagerV2();