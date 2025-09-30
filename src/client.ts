export {};

interface FileStats {
  mainChunksCompleted?: number;
  totalMainChunks?: number;
  chunksCompleted?: number;
  totalChunks?: number;
  failedChunks?: number;
  bytesCompleted?: number;
}

interface WebRTCManagerV2 {
  maxConcurrentSends: number;
  BUFFER_THRESHOLD: number;
  adaptiveChunkSize: number;
  pc: RTCPeerConnection | null;
  chunkManager: any;
  onStatusChange: (state: string, message: string) => void;
  onProgress: (progress: number) => void;
  onStatsUpdate: (stats: FileStats) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  sendToServer: (data: any) => void;
  init: (isHost: boolean) => void;
  createAnswer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>;
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  sendFile: (file: File) => Promise<void>;
}

declare global {
  interface Window {
    WebRTCManagerV2: any;
  }
}

/**
 * Fast Transfer V2 クライアントマネージャー
 * 100GB対応・階層チャンク転送の実装
 */
class ClientManagerV2 {
    private ws: WebSocket | null = null;
    private roomCode: string | null = null;
    private selectedFiles: File[] = [];
    private webrtc: WebRTCManagerV2;

    // 転送統計
    private transferStartTime: number | null = null;
    private lastProgressUpdate: number = Date.now();
    private lastBytesTransferred: number = 0;

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
            case 'room-joined':
                this.roomCode = data.roomCode;
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('🏠 ルーム参加完了:', data.roomCode);
                this.webrtc.init(false);
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

