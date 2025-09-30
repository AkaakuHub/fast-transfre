/**
 * Fast Transfer V2 クライアントマネージャー
 * 100GB対応・階層チャンク転送の実装
 */

import type { FileInfo, TransferStats, ControlMessage } from './types.js';

declare global {
    interface WebRTCManagerV2 {
        pc: RTCPeerConnection | null;
        dataChannel: RTCDataChannel | null;
        chunkManager: any;
        maxConcurrentSends: number;
        BUFFER_THRESHOLD: number;
        adaptiveChunkSize: number;

        onStatusChange: ((state: string, message: string) => void) | null;
        onProgress: ((progress: number) => void) | null;
        onStatsUpdate: ((stats: TransferStats) => void) | null;
        onConnected: (() => void) | null;
        onDisconnected: (() => void) | null;
        sendToServer: ((data: ControlMessage | { type: string; candidate: RTCIceCandidate }) => void) | null;

        init(isHost: boolean): void;
        createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
        addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
        sendFile(file: File): Promise<void>;
    }

    var WebRTCManagerV2: {
        new(): WebRTCManagerV2;
    };
}
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
        this.webrtc = new WebRTCManagerV2();
        this.setupUI();
        this.connectToServer();
    }

    // WebSocketサーバー接続
    private connectToServer(): void {
        this.ws = new WebSocket('ws://localhost:3000');

        this.ws.onopen = () => {
            console.log('🚀 V2サーバー接続完了');
            // UIには表示せず初期状態を維持
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
        type: 'room-joined' | 'offer' | 'ice-candidate' | 'error';
        roomCode?: string;
        offer?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
        message?: string;
    }): void {
        console.log('📥 V2サーバー受信:', data.type, data);

        switch (data.type) {
            case 'room-joined':
                this.roomCode = data.roomCode || null;
                this.updateStatus('connecting', '🤝 P2P接続確立中...');
                console.log('🏠 ルーム参加完了:', data.roomCode);
                this.webrtc.init(false); // クライアントとしてWebRTC V2初期化
                break;

            case 'offer':
                if (data.offer) {
                    this.handleOffer(data.offer);
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

    // Offer処理
    async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
        try {
            console.log('🎯 V2 Offer受信:', offer);
            const answer = await this.webrtc.createAnswer(offer);
            console.log('🎯 V2 Answer作成完了:', answer);
            this.sendToServer({
                type: 'answer',
                answer: answer
            });
            console.log('🎯 V2 Answer送信完了');
        } catch (error: unknown) {
            console.error('❌ V2 Answer作成エラー:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.showError('接続応答エラー: ' + errorMessage);
        }
    }

    // ICE Candidate処理
    async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        try {
            console.log('🧊 V2 ICE Candidate受信:', candidate);
            await this.webrtc.addIceCandidate(candidate);
            console.log('🧊 V2 ICE Candidate追加完了');
        } catch (error) {
            console.error('❌ V2 ICE Candidate追加エラー:', error);
        }
    }

    // サーバー送信オーバーライド
    sendToServer(data: { type: string; [key: string]: any }): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('📤 V2サーバー送信:', data.type);
            this.ws.send(JSON.stringify(data));
        } else {
            console.error('❌ V2 WebSocket未接続 - 送信失敗:', data.type);
        }
    }

    // ルーム参加
    joinRoom(): void {
        const roomCodeInput = document.getElementById('roomCode') as HTMLInputElement;
        if (!roomCodeInput) return;

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
    selectFiles(files: FileList): void {
        this.selectedFiles = Array.from(files);
        this.displaySelectedFiles();
        this.updateSendButton();
    }

    // 選択ファイル表示
    displaySelectedFiles(): void {
        const selectedFile = document.getElementById('selectedFile');
        const fileName = document.getElementById('fileName');
        const fileSize = document.getElementById('fileSize');

        if (this.selectedFiles.length > 0) {
            const file = this.selectedFiles[0];
            if (fileName) fileName.textContent = `📄 ${file.name}`;
            if (fileSize) fileSize.textContent = `📏 ${this.formatFileSize(file.size)}`;
            if (selectedFile) selectedFile.style.display = 'block';
        } else {
            if (selectedFile) selectedFile.style.display = 'none';
        }
    }

    // 送信ボタン状態更新
    updateSendButton(): void {
        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
        if (!sendBtn) return;

        const canSend = this.selectedFiles.length > 0 &&
                       this.roomCode &&
                       this.roomCode.length === 4 &&
                       this.webrtc.pc &&
                       this.webrtc.pc.connectionState === 'connected';

        sendBtn.disabled = !canSend;
    }

    // ファイル送信（V2）
    async sendFiles(): Promise<void> {
        if (this.selectedFiles.length === 0) return;

        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
        const progressContainer = document.getElementById('progressContainer');

        if (!sendBtn || !progressContainer) return;

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
        } catch (error: unknown) {
            console.error('ファイル送信エラー:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.showError('V2ファイル送信エラー: ' + errorMessage);
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 高速送信開始';
        }
    }

    // 設定値を適用
    applySettings(): void {
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

    // UIセットアップ
    setupUI(): void {
        // ルームコード入力
        const roomCodeInput = document.getElementById('roomCode') as HTMLInputElement;
        if (roomCodeInput) {
            roomCodeInput.addEventListener('input', () => {
                if (roomCodeInput.value.length === 4) {
                    this.joinRoom();
                }
            });
        }

        // ファイル選択
        const fileInput = document.getElementById('fileInput') as HTMLInputElement;
        const selectFileBtn = document.getElementById('selectFileBtn') as HTMLButtonElement;
        const dropArea = document.getElementById('dropArea') as HTMLElement;
        const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;

        if (selectFileBtn && fileInput) {
            selectFileBtn.addEventListener('click', () => {
                fileInput.click();
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                if (target.files) {
                    this.selectFiles(target.files);
                }
            });
        }

        // ドラッグ&ドロップ
        if (dropArea) {
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
                if (e.dataTransfer && e.dataTransfer.files) {
                    this.selectFiles(e.dataTransfer.files);
                }
            });
        }

        // 送信ボタン
        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                this.sendFiles();
            });
        }

        // 詳細設定トグル
        const advancedToggle = document.getElementById('advancedToggle') as HTMLButtonElement;
        const advancedSettings = document.getElementById('advancedSettings') as HTMLElement;

        if (advancedToggle && advancedSettings) {
            advancedToggle.addEventListener('click', () => {
                if (advancedSettings.style.display === 'none' || !advancedSettings.style.display) {
                    advancedSettings.style.display = 'block';
                    advancedToggle.textContent = '⚙️ 設定を隠す';
                } else {
                    advancedSettings.style.display = 'none';
                    advancedToggle.textContent = '⚙️ 詳細設定';
                }
            });
        }

        // WebRTCイベント
        this.webrtc.onStatusChange = (state: string, message: string) => {
            const statusEl = document.getElementById('status');
            if (statusEl) {
                statusEl.innerHTML = `<span class="${state}">${message}</span>`;
            }
            this.updateSendButton();

            // P2P接続確立時にファイル選択UIを表示
            if (state === 'connected') {
                const dropAreaEl = document.getElementById('dropArea');
                const sendBtnEl = document.getElementById('sendBtn');
                if (dropAreaEl) dropAreaEl.style.display = 'block';
                if (sendBtnEl) sendBtnEl.style.display = 'inline-block';
            }
        };

        this.webrtc.onProgress = (progress: number) => {
            this.updateProgress(progress);
        };

        this.webrtc.onStatsUpdate = (stats: TransferStats) => {
            this.updateDetailedStats(stats);
        };

        this.webrtc.onConnected = () => {
            this.updateSendButton();
        };

        this.webrtc.onDisconnected = () => {
            this.updateSendButton();
        };

        // サーバー送信メソッド設定
        this.webrtc.sendToServer = (data: ControlMessage | { type: string; candidate: RTCIceCandidate }) => {
            this.sendToServer(data);
        };
    }

    // 進捗更新
    updateProgress(progress: number): void {
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
    updateDetailedStats(stats: TransferStats): void {
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
            failedChunks.textContent = stats.failedChunks.toString();
        }
    }

    // 転送速度計算
    calculateTransferSpeed(): string {
        if (!this.transferStartTime || !this.webrtc.chunkManager) return '0';

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

        return '0';
    }

    // ファイルサイズ整形
    formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // エラー表示
    showError(message: string): void {
        const errorEl = document.getElementById('error');
        if (!errorEl) return;

        errorEl.textContent = message;
        errorEl.style.display = 'block';

        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 5000);
    }

    // ステータス更新
    updateStatus(state: string, message: string): void {
        const statusEl = document.getElementById('status');
        if (!statusEl) return;

        statusEl.innerHTML = `<span class="${state}">${message}</span>`;
    }
}

// 初期化
const clientV2 = new ClientManagerV2();