interface ChunkMessage {
  type: 'chunk';
  mainChunkId: string;
  subChunkId: string;
  data: ArrayBuffer;
  isLast: boolean;
}

interface FileStartMessage {
  type: 'file-start';
  name: string;
  size: number;
  mimeType: string;
  totalMainChunks: number;
}

interface FileEndMessage {
  type: 'file-end';
  name: string;
}

interface AckMessage {
  type: 'ack';
  mainChunkId: string;
  subChunkId: string;
}

interface StatsUpdateMessage {
  type: 'stats-update';
  stats: any;
}

type DataChannelMessage = ChunkMessage | FileStartMessage | FileEndMessage | AckMessage | StatsUpdateMessage;

/**
 * WebRTC V2 - 階層チャンク対応高速転送マネージャー
 * バックプレッシャー制御、並列転送、堅牢性対策を実装
 */
class WebRTCManagerV2 {
    public pc: RTCPeerConnection | null = null;
    public dataChannel: RTCDataChannel | null = null;
    public chunkManager: any;

    // 転送制御
    private sendQueue: ((value: unknown) => void)[] = [];
    public maxConcurrentSends = 3;
    public activeSends = 0;

    // バックプレッシャー制御
    public BUFFER_THRESHOLD = 1024 * 1024; // 1MB
    public adaptiveChunkSize = 16 * 1024; // 動的チャンクサイズ
    private sendSpeed = 100; // ms間隔

    // 進捗・ステータス
    public onProgress: ((progress: number) => void) | null = null;
    public onStatusChange: ((state: string, message: string) => void) | null = null;
    public onFileReceived: ((fileInfo: any) => void) | null = null;
    public onStatsUpdate: ((stats: any) => void) | null = null;
    public onConnected: (() => void) | null = null;
    public onDisconnected: (() => void) | null = null;

    // 再送制御
    private retryAttempts = new Map<string, number>();

    public sendToServer: ((data: any) => void) | null = null;

    /**
     * WebRTC接続初期化
     */
    public init(isHost = false): void {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        this.pc = new RTCPeerConnection(config);

        if (isHost) {
            this.dataChannel = this.pc.createDataChannel('fileTransfer-v2', {
                ordered: true,
                maxRetransmits: 3
            });

            this.setupDataChannel();
            this.setupPeerConnection();
        }
    }

    /**
     * DataChannel設定
     */
    private setupDataChannel(): void {
        if (!this.dataChannel) return;

        this.dataChannel.onopen = () => {
            console.log('🚀 DataChannel開通');
            this.onStatusChange?.('connected', '✅ P2P接続確立');
            this.onConnected?.();
        };

        this.dataChannel.onclose = () => {
            console.log('🔌 DataChannel切断');
            this.onStatusChange?.('disconnected', '❌ P2P接続切断');
            this.onDisconnected?.();
        };

        this.dataChannel.onerror = (error) => {
            console.error('❌ DataChannelエラー:', error);
            this.onStatusChange?.('error', '❌ P2P通信エラー');
        };

        this.dataChannel.onmessage = (event) => {
            this.handleDataChannelMessage(event.data);
        };

        // バックプレッシャー監視
        this.dataChannel.onbufferedamountlow = () => {
            console.log('💧 バッファ解放');
            this.processSendQueue();
        };
    }

    /**
     * PeerConnectionイベント設定
     */
    private setupPeerConnection(): void {
        if (!this.pc) return;

        this.pc.onicecandidate = (event) => {
            if (event.candidate && this.sendToServer) {
                this.sendToServer({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log('🔗 接続状態:', this.pc?.connectionState);
        };

        // クライアント側のDataChannel受信設定
        this.pc.ondatachannel = (event) => {
            console.log('📡 DataChannel受信');
            this.dataChannel = event.channel;
            this.setupDataChannel();
        };
    }

    /**
     * DataChannelメッセージ処理
     */
    private handleDataChannelMessage(rawData: ArrayBuffer): void {
        try {
            const message: DataChannelMessage = JSON.parse(new TextDecoder().decode(rawData));

            switch (message.type) {
                case 'file-start':
                    this.handleFileStart(message as FileStartMessage);
                    break;
                case 'chunk':
                    this.handleChunk(message as ChunkMessage);
                    break;
                case 'file-end':
                    this.handleFileEnd(message as FileEndMessage);
                    break;
                case 'ack':
                    this.handleAck(message as AckMessage);
                    break;
                case 'stats-update':
                    this.handleStatsUpdate(message as StatsUpdateMessage);
                    break;
            }
        } catch (error) {
            console.error('❌ メッセージ解析エラー:', error);
        }
    }

    /**
     * ファイル受信開始処理
     */
    private handleFileStart(message: FileStartMessage): void {
        console.log('📁 ファイル受信開始:', message.name);
        this.chunkManager = new (window as any).ChunkManager(message.name, message.size);
        this.chunkManager.totalMainChunks = message.totalMainChunks;
    }

    /**
     * チャンク受信処理
     */
    private handleChunk(message: ChunkMessage): void {
        if (!this.chunkManager) return;

        this.chunkManager.receiveSubChunk(message.mainChunkId, message.subChunkId, message.data);

        // ACK送信
        if (this.dataChannel) {
            this.sendMessage({
                type: 'ack',
                mainChunkId: message.mainChunkId,
                subChunkId: message.subChunkId
            });
        }

        // 進捗更新
        const progress = this.chunkManager.getProgress();
        this.onProgress?.(progress.percent);
        this.onStatsUpdate?.(progress);
    }

    /**
     * ファイル受信完了処理
     */
    private handleFileEnd(message: FileEndMessage): void {
        if (!this.chunkManager) return;

        console.log('🎁 ファイル受信完了:', message.name);

        const fileInfo = {
            name: message.name,
            size: this.chunkManager.fileSize,
            data: this.chunkManager.getAssembledFile()
        };

        this.onFileReceived?.(fileInfo);
    }

    /**
     * ACK受信処理
     */
    private handleAck(message: AckMessage): void {
        const key = `${message.mainChunkId}-${message.subChunkId}`;
        this.retryAttempts.delete(key);

        if (this.chunkManager) {
            this.chunkManager.markSubChunkCompleted(message.mainChunkId, message.subChunkId);
        }

        this.processSendQueue();
    }

    /**
     * 統計更新処理
     */
    private handleStatsUpdate(message: StatsUpdateMessage): void {
        this.onStatsUpdate?.(message.stats);
    }

    /**
     * Offer作成（ホスト用）
     */
    public async createOffer(): Promise<RTCSessionDescriptionInit> {
        if (!this.pc) throw new Error('PeerConnection未初期化');

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        return offer;
    }

    /**
     * Answer作成（クライアント用）
     */
    public async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        if (!this.pc) throw new Error('PeerConnection未初期化');

        await this.pc.setRemoteDescription(offer);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        return answer;
    }

    /**
     * Answer処理（ホスト用）
     */
    public async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        if (!this.pc) throw new Error('PeerConnection未初期化');
        await this.pc.setRemoteDescription(answer);
    }

    /**
     * ICE Candidate追加
     */
    public async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (!this.pc) throw new Error('PeerConnection未初期化');
        await this.pc.addIceCandidate(candidate);
    }

