
/**
 * Fast Transfer V2 サーバーマネージャー
 * 100GB対応・階層チャンク受信の実装
 */

import type { FileInfo, TransferStats, ControlMessage } from './types.js';

declare global {
    interface WebRTCManagerV2 {
        pc: RTCPeerConnection | null;
        dataChannel: RTCDataChannel | null;
        receiveManager: {
            filename: string;
            filesize: number;
            totalMainChunks: number;
            totalSubChunks: number;
            completedChunks: Set<string>;
            receivedChunks: Map<string, ArrayBuffer>;
            totalReceived: number;
        } | null;
        maxConcurrentSends: number;
        BUFFER_THRESHOLD: number;
        adaptiveChunkSize: number;

        onStatusChange: ((state: string, message: string) => void) | null;
        onProgress: ((progress: number) => void) | null;
        onStatsUpdate: ((stats: TransferStats) => void) | null;
        onFileReceived: ((fileInfo: FileInfo) => void) | null;
        sendToServer: ((data: ControlMessage | { type: string; candidate: RTCIceCandidate }) => void) | null;

        init(isHost: boolean): void;
        createOffer(): Promise<RTCSessionDescriptionInit>;
        createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
        sendFile(file: File): Promise<void>;
    }

    var WebRTCManagerV2: {
        new(): WebRTCManagerV2;
    };
}
class ServerManagerV2 {
    private ws: WebSocket | null = null;
    private roomCode: string | null = null;
    private webrtc: WebRTCManagerV2;

    // 受信統計
    private receiveStartTime: number | null = null;
    private lastProgressUpdate: number = Date.now();
    private lastBytesReceived: number = 0;

    // 受信ファイル管理
    private receiveManager: {
        filename: string;
        filesize: number;
        totalMainChunks: number;
        totalSubChunks: number;
        completedChunks: Set<string>;
        receivedChunks: Map<string, ArrayBuffer>;
        totalReceived: number;
    } | null = null;
    private receivedFile: FileInfo | null = null;

    constructor() {
        this.webrtc = new WebRTCManagerV2();
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
    private handleServerMessage(data: {
        type: 'room-created' | 'client-joined' | 'answer' | 'ice-candidate' | 'error';
        roomCode?: string;
        clientId?: number;
        answer?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
        message?: string;
    }): void {
        console.log('📥 V2サーバー受信:', data.type, data);

        switch (data.type) {
            case 'room-created':
                this.roomCode = data.roomCode || null;
                if (data.roomCode) {
                    this.updateRoomCode(data.roomCode);
                }
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
                if (data.answer) {
                    this.handleAnswer(data.answer);
                }
                break;

            case 'ice-candidate':
                if (data.candidate) {
                    this.handleIceCandidate(data.candidate);
                }
                break;

            case 'error':
                if (data.message) {
                    console.error('❌ サーバーエラー:', data.message);
                    this.showError(data.message);
                }
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
        } catch (error: unknown) {
            console.error('❌ V2 Offer作成エラー:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.showError('接続開始エラー: ' + errorMessage);
        }
    }

    // Answer処理
    private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        try {
            console.log('🎯 V2 Answer受信:', answer);
            await this.webrtc.setRemoteDescription(answer);
            console.log('🎯 V2 Answer設定完了');
        } catch (error: unknown) {
            console.error('❌ V2 Answer設定エラー:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.showError('接続応答エラー: ' + errorMessage);
        }
    }

    // ICE Candidate処理
    private async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        try {
            console.log('🧊 V2 ICE Candidate受信:', candidate);
            await this.webrtc.addIceCandidate(candidate);
            console.log('🧊 V2 ICE Candidate追加完了');
        } catch (error: unknown) {
            console.error('❌ V2 ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信
    private sendToServer(data: {
        type: 'create-room' | 'offer' | 'answer' | 'ice-candidate';
        roomCode?: string;
        offer?: RTCSessionDescriptionInit;
        answer?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
    }): void {
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
        // コピーボタン
        const copyBtn = document.getElementById('copyBtn') as HTMLElement;
        copyBtn.addEventListener('click', () => {
            if (this.roomCode) {
                navigator.clipboard.writeText(this.roomCode).then(() => {
                    copyBtn.textContent = '✅ コピーしました！';
                    setTimeout(() => {
                        copyBtn.textContent = '📋 コードをコピー';
                    }, 2000);
                });
            }
        });

        // ダウンロードボタン
        const downloadBtn = document.getElementById('downloadBtn') as HTMLElement;
        downloadBtn.addEventListener('click', () => {
            this.downloadFile();
        });

        // WebRTCイベント
        this.webrtc.onStatusChange = (state: string, message: string) => {
            this.updateStatus(state, message);
        };

        this.webrtc.onProgress = (progress: number) => {
            this.updateProgress(progress);
        };

        this.webrtc.onStatsUpdate = (stats: TransferStats) => {
            this.updateDetailedStats(stats);
        };

        this.webrtc.onFileReceived = (fileData: FileInfo) => {
            this.handleFileReceived(fileData);
        };

        // サーバー送信メソッド設定
        this.webrtc.sendToServer = (data: ControlMessage | { type: string; candidate: RTCIceCandidate }) => {
            // WebRTCのメッセージはシグナリングサーバーに転送しない
            console.log('📤 WebRTCメッセージ（シグナリングサーバーには送信しない）:', data.type);
        };
    }

    // 進捗更新
    private updateProgress(progress: number): void {
        const progressBar = document.getElementById('progressContainer') as HTMLElement;
        const progressFill = document.getElementById('progressFill') as HTMLElement;
        const progressText = document.getElementById('progressText') as HTMLElement;

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
    private updateDetailedStats(stats: TransferStats): void {
        const mainChunksCompleted = document.getElementById('mainChunksCompleted') as HTMLElement;
        const subChunksCompleted = document.getElementById('subChunksCompleted') as HTMLElement;
        const receiveSpeed = document.getElementById('receiveSpeed') as HTMLElement;
        const failedChunks = document.getElementById('failedChunks') as HTMLElement;

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
            failedChunks.textContent = stats.failedChunks.toString();
        }
    }

    // 受信速度計算
    private calculateReceiveSpeed(): string {
        if (!this.receiveStartTime || !this.webrtc.receiveManager) return '0';

        const now = Date.now();
        const timeDiff = (now - this.lastProgressUpdate) / 1000; // 秒
        const bytesDiff = this.webrtc.receiveManager.totalReceived - this.lastBytesReceived;

        if (timeDiff > 0) {
            const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
            this.lastProgressUpdate = now;
            this.lastBytesReceived = this.webrtc.receiveManager.totalReceived;
            return speedMBps.toFixed(1);
        }

        return '0';
    }

    // ファイル受信完了処理
    private handleFileReceived(fileData: FileInfo): void {
        console.log('✅ ファイル受信完了:', fileData.name);
        this.receivedFile = fileData;

        const fileInfo = document.getElementById('fileInfo') as HTMLElement;
        const fileName = document.getElementById('fileName') as HTMLElement;
        const fileSize = document.getElementById('fileSize') as HTMLElement;
        const downloadSection = document.getElementById('downloadSection') as HTMLElement;

        fileName.textContent = `📄 ${fileData.name}`;
        fileSize.textContent = `📏 ${this.formatFileSize(fileData.size)}`;
        fileInfo.style.display = 'block';
        downloadSection.style.display = 'block';

        this.updateStatus('completed', '✅ ファイル受信完了！ダウンロード可能です');
    }

    // ファイルダウンロード
    private downloadFile(): void {
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

// 初期化
const serverV2 = new ServerManagerV2();