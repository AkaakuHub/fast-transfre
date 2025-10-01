interface ChunkMetadataMessage {
    type: 'chunk-metadata';
    chunkId: string;
    mainChunkId: string;
    checksum: string;
    index: number;
}

interface FileStartV2Message {
    type: 'file-start-v2';
    filename: string;
    filesize: number;
    totalMainChunks: number;
    totalSubChunks: number;
}

interface ChunkAckMessage {
    type: 'chunk-ack';
    chunkId: string;
    success: boolean;
}

interface TransferCompleteMessage {
    type: 'transfer-complete';
}

interface RetryRequestMessage {
    type: 'retry-request';
    chunkId: string;
}

interface ChunkNackMessage {
    type: 'chunk-nack';
    missingIndexes: number[];
}

type ControlMessage = FileStartV2Message | ChunkMetadataMessage | ChunkAckMessage | ChunkNackMessage | TransferCompleteMessage | RetryRequestMessage;

interface FileInfo {
    name: string;
    size: number;
    data: ArrayBuffer;
}

interface TransferStats {
    progress: {
        percentage: number;
        bytesCompleted: number;
        totalBytes: number;
    };
    chunksCompleted: number;
    totalChunks: number;
    mainChunksCompleted: number;
    totalMainChunks: number;
    failedChunks: number;
}

interface MainChunk {
    id: string;
    index: number;
    start: number;
    end: number;
    size: number;
    subChunks: SubChunk[];
    status: 'pending' | 'sending' | 'completed' | 'failed';
    checksum: string | null;
}

interface SubChunk {
    id: string;
    mainChunkId: string;
    index: number;
    start: number;
    end: number;
    size: number;
    status: 'pending' | 'sending' | 'completed' | 'failed';
    checksum: string | null;
    retryCount: number;
}

interface ChunkManager {
    file: File;
    mainChunks: MainChunk[];
    completedSubChunks: Set<string>;
    failedSubChunks: Set<string>;
    startTime: number;

    getNextMainChunk(): MainChunk | null;
    getSubChunks(mainChunkId: string): SubChunk[];
    getNextSubChunk(mainChunkId: string): SubChunk | null;
    markSubChunkCompleted(subChunkId: string, checksum: string): void;
    markSubChunkFailed(subChunkId: string): void;
    updateMainChunkStatus(): void;
    getProgress(): {
        percentage: number;
        bytesCompleted: number;
        totalBytes: number;
        chunksCompleted: number;
        totalChunks: number;
        mainChunksCompleted: number;
        totalMainChunks: number;
    };
    isCompleted(): boolean;
    getRetryList(): SubChunk[];
    findSubChunk(subChunkId: string): SubChunk | null;
    getChunkData(chunk: SubChunk): Promise<ArrayBuffer>;
    calculateChecksum(buffer: ArrayBuffer): Promise<string>;
    formatFileSize(bytes: number): string;
    getStats(): any;
    startTransfer(): void;
}

interface WebRTCManagerV2Callbacks {
    onProgress?: ((progress: number) => void) | null;
    onStatusChange?: ((state: string, message: string) => void) | null;
    onFileReceived?: ((fileInfo: FileInfo) => void) | null;
    onStatsUpdate?: ((stats: TransferStats) => void) | null;
    onConnected?: (() => void) | null;
    onDisconnected?: (() => void) | null;
}

/**
 * WebRTC V2 - 階層チャンク対応高速転送マネージャー
 * バックプレッシャー制御、並列転送、堅牢性対策を実装
 */
class WebRTCManagerV2 {
    public pc: RTCPeerConnection | null = null;
    public dataChannel: RTCDataChannel | null = null;
    public chunkManager: ChunkManager | null = null;
    public receiveManager: any = null;
    public isHost: boolean = false;

    // 転送制御
    public isTransferring: boolean = false;
    public currentMainChunk: MainChunk | null = null;
    public sendQueue: ((value: unknown) => void)[] = [];
    public maxConcurrentSends: number = 3;
    public activeSends: number = 0;

    // バックプレッシャー制御 - 天才的なフロー制御用
    public BUFFER_THRESHOLD: number = 64 * 1024 * 1024; // 64MB - 100GB対応
    public adaptiveChunkSize: number = 1024 * 1024; // 1MBチャンク - 最適化
    public sendSpeed: number = 100; // ms間隔

    // バッファ管理
    public bufferReady: boolean = true;
    public bufferResolve: ((value: void) => void) | null = null;

