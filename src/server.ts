interface WebRTCManagerV2 {
    pc: RTCPeerConnection | null;
    chunkManager: any;
    onStatusChange: (state: string, message: string) => void;
    onProgress: (progress: number) => void;
    onStatsUpdate: (stats: any) => void;
    onConnected: () => void;
    onDisconnected: () => void;
    onFileReceived: (fileInfo: any) => void;
    sendToServer: (data: any) => void;
    init: (isHost: boolean) => void;
    createOffer: () => Promise<RTCSessionDescriptionInit>;
    handleAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>;
    addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
}

declare global {
    interface Window {
        WebRTCManagerV2: any;
    }
}

/**
 * Fast Transfer V2 サーバーマネージャー
 * 100GB対応・階層チャンク受信の実装
 */
class ServerManagerV2 {
    private ws: WebSocket | null = null;
    private roomCode: string | null = null;
    private webrtc: WebRTCManagerV2;

    // 受信統計
    private receiveStartTime: number | null = null;
    private lastProgressUpdate: number = Date.now();
    private lastBytesReceived: number = 0;

    // 受信ファイル管理
    private receiveManager: any = null;
    private receivedFile: { name: string; size: number; type: string } | null = null;

    constructor() {
        this.webrtc = new (window as any).WebRTCManagerV2();
        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    private connectToServer(): void {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('🚀 V2サーバー接続完了');
            this.createRoom();
        };

        this.ws.onmessage = (event: MessageEvent) => {
            const data = JSON.parse(event.data);
            this.handleServerMessage(data);
        };

        this.ws.onerror = (error: Event) => {
            console.error('❌ WebSocketエラー:', error);
            this.showError('サーバー接続エラー');
        };

        this.ws.onclose = () => {
            console.log('🔌 サーバー切断');
            this.updateStatus('disconnected', '❌ サーバー切断');
        };
    }