    private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
        try {
            console.log('🎯 V2 Offer受信:', offer);
            const answer = await this.webrtc.createAnswer(offer);
            console.log('🎯 V2 Answer作成完了:', answer);
            this.sendToServer({
                type: 'answer',
                answer: answer
            });
            console.log('🎯 V2 Answer送信完了');
        } catch (error: any) {
            console.error('❌ V2 Answer作成エラー:', error);
            this.showError('接続応答エラー: ' + error.message);
        }
    }

    private async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        try {
            console.log('🧊 V2 ICE Candidate受信:', candidate);
            await this.webrtc.addIceCandidate(candidate);
            console.log('🧊 V2 ICE Candidate追加完了');
        } catch (error) {
            console.error('❌ V2 ICE Candidate追加エラー:', error);
        }
    }

    private sendToServer(data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 V2サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ V2 WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    private joinRoom(): void {
        const roomCodeInput = document.getElementById('roomCode') as HTMLInputElement;
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

    private selectFiles(files: FileList): void {
        this.selectedFiles = Array.from(files);
        this.displaySelectedFiles();
        this.updateSendButton();
    }

    private displaySelectedFiles(): void {
        const selectedFile = document.getElementById('selectedFile') as HTMLElement;
        const fileName = document.getElementById('fileName') as HTMLElement;
        const fileSize = document.getElementById('fileSize') as HTMLElement;

        if (this.selectedFiles.length > 0) {
            const file = this.selectedFiles[0];
            fileName.textContent = `📄 ${file.name}`;
            fileSize.textContent = `📏 ${this.formatFileSize(file.size)}`;
            selectedFile.style.display = 'block';
        } else {
            selectedFile.style.display = 'none';
        }
    }

    private updateSendButton(): void {
        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
        const canSend = this.selectedFiles.length > 0 &&
                       this.roomCode &&
                       this.roomCode.length === 4 &&
                       this.webrtc.pc &&
                       this.webrtc.pc.connectionState === 'connected';
        sendBtn.disabled = !canSend;
    }

    private async sendFiles(): Promise<void> {
        if (this.selectedFiles.length === 0) return;

        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
        const progressContainer = document.getElementById('progressContainer') as HTMLElement;

        sendBtn.disabled = true;
        sendBtn.textContent = '🚀 V2送信中...';
        progressContainer.style.display = 'block';

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
        } catch (error: any) {
            console.error('ファイル送信エラー:', error);
            this.showError('V2ファイル送信エラー: ' + error.message);
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 高速送信開始';
        }
    }

    private applySettings(): void {
        const concurrentSends = document.getElementById('concurrentSends') as HTMLInputElement;
        const bufferThreshold = document.getElementById('bufferThreshold') as HTMLInputElement;
        const chunkSizeKB = document.getElementById('chunkSizeKB') as HTMLInputElement;

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

    private setupUI(): void {
        const roomCodeInput = document.getElementById('roomCode') as HTMLInputElement;
        roomCodeInput.addEventListener('input', () => {
            if (roomCodeInput.value.length === 4) {
                this.joinRoom();
            }
        });

        const fileInput = document.getElementById('fileInput') as HTMLInputElement;
        const selectFileBtn = document.getElementById('selectFileBtn') as HTMLButtonElement;
        const dropArea = document.getElementById('dropArea') as HTMLElement;
        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;

        selectFileBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.files) this.selectFiles(target.files);
        });

        dropArea.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            dropArea.classList.add('drag-over');
        });

        dropArea.addEventListener('dragleave', () => {
            dropArea.classList.remove('drag-over');
        });

        dropArea.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            dropArea.classList.remove('drag-over');
            if (e.dataTransfer?.files) this.selectFiles(e.dataTransfer.files);
        });

        sendBtn.addEventListener('click', () => this.sendFiles());

        const advancedToggle = document.getElementById('advancedToggle') as HTMLButtonElement;
        const advancedSettings = document.getElementById('advancedSettings') as HTMLElement;

        advancedToggle.addEventListener('click', () => {
            if (advancedSettings.style.display === 'none' || !advancedSettings.style.display) {
                advancedSettings.style.display = 'block';
                advancedToggle.textContent = '⚙️ 設定を隠す';
            } else {
                advancedSettings.style.display = 'none';
                advancedToggle.textContent = '⚙️ 詳細設定';
            }
        });

        this.webrtc.onStatusChange = (state: string, message: string) => {
            const statusEl = document.getElementById('status') as HTMLElement;
            statusEl.innerHTML = `<span class="${state}">${message}</span>`;
            this.updateSendButton();

            if (state === 'connected') {
                document.getElementById('dropArea')!.style.display = 'block';
                document.getElementById('sendBtn')!.style.display = 'inline-block';
            }
        };

        this.webrtc.onProgress = (progress: number) => this.updateProgress(progress);
        this.webrtc.onStatsUpdate = (stats: FileStats) => this.updateDetailedStats(stats);
        this.webrtc.onConnected = () => this.updateSendButton();
        this.webrtc.onDisconnected = () => this.updateSendButton();
        this.webrtc.sendToServer = (data: any) => this.sendToServer(data);
    }

    private updateProgress(progress: number): void {
        const progressBar = document.getElementById('progressBar') as HTMLElement;
        const progressFill = document.getElementById('progressFill') as HTMLElement;
        const progressText = document.getElementById('progressText') as HTMLElement;

        if (progressBar) progressBar.style.display = 'block';
        if (progressFill) progressFill.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${progress.toFixed(1)}%`;

        this.calculateTransferSpeed();
    }

    private updateDetailedStats(stats: FileStats): void {
        console.log('📊 送信側統計更新:', stats);

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
            transferSpeed.textContent = this.calculateTransferSpeed() + ' MB/s';
        }
        if (failedChunks) {
            failedChunks.textContent = stats.failedChunks?.toString() || '0';
        }
    }

    private calculateTransferSpeed(): string {
        if (!this.transferStartTime || !this.webrtc.chunkManager) return '0';

        const now = Date.now();
        const timeDiff = (now - this.lastProgressUpdate) / 1000;
        const stats = this.webrtc.chunkManager.getProgress();
        const bytesDiff = stats.bytesCompleted - this.lastBytesTransferred;

        if (timeDiff > 0) {
            const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
            this.lastProgressUpdate = now;
            this.lastBytesTransferred = stats.bytesCompleted;
            return speedMBps.toFixed(1);
        }

        return '0';
    }

    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    private showError(message: string): void {
        const errorEl = document.getElementById('error') as HTMLElement;
        errorEl.textContent = message;
        errorEl.style.display = 'block';

        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }

    private updateStatus(state: string, message: string): void {
        const statusEl = document.getElementById('status') as HTMLElement;
        statusEl.innerHTML = `<span class="${state}">${message}</span>`;
    }
}

new ClientManagerV2();