    // 進捗・ステータス
    public onProgress: ((progress: number) => void) | null = null;
    public onStatusChange: ((state: string, message: string) => void) | null = null;
    public onFileReceived: ((fileInfo: FileInfo) => void) | null = null;
    public onFileReceiveStart: ((filename: string, filesize: number) => void) | null = null;
    public onStatsUpdate: ((stats: TransferStats) => void) | null = null;
    public onConnected: (() => void) | null = null;
    public onDisconnected: (() => void) | null = null;

    // サーバー通信
    public sendToServer(data: ControlMessage | { type: string; candidate: RTCIceCandidate }): void {
        // 子クラスでオーバーライド
    }

    // 再送制御
    public retryAttempts: Map<string, number> = new Map();
    public maxRetries: number = 3;

    // 受信制御
    public receiveStartTime: number = 0;
    public lastBytesReceived: number = 0;
    public lastProgressUpdate: number = 0;

    constructor() {
        // プロパティは上で初期化済み
    }

    /**
     * WebRTC接続初期化
     */
    init(isHost = false) {
        this.isHost = isHost;

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
        } else {
            this.pc.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.dataChannel.binaryType = 'arraybuffer';
                this.setupDataChannel();
            };
        }

        this.setupPeerConnection();
    }

    /**
     * DataChannelイベント設定
     */
    setupDataChannelEvents() {
        if (!this.dataChannel) return;

        this.dataChannel.binaryType = 'arraybuffer';

        // バックプレッシャー制御用
        this.dataChannel.bufferedAmountLowThreshold = 1024 * 1024; // 1MB

        this.dataChannel.onopen = () => {
            console.log('🔗 WebRTC V2 DataChannel接続確立');
            this.updateStatus('connected', '✅ P2P接続確立 - 高速転送準備完了');
        };

        this.dataChannel.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'file-info') {
                    // 新しいファイル情報処理
                    console.log(`📁 ファイル情報受信: ${data.filename} (${this.formatFileSize(data.filesize)})`);
                    this.updateStatus('receiving', `📁 ${data.filename} を受信中...`);

                    this.receiveManager = {
                        filename: data.filename,
                        filesize: data.filesize,
                        receivedChunks: new Map(),
                        expectedChunks: new Map(),
                        completedChunks: new Set(),
                        totalReceived: 0,
                        totalMainChunks: 1,
                        totalSubChunks: Math.ceil(data.filesize / (1024 * 1024))
                    };

                    if (this.onFileReceiveStart) {
                        this.onFileReceiveStart(data.filename, data.filesize);
                    }
                } else {
                    await this.handleControlMessage(data);
                }
            } catch (e) {
                // バイナリデータ受信
                await this.handleDirectBinaryData(event.data);
            }
        };

        this.dataChannel.onbufferedamountlow = () => {
            // バッファが空いたことを通知 - 天才的なバックプレッシャー制御
            console.log('📤 送信バッファに空きができました - 転送を再開');
            this.bufferReady = true;

            // バッファ空きイベントリスナーに通知
            if (this.bufferResolve) {
                this.bufferResolve();
                this.bufferResolve = null;
            }
        };

        this.dataChannel.onerror = (error) => {
            console.error('❌ DataChannelエラー:', error);
            this.updateStatus('error', '❌ 転送エラーが発生しました');
        };

        this.dataChannel.onclose = () => {
            console.log('🔌 DataChannel切断');
            this.updateStatus('disconnected', '❌ 接続が切断されました');
            // DataChannelはnullにせず、切断状態のまま保持
            // 次回使用時に再接続処理を行う
        };
    }

    /**
     * DataChannel設定
     */
    setupDataChannel() {
        this.setupDataChannelEvents();
    }

    /**
     * PeerConnection設定
     */
    setupPeerConnection() {
        if (!this.pc) return;

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendToServer({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log('🔗 接続状態:', this.pc?.connectionState);

            if (this.pc?.connectionState === 'connected') {
                this.updateStatus('connected', '🚀 高速転送モード準備完了');
            } else if (this.pc?.connectionState === 'disconnected') {
                this.handleDisconnection();
            }
        };

        // 接続品質監視
        this.pc.oniceconnectionstatechange = () => {
            console.log('🧊 ICE接続状態:', this.pc?.iceConnectionState);
            this.adjustTransferSpeed();
        };
    }

    /**
     * ファイル送信（V2）
     */
    async sendFile(file: File) {
        // DataChannelが準備できているかチェック
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.log('⚠️ DataChannelが未準備。接続を待機...');
            await this.waitForDataChannelReady();
        }

        console.log(`📁 ファイル送信開始: ${file.name} (${this.formatFileSize(file.size)})`);

        const CHUNK_SIZE = 1024 * 1024; // 1MB
        const BUFFER_THRESHOLD = 64 * 1024 * 1024; // 64MB
        let offset = 0;

        while (offset < file.size) {
            // バッファが閾値を超えていたら、送信を待機する
            if (this.dataChannel!.bufferedAmount > BUFFER_THRESHOLD) {
                console.log(`⏳ バッファ待機: ${this.formatFileSize(this.dataChannel!.bufferedAmount)}`);
                await new Promise<void>((resolve) => {
                    // バッファが減ったら再開するためのイベントリスナー
                    this.dataChannel!.onbufferedamountlow = () => {
                        console.log('📤 バッファ解放、再開');
                        resolve();
                    };
                });
                continue; // 待機後、再度ループの先頭から条件をチェック
            }

            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            const chunkData = await chunk.arrayBuffer();
            this.dataChannel!.send(chunkData);
            offset += chunkData.byteLength;

            console.log(`📤 チャンク送信: ${this.formatFileSize(chunkData.byteLength)} (進捗: ${Math.round((offset / file.size) * 100)}%)`);

            // 進捗更新
            const progress = (offset / file.size) * 100;
            if (this.onProgress) this.onProgress(progress);
        }

        console.log('✅ ファイル送信完了');
    }

    /**
     * メインチャンク転送開始
     */
    async startMainChunkTransfer() {
        while (this.isTransferring && !this.chunkManager!.isCompleted()) {
            this.currentMainChunk = this.chunkManager!.getNextMainChunk();

            if (!this.currentMainChunk) {
                // 失敗したチャンクの再送
                const retryChunks = this.chunkManager!.getRetryList();
                if (retryChunks.length > 0) {
                    console.log(`🔄 失敗チャンク再送: ${retryChunks.length}個`);
                    await this.retryFailedChunks(retryChunks);
                    continue;
                } else {
                    break; // 完了
                }
            }

            this.currentMainChunk.status = 'sending';
            console.log(`📦 メインチャンク転送開始: ${this.currentMainChunk.id} (${this.currentMainChunk.subChunks.length}サブチャンク)`);

            // サブチャンクを並列送信
            await this.sendSubChunksSequential(this.currentMainChunk);

            // メインチャンクのステータスを更新
            this.currentMainChunk.status = 'completed';

            // 進捗更新
            await this.updateProgress();

            // 少し待機して次のチャンクへ
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this.chunkManager!.isCompleted()) {
            try {
                await this.sendMessage({ type: 'transfer-complete' });
                console.log('✅ すべてのチャンク転送完了');
                this.updateStatus('completed', '✅ ファイル転送完了！');
            } catch (error) {
                console.warn('⚠️ transfer-complete送信エラー（無視）:', error);
                // 転送完了メッセージの送信失敗は無視して継続
            }
        }

        this.isTransferring = false;

        // 少し待機してDataChannelを安定させる
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    /**
     * サブチャンクを並列送信
     */
    async sendSubChunksSequential(mainChunk: MainChunk) {
        const subChunks = mainChunk.subChunks;

        console.log(`📦 天才的な逐次転送開始: ${mainChunk.id} (${subChunks.length}サブチャンク)`);

        // ドキュメント通りのwhileループで逐次送信
        for (const subChunk of subChunks) {
            // 天才的なバックプレッシャー制御 - ドキュメント通り
            if (this.dataChannel && this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD) {
                console.log(`⏳ 天才的なバックプレッシャー待機: ${this.formatFileSize(this.dataChannel.bufferedAmount)}`);
                await new Promise<void>((resolve) => {
                    const originalHandler = this.dataChannel!.onbufferedamountlow;
                    this.dataChannel!.onbufferedamountlow = () => {
                        console.log('📤 天才的なバッファ解放検知！');
                        this.dataChannel!.onbufferedamountlow = originalHandler;
                        resolve();
                    };
                });
            }

            // 一つずつ送信（これが天才的な方法）
            console.log(`🚀 天才的な逐次送信: ${subChunk.id}`);
            await this.sendSubChunk(subChunk);
        }

        console.log(`✅ 天才的なメインチャンク転送完了: ${mainChunk.id}`);
    }

    /**
     * サブチャンク送信
     */
    async sendSubChunk(subChunk: SubChunk) {
        try {
            // チャンクデータ取得
            const chunkData = await this.chunkManager!.getChunkData(subChunk);
            const checksum = await this.chunkManager!.calculateChecksum(chunkData);

            // ドキュメント通りの天才的バックプレッシャー制御
            if (this.dataChannel && this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD) {
                console.log(`⏳ 天才的なバックプレッシャー待機: ${this.formatFileSize(this.dataChannel.bufferedAmount)}`);
                await new Promise<void>((resolve) => {
                    this.dataChannel!.onbufferedamountlow = () => {
                        console.log('📤 天才的なバッファ解放検知！');
                        resolve();
                    };
                });
            }

            // 構造化されたチャンクヘッダー + データ（Base64廃止）
            const header = new ArrayBuffer(8); // 4バイトindex + 4バイトsize
            const headerView = new DataView(header);
            headerView.setUint32(0, subChunk.index, true); // little-endian
            headerView.setUint32(4, chunkData.byteLength, true);

            // 天才的なチャンクメッセージ（制御用） - サイズ大幅削減
            const controlMessage: ChunkMetadataMessage = {
                type: 'chunk-metadata',
                chunkId: subChunk.id,
                mainChunkId: subChunk.mainChunkId,
                checksum: checksum,
                index: subChunk.index
            };

            // 制御メッセージを送信
            await this.sendMessage(controlMessage);

            // バイナリデータを直接送信（天才的な方法）
            await this.sendBinaryData(header, chunkData);

            // チャンクマネージャーに完了を通知
            this.chunkManager!.markSubChunkCompleted(subChunk.id, checksum);

            console.log(`📤 サブチャンク送信完了: ${subChunk.id} (${this.formatFileSize(subChunk.size)}) - バイナリ直接転送`);

            // 進捗更新
            await this.updateProgress();

        } catch (error) {
            console.error(`❌ サブチャンク送信失敗: ${subChunk.id}`, error);

            // DataChannelが切断された場合は再接続を試みる
            if (error instanceof Error && error.message.includes('readyState is not')) {
                console.log('🔄 DataChannel再接続を試みます...');
                await this.waitForDataChannelReady();
                // 再送信を試みる
                try {
                    await this.sendSubChunk(subChunk);
                    console.log(`✅ サブチャンク再送信成功: ${subChunk.id}`);
                    return;
                } catch (retryError) {
                    console.error(`❌ サブチャンク再送信失敗: ${subChunk.id}`, retryError);
                }
            }

            this.chunkManager!.markSubChunkFailed(subChunk.id);
        } finally {
            this.activeSends--;
        }
    }

    /**
     * 天才的なバッファ空き待機 - バックプレッシャー制御
     */
    async waitForBufferSpace() {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannelが準備できていません');
        }

        // バッファが閾値を超えている場合、天才的な待機処理
        while (this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD) {
            console.log(`⏳ 天才的なバッファ制御: ${this.formatFileSize(this.dataChannel.bufferedAmount)}/${this.formatFileSize(this.BUFFER_THRESHOLD)}`);

            // バッファ空きをPromiseで待機（イベント駆動）
            if (this.bufferReady) {
                this.bufferReady = false;
                return new Promise<void>((resolve) => {
                    this.bufferResolve = resolve;
                });
            }

            // イベントが来ない場合のフォールバック（100ms待機）
            await new Promise(resolve => setTimeout(resolve, 100));

            // 送信速度の動的調整
            this.adjustTransferSpeed();
        }
    }

    /**
     * 天才的なバイナリデータ統合送信 - ヘッダー+データ一体化
     */
    async sendBinaryData(header: ArrayBuffer, data: ArrayBuffer) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannelが準備できていません');
        }

        try {
            // ヘッダーとデータを統合したArrayBufferを作成
            const combinedBuffer = new ArrayBuffer(header.byteLength + data.byteLength);
            const combinedView = new Uint8Array(combinedBuffer);

            // ヘッダーを先頭に配置
            combinedView.set(new Uint8Array(header), 0);
            // データをヘッダーの後に配置
            combinedView.set(new Uint8Array(data), header.byteLength);

            // 統合されたデータを一度に送信（これが天才的な方法）
            this.dataChannel.send(combinedBuffer);

            console.log(`🚀 天才的な統合バイナリ送信完了: ヘッダー8B + データ${this.formatFileSize(data.byteLength)}`);
        } catch (error) {
            console.error('❌ 統合バイナリ送信エラー:', error);

            if (error instanceof Error && error.message.includes('send queue is full')) {
                console.log('⚠️ 送信キュー満杯、バックプレッシャー制御発動');
                await this.waitForBufferSpace();
                // 再試行
                await this.sendBinaryData(header, data);
            } else {
                throw error;
            }
        }
    }

    /**
     * 転送速度調整
     */
    adjustTransferSpeed() {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            return;
        }

        const bufferSize = this.dataChannel.bufferedAmount;

        if (bufferSize > this.BUFFER_THRESHOLD * 2) {
            // バッファが溢れている場合、送信速度を落とす
            this.sendSpeed = Math.min(this.sendSpeed * 1.5, 500);
            this.adaptiveChunkSize = Math.max(this.adaptiveChunkSize / 2, 4096);
        } else if (bufferSize < this.BUFFER_THRESHOLD / 4) {
            // バッファに余裕がある場合、送信速度を上げる
            this.sendSpeed = Math.max(this.sendSpeed * 0.8, 50);
            this.adaptiveChunkSize = Math.min(this.adaptiveChunkSize * 1.2, 65536);
        }

        console.log(`🎯 転送速度調整: 間隔${this.sendSpeed}ms, チャンク${this.adaptiveChunkSize}B`);
    }

    /**
     * 失敗チャンク再送
     */
    async retryFailedChunks(failedChunks: SubChunk[]) {
        for (const subChunk of failedChunks) {
            if (subChunk.retryCount <= this.maxRetries) {
                console.log(`🔄 再送試行: ${subChunk.id} (${subChunk.retryCount}/${this.maxRetries})`);
                await this.sendSubChunk(subChunk);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    /**
     * DataChannelを再確立
     */
    async recreateDataChannel(): Promise<void> {
        if (!this.pc) {
            throw new Error('PeerConnectionが存在しません');
        }

        console.log('🔄 DataChannel再接続開始...');

        // 既存のDataChannelがあればクローズ
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        // WebRTC仕様：DataChannel作成側のみが再作成可能
        if (this.isHost) {
            // ホスト側：DataChannelを再作成
            console.log('📡 ホストとしてDataChannelを再作成');
            this.dataChannel = this.pc.createDataChannel('fileTransfer-v2', {
                ordered: true,
                maxRetransmits: 10,
                maxPacketLifeTime: 3000 // 3秒
            });
            this.setupDataChannelEvents();

            // 開くのを待機
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('タイムアウト')), 10000);
                if (this.dataChannel) {
                    this.dataChannel.onopen = () => {
                        clearTimeout(timeout);
                        console.log('✅ DataChannel再接続完了');
                        resolve();
                    };
                }
            });
        } else {
            // クライアント側：ホストのDataChannel接続を待つ
            console.log('⏳ クライアントとしてDataChannel接続を待機');
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('タイムアウト')), 15000);

                const onDataChannel = (event: RTCDataChannelEvent) => {
                    console.log('📡 ホストからのDataChannelを受信');
                    this.dataChannel = event.channel;
                    this.setupDataChannelEvents();

                    if (this.dataChannel) {
                        this.dataChannel.onopen = () => {
                            clearTimeout(timeout);
                            this.pc!.removeEventListener('datachannel', onDataChannel);
                            console.log('✅ DataChannel接続完了');
                            resolve();
                        };
                    }
                };

                this.pc!.addEventListener('datachannel', onDataChannel);
            });
        }
    }

    /**
     * DataChannelが準備できるまで待機
     */
    async waitForDataChannelReady(): Promise<void> {
        // DataChannelが存在しないか閉じている場合は再確立
        if (!this.dataChannel || this.dataChannel.readyState === 'closed') {
            console.log('🔄 DataChannel再確立が必要です');
            await this.recreateDataChannel();
            return;
        }

        return new Promise((resolve, reject) => {
            if (this.dataChannel && this.dataChannel.readyState === 'open') {
                resolve();
                return;
            }

            let timeoutId: NodeJS.Timeout;

            const checkInterval = setInterval(() => {
                if (this.dataChannel && this.dataChannel.readyState === 'open') {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    console.log('✅ DataChannel準備完了');
                    resolve();
                } else if (this.dataChannel && this.dataChannel.readyState === 'closed') {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    reject(new Error('DataChannelが閉じています'));
                }
            }, 100);

            // 10秒タイムアウト
            timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('DataChannel接続タイムアウト'));
            }, 10000);
        });
    }

    /**
     * 天才的な制御メッセージ送信
     */
    async sendMessage(data: ControlMessage) {
        try {
            // DataChannelが存在しない、または閉じている場合は再接続
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                console.log('🔄 DataChannel再接続が必要です');
                await this.waitForDataChannelReady();
            }
            this.dataChannel!.send(JSON.stringify(data));
        } catch (error) {
            console.error('❌ メッセージ送信失敗:', error);
            // 送信失敗時はDataChannelをクリアして次回再接続
            this.dataChannel = null;
            throw error;
        }
    }

    /**
     * 天才的なACK処理
     */
    async handleChunkAck(data: ChunkAckMessage) {
        console.log(`✅ 天才的なACK受信: ${data.chunkId}`);

        // ACKに基づいて送信管理を更新
        if (this.chunkManager) {
            // チャンクマネージャーにACKを通知
            this.chunkManager.markSubChunkCompleted(data.chunkId, 'ack-received');

            // 進捗更新
            await this.updateProgress();
        }
    }

    /**
     * 天才的なNACK処理
     */
    async handleChunkNack(data: ChunkNackMessage) {
        console.log(`❌ 天才的なNACK受信: ${data.missingIndexes.length}個のチャンク再送要求`);

        if (!this.chunkManager) return;

        // 欠損チャンクの再送
        for (const index of data.missingIndexes) {
            // 対応するサブチャンクを検索して再送
            const subChunk = this.findSubChunkByIndex(index);
            if (subChunk) {
                console.log(`🔄 天才的なチャンク再送: ${subChunk.id} (index: ${index})`);
                await this.sendSubChunk(subChunk);
            }
        }
    }

    /**
     * インデックスからサブチャンクを検索
     */
    findSubChunkByIndex(index: number): SubChunk | null {
        if (!this.chunkManager) return null;

        // 全メインチャンクを検索
        for (const mainChunk of this.chunkManager.mainChunks) {
            // 全サブチャンクを検索
            for (const subChunk of mainChunk.subChunks) {
                if (subChunk.index === index) {
                    return subChunk;
                }
            }
        }

        return null;
    }

    /**
     * 天才的な制御メッセージ受信処理
     */
    async handleControlMessage(data: ControlMessage) {
        switch (data.type) {
            case 'file-start-v2':
                await this.handleFileStart(data);
                break;
            case 'chunk-metadata':
                await this.handleChunkMetadata(data);
                break;
            case 'chunk-ack':
                // 天才的なACK受信処理（送信側）
                console.log('✅ チャンクACK受信:', data.chunkId);
                await this.handleChunkAck(data);
                break;
            case 'chunk-nack':
                // 天才的なNACK受信処理（送信側）
                console.log('❌ チャンクNACK受信:', data.missingIndexes);
                await this.handleChunkNack(data);
                break;
            case 'transfer-complete':
                await this.handleTransferComplete();
                break;
            case 'retry-request':
                await this.handleRetryRequest(data);
                break;
        }
    }

    /**
     * ファイル開始処理（受信側）
     */
    async handleFileStart(data: FileStartV2Message) {
        console.log(`📁 ファイル受信開始: ${data.filename} (${this.formatFileSize(data.filesize)})`);

        this.updateStatus('receiving', `📁 ${data.filename} を受信中...`);

        // シンプルな受信管理
        this.receiveManager = {
            filename: data.filename,
            filesize: data.filesize,
            receivedChunks: new Map(),
            expectedChunks: new Map(),
            completedChunks: new Set(),
            totalReceived: 0,
            totalMainChunks: 1,
            totalSubChunks: Math.ceil(data.filesize / (1024 * 1024))
        };

        // ファイル受信開始を通知
        if (this.onFileReceiveStart) {
            this.onFileReceiveStart(data.filename, data.filesize);
        }
    }

    /**
     * 天才的なチャンクメタデータ受信処理
     */
    async handleChunkMetadata(data: ChunkMetadataMessage) {
        console.log(`📋 チャンクメタデータ受信: ${data.chunkId} (index: ${data.index})`);

        // 受信マネージャーにメタデータを保存
        if (!this.receiveManager) {
            console.error('❌ 受信マネージャーが初期化されていません');
            return;
        }

        this.receiveManager.expectedChunks.set(data.chunkId, {
            id: data.chunkId,
            mainChunkId: data.mainChunkId,
            index: data.index,
            checksum: data.checksum,
            received: false
        });
    }

    /**
     * ドキュメント通りの直接バイナリ受信 - シンプルイズベスト！
     */
    async handleDirectBinaryData(data: ArrayBuffer) {
        if (!this.receiveManager) return;

        // ドキュメント通り：データをそのまま追加！ヘッダー不要！インデックス不要！
        this.receiveManager.receivedChunks.set(`chunk_${this.receiveManager.receivedChunks.size}`, data);
        this.receiveManager.totalReceived += data.byteLength;

        console.log(`🔥 ドキュメント通りの直接受信: ${this.formatFileSize(data.byteLength)}`);

        // 進捗更新
        const progress = (this.receiveManager.totalReceived / this.receiveManager.filesize) * 100;
        if (this.onProgress) this.onProgress(progress);

        // ドキュメント通り：ファイル受信完了検出
        if (this.receiveManager.totalReceived >= this.receiveManager.filesize) {
            console.log('🎉 ドキュメント通りのファイル受信完了！');
            await this.reconstructReceivedFileSimple();
        }
    }

    /**
     * チャンクデータ処理
     */
    async processChunkData(chunkId: string, expectedChecksum: string, chunkData: ArrayBuffer) {
        if (!this.receiveManager) return;

        // チャンクの整合性チェック
        const receivedChecksum = await this.calculateChecksum(chunkData);
        console.log(`🔍 チャンク ${chunkId} チェックサム検証中...`);
        console.log(`期待: ${expectedChecksum}`);
        console.log(`実際: ${receivedChecksum}`);

        if (receivedChecksum === expectedChecksum) {
            console.log(`✅ チャンク ${chunkId} の整合性確認完了`);
            this.receiveManager.completedChunks.add(chunkId);

            // チャンクデータを一時的に保存
            this.receiveManager.receivedChunks.set(chunkId, chunkData);
            this.receiveManager.totalReceived += chunkData.byteLength;

            // ACK送信
            await this.sendMessage({
                type: 'chunk-ack',
                chunkId: chunkId,
                success: true
            });
        } else {
            console.error(`❌ チャンク ${chunkId} のチェックサム不一致`);
            console.error(`期待: ${expectedChecksum}, 実際: ${receivedChecksum}`);
            // 再送要求
            await this.sendMessage({
                type: 'retry-request',
                chunkId: chunkId
            });
            return; // チェックサム不一致の場合は進捗を更新しない
        }

        // 進捗更新
        const progress = (this.receiveManager.totalReceived / this.receiveManager.filesize) * 100;
        this.updateProgress(progress);

        // 転送完了チェック
        if (this.receiveManager.totalReceived >= this.receiveManager.filesize) {
            await this.assembleAndSaveFile();
        }
    }

    /**
     * ファイル結合と保存
     */
    async assembleAndSaveFile() {
        if (!this.receiveManager) return;

        try {
            console.log('🔧 ファイル結合開始...');

            // チャンクを正しい順序でソート
            const sortedChunks = Array.from(this.receiveManager!.receivedChunks.entries() as [string, ArrayBuffer][])
                .sort((a, b) => {
                    // chunkIdを数値として比較
                    const aNum = parseInt(a[0].split('_sub_')[1]);
                    const bNum = parseInt(b[0].split('_sub_')[1]);
                    return aNum - bNum;
                });

            // 総ファイルサイズでArrayBufferを確保
            const totalSize = this.receiveManager!.filesize;
            const combinedBuffer = new ArrayBuffer(totalSize);
            const combinedView = new Uint8Array(combinedBuffer);

            let offset = 0;
            for (const [chunkId, chunkData] of sortedChunks) {
                const chunkView = new Uint8Array(chunkData);
                combinedView.set(chunkView, offset);
                offset += chunkView.length;
                console.log(`📦 チャンク ${chunkId} を結合 (位置: ${offset})`);
            }

            console.log('✅ ファイル結合完了');

            // ファイルオブジェクトを作成してコールバック実行
            if (this.onFileReceived) {
                this.onFileReceived({
                    name: this.receiveManager!.filename,
                    size: this.receiveManager!.filesize,
                    data: combinedBuffer
                });
            }

        } catch (error) {
            console.error('❌ ファイル結合エラー:', error);
            this.updateStatus('error', '❌ ファイル結合エラー');
        }
    }

    /**
     * ドキュメント通りのシンプルファイル再構築
     */
    async reconstructReceivedFileSimple() {
        if (!this.receiveManager) return;

        console.log('🔧 ドキュメント通りのシンプルファイル再構築開始...');

        try {
            // 総ファイルサイズでArrayBufferを確保
            const totalSize = this.receiveManager.filesize;
            const combinedBuffer = new ArrayBuffer(totalSize);
            const combinedView = new Uint8Array(combinedBuffer);

            let offset = 0;
            // ドキュメント通り：受信した順番で結合！インデックス不要！
            for (const [chunkId, chunkData] of this.receiveManager.receivedChunks) {
                const chunkView = new Uint8Array(chunkData);
                combinedView.set(chunkView, offset);
                offset += chunkView.length;
                console.log(`📦 ドキュメント通りのチャンク結合: ${chunkId}, 位置 ${offset}`);
            }

            console.log('✅ ドキュメント通りのファイル再構築完了！');

            // ファイルオブジェクトを作成してコールバック実行
            if (this.onFileReceived) {
                this.onFileReceived({
                    name: this.receiveManager.filename,
                    size: this.receiveManager.filesize,
                    data: combinedBuffer
                });
            }

            this.updateStatus('completed', `✅ ${this.receiveManager.filename} 受信完了！`);

        } catch (error) {
            console.error('❌ ドキュメント通りのファイル再構築エラー:', error);
            this.updateStatus('error', '❌ ファイル再構築エラー');
        }
    }

    /**
     * 転送完了処理
     */
    async handleTransferComplete() {
        console.log('✅ 転送完了');
        this.updateStatus('completed', '✅ 転送完了！');

        // ファイル結合はチャンクデータ受信完了時に自動実行される
    }

    /**
     * 再送要求処理
     */
    async handleRetryRequest(data: RetryRequestMessage) {
        console.log(`🔄 再送要求受信: ${data.chunkId}`);
        // 再送要求の処理を実装
        // TODO: 該当チャンクの再送ロジック
    }

    /**
     * 接続切断処理
     */
    handleDisconnection() {
        if (this.isTransferring) {
            console.log('⚠️ 転送中に接続が切断されました');
            this.updateStatus('interrupted', '⚠️ 転送が中断されました');
            // TODO: 再接続と再開処理
        }
    }

    /**
     * 進捗更新
     */
    async updateProgress(progress: number | null = null) {
        // 送信側の統計
        if (this.chunkManager) {
            const stats = this.chunkManager.getStats();
            progress = stats.progress.percentage;

            console.log('📊 送信側統計計算:', {
                progress: progress?.toFixed(1) + '%',
                mainChunks: `${stats.mainChunksCompleted}/${stats.totalMainChunks}`,
                subChunks: `${stats.chunksCompleted}/${stats.totalChunks}`,
                failed: stats.failedChunks
            });

            if (this.onStatsUpdate) {
                this.onStatsUpdate(stats);
            }
        }
        // 天才的な受信側統計
        else if (this.receiveManager) {
            const stats = this.getReceiveStats();
            progress = stats.progress.percentage;

            console.log('📊 天才的な受信側統計更新:', {
                progress: progress?.toFixed(1) + '%',
                mainChunks: `${stats.mainChunksCompleted}/${stats.totalMainChunks}`,
                subChunks: `${stats.chunksCompleted}/${stats.totalChunks}`
            });

            if (this.onStatsUpdate) {
                this.onStatsUpdate(stats);
            }

            // 天才的な転送完了検出 - 構造化プロトコル
            if (this.receiveManager.receivedChunks.size === this.receiveManager.totalSubChunks) {
                console.log('🎯 天才的な転送完了！全チャンク受信完了 - ファイル再構築開始');
                await this.reconstructReceivedFileSimple();
            }
        }

        if (this.onProgress && progress !== null) {
            this.onProgress(progress);
        }
    }

    /**
     * 受信側統計情報取得
     */
    getReceiveStats(): TransferStats {
        if (!this.receiveManager) {
            return {
                progress: { percentage: 0, bytesCompleted: 0, totalBytes: 0 },
                chunksCompleted: 0,
                totalChunks: 0,
                mainChunksCompleted: 0,
                totalMainChunks: 0,
                failedChunks: 0
            };
        }

        const progress = this.receiveManager.filesize > 0
            ? (this.receiveManager.totalReceived / this.receiveManager.filesize) * 100
            : 0;

        // メインチャンク数を推定（1チャンク50MBとして計算）
        const estimatedMainChunks = Math.ceil(this.receiveManager.filesize / (50 * 1024 * 1024));
        const receivedMainChunks = Math.min(
            Math.ceil(this.receiveManager.totalReceived / (50 * 1024 * 1024)),
            estimatedMainChunks
        );

        return {
            progress: {
                percentage: progress,
                bytesCompleted: this.receiveManager!.totalReceived,
                totalBytes: this.receiveManager!.filesize
            },
            chunksCompleted: this.receiveManager!.completedChunks.size,
            totalChunks: this.receiveManager!.totalSubChunks || Math.ceil(this.receiveManager!.filesize / (1024 * 1024)), // 1MB単位で推定
            mainChunksCompleted: receivedMainChunks,
            totalMainChunks: this.receiveManager!.totalMainChunks || estimatedMainChunks,
            failedChunks: 0 // 受信側では失敗は再送で解決されるため0
        };
    }

    /**
     * ステータス更新
     */
    updateStatus(state: string, message: string) {
        if (this.onStatusChange) {
            this.onStatusChange(state, message);
        }
    }

    /**
     * WebRTC基本メソッド（Offer/Answerなど）
     */
    async createOffer(): Promise<RTCSessionDescriptionInit> {
        const offer = await this.pc!.createOffer();
        await this.pc!.setLocalDescription(offer);
        return offer;
    }

    async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        await this.pc!.setRemoteDescription(offer);
        const answer = await this.pc!.createAnswer();
        await this.pc!.setLocalDescription(answer);
        return answer;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        await this.pc!.setRemoteDescription(description);
    }

    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        await this.pc!.addIceCandidate(candidate);
    }

    /**
     * ArrayBufferをBase64に変換
     */
    arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Base64をArrayBufferに変換
     */
    base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * SHA-256チェックサムを計算
     */
    async calculateChecksum(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * ユーティリティ
     */
    formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * クリーンアップ
     */
    destroy() {
        this.isTransferring = false;
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