    /**
     * ファイル送信
     */
    public async sendFile(file: File): Promise<void> {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannel未接続');
        }

        // 転送開始
        this.chunkManager = new (window as any).ChunkManager(file.name, file.size);

        try {
            // ファイル開始通知
            this.sendMessage({
                type: 'file-start',
                name: file.name,
                size: file.size,
                mimeType: file.type,
                totalMainChunks: this.chunkManager.totalMainChunks
            });

            // ファイル読み込み
            const fileBuffer = await file.arrayBuffer();
            this.chunkManager.createMainChunks(fileBuffer);

            // メインチャンク送信
            for (const mainChunkId of this.chunkManager.getMainChunkIds()) {
                await this.sendMainChunk(mainChunkId);
            }

            // ファイル終了通知
            this.sendMessage({
                type: 'file-end',
                name: file.name
            });

        } finally {
            // 転送完了
        }
    }

    /**
     * メインチャンク送信
     */
    private async sendMainChunk(mainChunkId: string): Promise<void> {
        const subChunks = this.chunkManager.getSubChunks(mainChunkId);

        for (const subChunk of subChunks) {
            await this.sendSubChunk(mainChunkId, subChunk.id, subChunk.data);
        }
    }

    /**
     * サブチャンク送信
     */
    private async sendSubChunk(mainChunkId: string, subChunkId: string, data: ArrayBuffer): Promise<void> {
        if (!this.dataChannel) return;

        // バックプレッシャー確認
        if (this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD) {
            await this.waitForBufferDrain();
        }

        // 並列送信制御
        if (this.activeSends >= this.maxConcurrentSends) {
            await new Promise(resolve => {
                this.sendQueue.push(resolve);
            });
        }

        this.activeSends++;

        try {
            const message: ChunkMessage = {
                type: 'chunk',
                mainChunkId,
                subChunkId,
                data,
                isLast: false
            };

            this.sendMessage(message);

            // 送信間隔調整
            await new Promise(resolve => setTimeout(resolve, this.sendSpeed));

        } finally {
            this.activeSends--;
            this.processSendQueue();
        }
    }

    /**
     * メッセージ送信
     */
    private sendMessage(message: DataChannelMessage): void {
        if (!this.dataChannel) return;

        const jsonStr = JSON.stringify(message);
        const data = new TextEncoder().encode(jsonStr);

        this.dataChannel.send(data);
    }

    /**
     * バッファ解放待機
     */
    private waitForBufferDrain(): Promise<void> {
        return new Promise(resolve => {
            if (!this.dataChannel) {
                resolve();
                return;
            }

            const checkBuffer = () => {
                if (this.dataChannel!.bufferedAmount <= this.BUFFER_THRESHOLD) {
                    resolve();
                } else {
                    setTimeout(checkBuffer, 100);
                }
            };

            checkBuffer();
        });
    }

    /**
     * 送信キュー処理
     */
    private processSendQueue(): void {
        if (this.sendQueue.length > 0 && this.activeSends < this.maxConcurrentSends) {
            const resolve = this.sendQueue.shift();
            if (resolve) resolve(undefined);
        }
    }

    /**
     * 接続切断
     */
    public disconnect(): void {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.pc) {
            this.pc.close();
        }
    }
}

// グローバル登録
(window as any).WebRTCManagerV2 = WebRTCManagerV2;

export default WebRTCManagerV2;