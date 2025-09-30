class ServerManager extends WebRTCManager {
    constructor() {
        super();
        this.ws = null;
        this.roomCode = null;
        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    connectToServer() {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('サーバー接続完了');
            this.createRoom();
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleServerMessage(data);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocketエラー:', error);
            this.showError('サーバー接続エラー');
        };

        this.ws.onclose = () => {
            console.log('サーバー切断');
            this.updateStatus('disconnected', '❌ サーバー切断');
        };
    }

    // ルーム作成
    createRoom() {
        this.ws.send(JSON.stringify({
            type: 'create-room'
        }));
    }

    // サーバーメッセージ処理
    handleServerMessage(data) {
        console.log('📥 サーバー側受信:', data.type, data);

        switch (data.type) {
            case 'room-created':
                this.roomCode = data.roomCode;
                this.displayOTP(this.roomCode);
                this.updateStatus('waiting', '🔄 クライアント接続待機中...');
                console.log('🏠 ルーム作成完了:', data.roomCode);
                this.init(true); // ホストとしてWebRTC初期化
                this.createOfferAndSend();
                break;

            case 'client-joined':
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('👤 クライアント参加通知 - Offerを再送信');
                // クライアント参加時にOfferを再送信
                setTimeout(() => {
                    this.createOfferAndSend();
                }, 100);
                break;

            case 'answer':
                this.handleAnswer(data.answer);
                break;

            case 'ice-candidate':
                this.handleIceCandidate(data.candidate);
                break;
        }
    }

    // OTP表示
    displayOTP(code) {
        const otpDisplay = document.getElementById('otpDisplay');
        otpDisplay.textContent = code;
    }

    // Offer作成・送信
    async createOfferAndSend() {
        try {
            console.log('🔥 Offer作成開始...');
            const offer = await this.createOffer();
            console.log('🔥 Offer作成完了:', offer);
            this.sendToServer({
                type: 'offer',
                offer: offer
            });
            console.log('🔥 Offer送信完了');
        } catch (error) {
            console.error('❌ Offer作成エラー:', error);
            this.showError('接続準備エラー: ' + error.message);
        }
    }

    // Answer処理
    async handleAnswer(answer) {
        try {
            await this.setRemoteDescription(answer);
        } catch (error) {
            console.error('Answer設定エラー:', error);
            this.showError('接続応答エラー');
        }
    }

    // ICE Candidate処理
    async handleIceCandidate(candidate) {
        try {
            await this.addIceCandidate(candidate);
        } catch (error) {
            console.error('ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信オーバーライド
    sendToServer(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 サーバー側送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ サーバー側WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    // ファイル受信処理
    onFileReceivedHandler(file) {
        console.log('📁 ファイル受信完了:', file.name);

        // 自動ダウンロード
        const url = URL.createObjectURL(file);
        const downloadLink = document.createElement('a');
        downloadLink.href = url;
        downloadLink.download = file.name;
        downloadLink.style.display = 'none'; // 非表示で自動実行
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);

        // ダウンロードリンクを生成（ユーザー用）
        const userDownloadLink = document.createElement('a');
        userDownloadLink.href = url;
        userDownloadLink.download = file.name;
        userDownloadLink.textContent = `✅ ${file.name} をダウンロード完了`;
        userDownloadLink.style.display = 'block';
        userDownloadLink.style.margin = '20px 0';
        userDownloadLink.style.padding = '10px 20px';
        userDownloadLink.style.background = 'linear-gradient(135deg, #51cf66 0%, #00b74a 100%)';
        userDownloadLink.style.color = 'white';
        userDownloadLink.style.textDecoration = 'none';
        userDownloadLink.style.borderRadius = '8px';

        // 既存のダウンロードリンクがあれば削除
        const existingLink = document.querySelector('a[download]');
        if (existingLink) {
            existingLink.remove();
        }

        // ダウンロードリンクを追加
        document.querySelector('.container').appendChild(userDownloadLink);

        // UI更新
        this.displayFileInfo(file.name, file.size);
        this.updateStatus('completed', `✅ ${file.name} を自動ダウンロードしました！`);
    }

    // UIセットアップ
    setupUI() {
        this.onStatusChange = (state, message) => {
            const statusEl = document.getElementById('status');
            statusEl.innerHTML = `<span class="${state}">${message}</span>`;
        };

        this.onProgress = (progress) => {
            const progressBar = document.getElementById('progressBar');
            const progressFill = document.getElementById('progressFill');

            progressBar.style.display = 'block';
            progressFill.style.width = `${progress}%`;
        };

        this.onFileReceived = (file) => {
            this.onFileReceivedHandler(file);
        };
    }

    // ファイル情報表示
    displayFileInfo(filename, filesize) {
        const fileInfo = document.getElementById('fileInfo');
        const fileName = document.getElementById('fileName');
        const fileSize = document.getElementById('fileSize');

        fileName.textContent = `📄 ${filename}`;
        fileSize.textContent = `📏 ${this.formatFileSize(filesize)}`;
        fileInfo.style.display = 'block';
    }

    // ファイルサイズ整形
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // エラー表示
    showError(message) {
        const statusEl = document.getElementById('status');
        statusEl.innerHTML = `<span class="error">❌ ${message}</span>`;
    }
}

// 初期化
const server = new ServerManager();