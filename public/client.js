/**
 * Fast Transfer V2 クライアントマネージャー
 * 100GB対応・階層チャンク転送の実装
 */
class ClientManagerV2 {
    constructor() {
        this.ws = null;
        this.roomCode = null;
        this.selectedFiles = [];
        this.webrtc = new WebRTCManagerV2();

        // 転送統計
        this.transferStartTime = null;
        this.lastProgressUpdate = Date.now();
        this.lastBytesTransferred = 0;

        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    connectToServer() {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('🚀 V2サーバー接続完了');
            // UIには表示せず初期状態を維持
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
            case 'room-joined':
                this.roomCode = data.roomCode;
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('🏠 ルーム参加完了:', data.roomCode);
                this.webrtc.init(false); // クライアントとしてWebRTC V2初期化
                break;

            case 'offer':
                this.handleOffer(data.offer);
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

    // Offer処理
    async handleOffer(offer) {
        try {
            console.log('🎯 V2 Offer受信:', offer);
            const answer = await this.webrtc.createAnswer(offer);
            console.log('🎯 V2 Answer作成完了:', answer);
            this.sendToServer({
                type: 'answer',
                answer: answer
            });
            console.log('🎯 V2 Answer送信完了');
        } catch (error) {
            console.error('❌ V2 Answer作成エラー:', error);
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

    // サーバー送信オーバーライド
    sendToServer(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 V2サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ V2 WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    // ルーム参加
    joinRoom() {
        const roomCodeInput = document.getElementById('roomCode');
        const code = roomCodeInput.value.trim();

        if (code.length !== 4) {
            this.showError('4桁のルームコードを入力してください');
            return;
        }

        this.roomCode = code;
        this.sendToServer({
            type: 'join-room',
            roomCode: code
        });

        this.updateStatus('connecting', '🔄 ルーム参加中...');
    }

    // ファイル選択
    selectFiles(files) {
        this.selectedFiles = Array.from(files);
        this.displaySelectedFiles();
        this.updateSendButton();
    }

    // 選択ファイル表示
    displaySelectedFiles() {
        const selectedFile = document.getElementById('selectedFile');
        const fileName = document.getElementById('fileName');
        const fileSize = document.getElementById('fileSize');

        if (this.selectedFiles.length > 0) {
            const file = this.selectedFiles[0];
            fileName.textContent = `📄 ${file.name}`;
            fileSize.textContent = `📏 ${this.formatFileSize(file.size)}`;
            selectedFile.style.display = 'block';
        } else {
            selectedFile.style.display = 'none';
        }
    }

    // 送信ボタン状態更新
    updateSendButton() {
        const sendBtn = document.getElementById('sendBtn');

        const canSend = this.selectedFiles.length > 0 &&
                       this.roomCode &&
                       this.roomCode.length === 4 &&
                       this.webrtc.pc &&
                       this.webrtc.pc.connectionState === 'connected';

        sendBtn.disabled = !canSend;
    }

    // ファイル送信（V2）
    async sendFiles() {
        if (this.selectedFiles.length === 0) return;

        const sendBtn = document.getElementById('sendBtn');
        const progressContainer = document.getElementById('progressContainer');

        sendBtn.disabled = true;
        sendBtn.textContent = '🚀 V2送信中...';
        progressContainer.style.display = 'block';

        // 設定値を適用
        this.applySettings();

        try {
            for (const file of this.selectedFiles) {
                this.transferStartTime = Date.now();
                this.lastBytesTransferred = 0;
                this.lastProgressUpdate = Date.now();

                this.updateStatus('sending', `🚀 ${file.name} をV2転送中...`);

                await this.webrtc.sendFile(file);

                this.updateStatus('completed', `✅ ${file.name} V2転送完了！`);
            }
        } catch (error) {
            console.error('ファイル送信エラー:', error);
            this.showError('V2ファイル送信エラー: ' + error.message);
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 高速送信開始';
        }
    }

    // 設定値を適用
    applySettings() {
        const concurrentSends = document.getElementById('concurrentSends');
        const bufferThreshold = document.getElementById('bufferThreshold');
        const chunkSizeKB = document.getElementById('chunkSizeKB');

        if (concurrentSends) {
            this.webrtc.maxConcurrentSends = parseInt(concurrentSends.value);
        }
        if (bufferThreshold) {
            this.webrtc.BUFFER_THRESHOLD = parseInt(bufferThreshold.value) * 1024 * 1024;
        }
        if (chunkSizeKB) {
            this.webrtc.adaptiveChunkSize = parseInt(chunkSizeKB.value) * 1024;
        }
    }

    // UIセットアップ
    setupUI() {
        // ルームコード入力
        const roomCodeInput = document.getElementById('roomCode');
        roomCodeInput.addEventListener('input', () => {
            if (roomCodeInput.value.length === 4) {
                this.joinRoom();
            }
        });

        // ファイル選択
        const fileInput = document.getElementById('fileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const dropArea = document.getElementById('dropArea');
        const sendBtn = document.getElementById('sendBtn');

        selectFileBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            this.selectFiles(e.target.files);
        });

        // ドラッグ&ドロップ
        dropArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropArea.classList.add('drag-over');
        });

        dropArea.addEventListener('dragleave', () => {
            dropArea.classList.remove('drag-over');
        });

        dropArea.addEventListener('drop', (e) => {
            e.preventDefault();
            dropArea.classList.remove('drag-over');
            this.selectFiles(e.dataTransfer.files);
        });

        // 送信ボタン
        sendBtn.addEventListener('click', () => {
            this.sendFiles();
        });

        // 詳細設定トグル
        const advancedToggle = document.getElementById('advancedToggle');
        const advancedSettings = document.getElementById('advancedSettings');

        advancedToggle.addEventListener('click', () => {
            if (advancedSettings.style.display === 'none' || !advancedSettings.style.display) {
                advancedSettings.style.display = 'block';
                advancedToggle.textContent = '⚙️ 設定を隠す';
            } else {
                advancedSettings.style.display = 'none';
                advancedToggle.textContent = '⚙️ 詳細設定';
            }
        });

        // WebRTCイベント
        this.webrtc.onStatusChange = (state, message) => {
            const statusEl = document.getElementById('status');
            statusEl.innerHTML = `<span class="${state}">${message}</span>`;
            this.updateSendButton();

            // P2P接続確立時にファイル選択UIを表示
            if (state === 'connected') {
                document.getElementById('dropArea').style.display = 'block';
                document.getElementById('sendBtn').style.display = 'inline-block';
            }
        };

        this.webrtc.onProgress = (progress) => {
            this.updateProgress(progress);
        };

        this.webrtc.onStatsUpdate = (stats) => {
            this.updateDetailedStats(stats);
        };

        this.webrtc.onConnected = () => {
            this.updateSendButton();
        };

        this.webrtc.onDisconnected = () => {
            this.updateSendButton();
        };

        // サーバー送信メソッド設定
        this.webrtc.sendToServer = (data) => {
            this.sendToServer(data);
        };
    }

    // 進捗更新
    updateProgress(progress) {
        const progressBar = document.getElementById('progressBar');
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

        // 転送速度計算
        this.calculateTransferSpeed();
    }

    // 詳細統計更新
    updateDetailedStats(stats) {
        console.log('📊 送信側統計更新:', stats);

        const mainChunksCompleted = document.getElementById('mainChunksCompleted');
        const subChunksCompleted = document.getElementById('subChunksCompleted');
        const transferSpeed = document.getElementById('transferSpeed');
        const failedChunks = document.getElementById('failedChunks');

        if (mainChunksCompleted) {
            const mainText = `${stats.mainChunksCompleted || 0}/${stats.totalMainChunks || 0}`;
            mainChunksCompleted.textContent = mainText;
        }
        if (subChunksCompleted) {
            const subText = `${stats.chunksCompleted || 0}/${stats.totalChunks || 0}`;
            subChunksCompleted.textContent = subText;
        }
        if (transferSpeed) {
            transferSpeed.textContent = this.calculateTransferSpeed() + ' MB/s';
        }
        if (failedChunks) {
            failedChunks.textContent = stats.failedChunks;
        }
    }

    // 転送速度計算
    calculateTransferSpeed() {
        if (!this.transferStartTime || !this.webrtc.chunkManager) return 0;

        const now = Date.now();
        const timeDiff = (now - this.lastProgressUpdate) / 1000; // 秒
        const stats = this.webrtc.chunkManager.getProgress();
        const bytesDiff = stats.bytesCompleted - this.lastBytesTransferred;

        if (timeDiff > 0) {
            const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
            this.lastProgressUpdate = now;
            this.lastBytesTransferred = stats.bytesCompleted;
            return speedMBps.toFixed(1);
        }

        return 0;
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
const clientV2 = new ClientManagerV2();