class ClientManager extends WebRTCManager {
    constructor() {
        super();
        this.ws = null;
        this.roomCode = null;
        this.selectedFiles = [];
        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    connectToServer() {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('サーバー接続完了');
            // UIではメッセージを更新せず、初期状態を維持
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

    // サーバーメッセージ処理
    handleServerMessage(data) {
        console.log('📥 サーバー受信:', data.type, data);

        switch (data.type) {
            case 'room-joined':
                this.roomCode = data.roomCode;
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('🏠 ルーム参加完了:', data.roomCode);
                this.init(false); // クライアントとしてWebRTC初期化
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
            console.log('🎯 Offer受信:', offer);
            const answer = await this.createAnswer(offer);
            console.log('🎯 Answer作成完了:', answer);
            this.sendToServer({
                type: 'answer',
                answer: answer
            });
            console.log('🎯 Answer送信完了');
        } catch (error) {
            console.error('❌ Answer作成エラー:', error);
            this.showError('接続応答エラー: ' + error.message);
        }
    }

    // ICE Candidate処理
    async handleIceCandidate(candidate) {
        try {
            console.log('🧊 ICE Candidate受信:', candidate);
            await this.addIceCandidate(candidate);
            console.log('🧊 ICE Candidate追加完了');
        } catch (error) {
            console.error('❌ ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信オーバーライド
    sendToServer(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ WebSocket未接続 - 送信失敗:', data.type);
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
        const roomCodeInput = document.getElementById('roomCode');

        const canSend = this.selectedFiles.length > 0 &&
                       this.roomCode &&
                       this.roomCode.length === 4 &&
                       this.pc &&
                       this.pc.connectionState === 'connected';

        sendBtn.disabled = !canSend;
    }

    // ファイル送信
    async sendFiles() {
        if (this.selectedFiles.length === 0) return;

        const sendBtn = document.getElementById('sendBtn');
        sendBtn.disabled = true;
        sendBtn.textContent = '📤 送信中...';

        try {
            for (const file of this.selectedFiles) {
                this.updateStatus('sending', `📤 ${file.name} を送信中...`);
                await this.sendFile(file);
            }

            this.updateStatus('completed', '✅ すべてのファイル送信完了！');
        } catch (error) {
            console.error('ファイル送信エラー:', error);
            this.showError('ファイル送信エラー: ' + error.message);
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '📤 送信開始';
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

        // WebRTCイベント
        this.onStatusChange = (state, message) => {
            const statusEl = document.getElementById('status');
            statusEl.innerHTML = `<span class="${state}">${message}</span>`;
            this.updateSendButton();

            // P2P接続確立時にファイル選択UIを表示
            if (state === 'connected') {
                document.getElementById('dropArea').style.display = 'block';
                document.getElementById('sendBtn').style.display = 'inline-block';
            }
        };

        this.onProgress = (progress) => {
            const progressBar = document.getElementById('progressBar');
            const progressFill = document.getElementById('progressFill');

            progressBar.style.display = 'block';
            progressFill.style.width = `${progress}%`;
        };

        this.onConnected = () => {
            this.updateSendButton();
        };

        this.onDisconnected = () => {
            this.updateSendButton();
        };
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
        const errorEl = document.getElementById('error');
        errorEl.textContent = message;
        errorEl.style.display = 'block';

        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }
}

// 初期化
const client = new ClientManager();