    // サーバーメッセージ処理
    private handleServerMessage(data: any): void {
        console.log('📥 V2サーバー受信:', data.type, data);

        switch (data.type) {
            case 'room-created':
                this.roomCode = data.roomCode;
                this.updateRoomCode(data.roomCode);
                this.updateStatus('waiting', '⏳ クライアントの接続を待機中...');
                console.log('🏠 ルーム作成完了:', data.roomCode);
                this.webrtc.init(true);
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
    private createRoom(): void {
        this.sendToServer({ type: 'create-room' });
    }

    // Offer作成
    private async createOffer(): Promise<void> {
        try {
            console.log('🎯 V2 Offer作成開始');
            const offer = await this.webrtc.createOffer();
            console.log('🎯 V2 Offer作成完了:', offer);
            this.sendToServer({
                type: 'offer',
                offer: offer
            });
            console.log('🎯 V2 Offer送信完了');
        } catch (error: any) {
            console.error('❌ V2 Offer作成エラー:', error);
            this.showError('接続要求エラー: ' + error.message);
        }
    }

    // Answer処理
    private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        try {
            console.log('🎯 V2 Answer受信:', answer);
            await this.webrtc.handleAnswer(answer);
            console.log('🎯 V2 Answer処理完了');
        } catch (error: any) {
            console.error('❌ V2 Answer処理エラー:', error);
            this.showError('接続応答処理エラー: ' + error.message);
        }
    }

    // ICE Candidate処理
    private async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        try {
            console.log('🧊 V2 ICE Candidate受信:', candidate);
            await this.webrtc.addIceCandidate(candidate);
            console.log('🧊 V2 ICE Candidate追加完了');
        } catch (error) {
            console.error('❌ V2 ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信
    private sendToServer(data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 V2サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ V2 WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    // ルームコード表示更新
    private updateRoomCode(code: string): void {
        const roomCodeEl = document.getElementById('roomCode') as HTMLElement;
        roomCodeEl.textContent = code;
    }

    // UIセットアップ
    private setupUI(): void {
        this.webrtc.onStatusChange = (state: string, message: string) => {
            const statusEl = document.getElementById('status') as HTMLElement;
            statusEl.innerHTML = `<span class="${state}">${message}</span>`;
        };

        this.webrtc.onProgress = (progress: number) => {
            this.updateProgress(progress);
        };

        this.webrtc.onStatsUpdate = (stats: any) => {
            this.updateDetailedStats(stats);
        };

        this.webrtc.onConnected = () => {
            console.log('✅ P2P接続確立 - ファイル受信準備完了');
        };

        this.webrtc.onDisconnected = () => {
            console.log('❌ P2P接続切断');
        };

        this.webrtc.onFileReceived = (fileInfo: any) => {
            this.handleFileReceived(fileInfo);
        };

        this.webrtc.sendToServer = (data: any) => {
            this.sendToServer(data);
        };
    }

    // 進捗更新
    private updateProgress(progress: number): void {
        const progressBar = document.getElementById('progressBar') as HTMLElement;
        const progressFill = document.getElementById('progressFill') as HTMLElement;
        const progressText = document.getElementById('progressText') as HTMLElement;

        if (progressBar) progressBar.style.display = 'block';
        if (progressFill) progressFill.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${progress.toFixed(1)}%`;

        this.calculateReceiveSpeed();
    }

    // 詳細統計更新
    private updateDetailedStats(stats: any): void {
        console.log('📊 受信側統計更新:', stats);

        const mainChunksCompleted = document.getElementById('mainChunksCompleted') as HTMLElement;
        const subChunksCompleted = document.getElementById('subChunksCompleted') as HTMLElement;
        const transferSpeed = document.getElementById('transferSpeed') as HTMLElement;
        const failedChunks = document.getElementById('failedChunks') as HTMLElement;

        if (mainChunksCompleted) {
            const mainText = `${stats.mainChunksCompleted || 0}/${stats.totalMainChunks || 0}`;
            mainChunksCompleted.textContent = mainText;
        }
        if (subChunksCompleted) {
            const subText = `${stats.chunksCompleted || 0}/${stats.totalChunks || 0}`;
            subChunksCompleted.textContent = subText;
        }
        if (transferSpeed) {
            transferSpeed.textContent = this.calculateReceiveSpeed() + ' MB/s';
        }
        if (failedChunks) {
            failedChunks.textContent = stats.failedChunks || '0';
        }
    }

    // 転送速度計算
    private calculateReceiveSpeed(): string {
        if (!this.receiveStartTime || !this.webrtc.chunkManager) return '0';

        const now = Date.now();
        const timeDiff = (now - this.lastProgressUpdate) / 1000;
        const stats = this.webrtc.chunkManager.getProgress();
        const bytesDiff = stats.bytesCompleted - this.lastBytesReceived;

        if (timeDiff > 0) {
            const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
            this.lastProgressUpdate = now;
            this.lastBytesReceived = stats.bytesCompleted;
            return speedMBps.toFixed(1);
        }

        return '0';
    }

    // ファイル受信処理
    private handleFileReceived(fileInfo: any): void {
        console.log('🎁 V2ファイル受信完了:', fileInfo);

        this.receivedFile = {
            name: fileInfo.name,
            size: fileInfo.size,
            type: fileInfo.type
        };

        this.updateStatus('completed', `✅ ${fileInfo.name} 受信完了！`);
        this.displayReceivedFile();
    }

    // 受信ファイル表示
    private displayReceivedFile(): void {
        if (!this.receivedFile) return;

        const receivedFileEl = document.getElementById('receivedFile') as HTMLElement;
        const receivedFileName = document.getElementById('receivedFileName') as HTMLElement;
        const receivedFileSize = document.getElementById('receivedFileSize') as HTMLElement;
        const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;

        if (receivedFileEl && receivedFileName && receivedFileSize) {
            receivedFileName.textContent = `📄 ${this.receivedFile.name}`;
            receivedFileSize.textContent = `📏 ${this.formatFileSize(this.receivedFile.size)}`;
            receivedFileEl.style.display = 'block';

            if (downloadBtn) {
                downloadBtn.style.display = 'inline-block';
                downloadBtn.onclick = () => this.downloadFile();
            }
        }
    }

    // ファイルダウンロード
    private downloadFile(): void {
        if (!this.receivedFile || !this.webrtc.chunkManager) return;

        const fileData = this.webrtc.chunkManager.getAssembledFile();
        if (fileData) {
            const blob = new Blob([fileData], { type: this.receivedFile.type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this.receivedFile.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('📥 V2ファイルダウンロード完了:', this.receivedFile.name);
        }
    }

    // ファイルサイズ整形
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // エラー表示
    private showError(message: string): void {
        const errorEl = document.getElementById('error') as HTMLElement;
        errorEl.textContent = message;
        errorEl.style.display = 'block';

        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }

    // ステータス更新
    private updateStatus(state: string, message: string): void {
        const statusEl = document.getElementById('status') as HTMLElement;
        statusEl.innerHTML = `<span class="${state}">${message}</span>`;
    }
}

new ServerManagerV2();

export default ServerManagerV2;