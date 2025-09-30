/**
 * WebRTC V2 - 階層チャンク対応高速転送マネージャー
 * バックプレッシャー制御、並列転送、堅牢性対策を実装
 */
class WebRTCManagerV2 {
    constructor() {
        this.pc = null;
        this.dataChannel = null;
        this.chunkManager = null;

        // 転送制御
        this.isTransferring = false;
        this.currentMainChunk = null;
        this.sendQueue = [];
        this.maxConcurrentSends = 3;
        this.activeSends = 0;

        // バックプレッシャー制御
        this.BUFFER_THRESHOLD = 1024 * 1024; // 1MB
        this.adaptiveChunkSize = 16 * 1024; // 動的チャンクサイズ
        this.sendSpeed = 100; // ms間隔

        // 進捗・ステータス
        this.onProgress = null;
        this.onStatusChange = null;
        this.onFileReceived = null;
        this.onStatsUpdate = null;

        // 再送制御
        this.retryAttempts = new Map();
        this.maxRetries = 3;
    }

    /**
     * WebRTC接続初期化
     */
    init(isHost = false) {
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
     * DataChannel設定
     */
    setupDataChannel() {
        this.dataChannel.binaryType = 'arraybuffer';

        this.dataChannel.onopen = () => {
            console.log('🔗 WebRTC V2 DataChannel接続確立');
            this.updateStatus('connected', '✅ P2P接続確立 - 高速転送準備完了');
        };

        this.dataChannel.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                await this.handleControlMessage(data);
            } catch (e) {
                // バイナリデータ（チャンク）受信
                await this.handleChunkData(event.data);
            }
        };

        this.dataChannel.onbufferedamountlow = () => {
            // バッファが空いたことを通知
            console.log('📤 送信バッファに空きができました');
            // バッファ空きを通知（送信処理は並列送信システムで管理）
        };

        this.dataChannel.onerror = (error) => {
            console.error('❌ DataChannelエラー:', error);
            this.updateStatus('error', '❌ 転送エラーが発生しました');
        };

        this.dataChannel.onclose = () => {
            console.log('🔌 DataChannel切断');
            this.updateStatus('disconnected', '❌ 接続が切断されました');
        };
    }

    /**
     * PeerConnection設定
     */
    setupPeerConnection() {
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendToServer({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log('🔗 接続状態:', this.pc.connectionState);

            if (this.pc.connectionState === 'connected') {
                this.updateStatus('connected', '🚀 高速転送モード準備完了');
            } else if (this.pc.connectionState === 'disconnected') {
                this.handleDisconnection();
            }
        };

        // 接続品質監視
        this.pc.oniceconnectionstatechange = () => {
            console.log('🧊 ICE接続状態:', this.pc.iceConnectionState);
            this.adjustTransferSpeed();
        };
    }

    /**
     * ファイル送信（V2）
     */
    async sendFile(file) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannelが準備できていません');
        }

        console.log(`🚀 V2ファイル送信開始: ${file.name} (${this.formatFileSize(file.size)})`);

        this.chunkManager = new ChunkManager(file);
        this.chunkManager.startTransfer();
        this.isTransferring = true;
        this.activeSends = 0;

        // 進捗を初期化
        this.updateProgress(0);

        // ファイル情報送信
        await this.sendMessage({
            type: 'file-start-v2',
            filename: file.name,
            filesize: file.size,
            totalMainChunks: this.chunkManager.mainChunks.length,
            totalSubChunks: this.chunkManager.mainChunks.reduce((sum, chunk) => sum + chunk.subChunks.length, 0)
        });

        // メインチャンク転送開始
        await this.startMainChunkTransfer();
    }

    /**
     * メインチャンク転送開始
     */
    async startMainChunkTransfer() {
        while (this.isTransferring && !this.chunkManager.isCompleted()) {
            this.currentMainChunk = this.chunkManager.getNextMainChunk();

            if (!this.currentMainChunk) {
                // 失敗したチャンクの再送
                const retryChunks = this.chunkManager.getRetryList();
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
            await this.sendSubChunksParallel(this.currentMainChunk);

            // メインチャンクのステータスを更新
            this.currentMainChunk.status = 'completed';

            // 進捗更新
            this.updateProgress();

            // 少し待機して次のチャンクへ
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this.chunkManager.isCompleted()) {
            await this.sendMessage({ type: 'transfer-complete' });
            console.log('✅ すべてのチャンク転送完了');
            this.updateStatus('completed', '✅ ファイル転送完了！');
        }

        this.isTransferring = false;
    }

    /**
     * サブチャンクを並列送信
     */
    async sendSubChunksParallel(mainChunk) {
        const subChunks = mainChunk.subChunks;
        const sendPromises = [];

        for (const subChunk of subChunks) {
            // 並列送信数を制御
            while (this.activeSends >= this.maxConcurrentSends) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            const sendPromise = this.sendSubChunk(subChunk);
            sendPromises.push(sendPromise);
            this.activeSends++;
        }

        await Promise.all(sendPromises);
        this.activeSends = 0;
    }

    /**
     * サブチャンク送信
     */
    async sendSubChunk(subChunk) {
        try {
            // チャンクデータ取得
            const chunkData = await this.chunkManager.getChunkData(subChunk);
            const checksum = await this.chunkManager.calculateChecksum(chunkData);

            // バックプレッシャーチェック
            await this.waitForBufferSpace();

            // チャンクデータをBase64エンコード
            const base64Data = this.arrayBufferToBase64(chunkData);

            const chunkMessage = {
                type: 'chunk-data',
                chunkId: subChunk.id,
                mainChunkId: subChunk.mainChunkId,
                size: subChunk.size,
                checksum: checksum,
                data: base64Data
            };

            await this.sendMessage(chunkMessage);

            // チャンクマネージャーに完了を通知
            this.chunkManager.markSubChunkCompleted(subChunk.id, checksum);

            console.log(`📤 サブチャンク送信完了: ${subChunk.id} (${this.formatFileSize(subChunk.size)})`);

            // 進捗更新
            this.updateProgress();

        } catch (error) {
            console.error(`❌ サブチャンク送信失敗: ${subChunk.id}`, error);
            this.chunkManager.markSubChunkFailed(subChunk.id);
        } finally {
            this.activeSends--;
        }
    }

    /**
     * バッファ空き待機
     */
    async waitForBufferSpace() {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannelが準備できていません');
        }

        while (this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD) {
            console.log(`⏳ バッファ待機: ${this.formatFileSize(this.dataChannel.bufferedAmount)}`);
            await new Promise(resolve => setTimeout(resolve, 100));

            // 送信速度調整
            this.adjustTransferSpeed();
        }
    }

    /**
     * データを分割送信
     */
    async sendDataInChunks(arrayBuffer) {
        const totalSize = arrayBuffer.byteLength;
        let offset = 0;

        while (offset < totalSize) {
            const chunkSize = Math.min(this.adaptiveChunkSize, totalSize - offset);
            const chunk = arrayBuffer.slice(offset, offset + chunkSize);

            try {
                this.dataChannel.send(chunk);
                offset += chunkSize;
            } catch (error) {
                if (error.message.includes('send queue is full')) {
                    console.log('⚠️ 送信キュー満杯、待機して再試行');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    await this.waitForBufferSpace();
                    // 再試行（offsetは進めない）
                } else {
                    throw error;
                }
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
    async retryFailedChunks(failedChunks) {
        for (const subChunk of failedChunks) {
            if (subChunk.retryCount <= this.maxRetries) {
                console.log(`🔄 再送試行: ${subChunk.id} (${subChunk.retryCount}/${this.maxRetries})`);
                await this.sendSubChunk(subChunk);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    /**
     * 制御メッセージ送信
     */
    async sendMessage(data) {
        try {
            this.dataChannel.send(JSON.stringify(data));
        } catch (error) {
            console.error('❌ メッセージ送信失敗:', error);
            throw error;
        }
    }

    /**
     * 制御メッセージ受信処理
     */
    async handleControlMessage(data) {
        switch (data.type) {
            case 'file-start-v2':
                await this.handleFileStart(data);
                break;
            case 'chunk-data':
                await this.handleChunkDataMessage(data);
                break;
            case 'chunk-ack':
                // ACK受信処理（送信側）
                console.log('✅ チャンクACK受信:', data.chunkId);
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
    async handleFileStart(data) {
        console.log(`📁 ファイル受信開始: ${data.filename} (${this.formatFileSize(data.filesize)})`);
        console.log(`📊 チャンク情報: ${data.totalMainChunks}メイン, ${data.totalSubChunks}サブ`);

        this.updateStatus('receiving', `📁 ${data.filename} を受信中...`);

        // 受信側チャンクマネージャー初期化
        this.receiveManager = {
            filename: data.filename,
            filesize: data.filesize,
            receivedChunks: new Map(),
            expectedChunks: new Map(),
            completedChunks: new Set(),
            totalReceived: 0,
            totalMainChunks: data.totalMainChunks,
            totalSubChunks: data.totalSubChunks
        };

        this.receiveStartTime = Date.now();
        this.lastBytesReceived = 0;
        this.lastProgressUpdate = Date.now();

        // 初期統計を送信
        this.updateProgress(0);
    }

    /**
     * チャンクデータ受信処理
     */
    async handleChunkDataMessage(data) {
        console.log(`📋 チャンクデータ受信: ${data.chunkId} (${this.formatFileSize(data.size)})`);

        // Base64データをArrayBufferにデコード
        const chunkData = this.base64ToArrayBuffer(data.data);

        // チャンクデータを直接処理
        await this.processChunkData(data.chunkId, data.checksum, chunkData);
    }

    /**
     * チャンクデータ処理
     */
    async processChunkData(chunkId, expectedChecksum, chunkData) {
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
            const sortedChunks = Array.from(this.receiveManager.receivedChunks.entries())
                .sort(([a], [b]) => {
                    // chunkIdを数値として比較
                    const aNum = parseInt(a.split('_sub_')[1]);
                    const bNum = parseInt(b.split('_sub_')[1]);
                    return aNum - bNum;
                });

            // 総ファイルサイズでArrayBufferを確保
            const totalSize = this.receiveManager.filesize;
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
                    name: this.receiveManager.filename,
                    size: this.receiveManager.filesize,
                    data: combinedBuffer
                });
            }

        } catch (error) {
            console.error('❌ ファイル結合エラー:', error);
            this.updateStatus('error', '❌ ファイル結合エラー');
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
    updateProgress(progress = null) {
        // 送信側の統計
        if (this.chunkManager) {
            const stats = this.chunkManager.getStats();
            progress = stats.progress.percentage;

            console.log('📊 送信側統計計算:', {
                progress: progress.toFixed(1) + '%',
                mainChunks: `${stats.mainChunksCompleted}/${stats.totalMainChunks}`,
                subChunks: `${stats.chunksCompleted}/${stats.totalChunks}`,
                failed: stats.failedChunks
            });

            if (this.onStatsUpdate) {
                this.onStatsUpdate(stats);
            }
        }
        // 受信側の統計
        else if (this.receiveManager) {
            const stats = this.getReceiveStats();
            progress = stats.progress.percentage;

            console.log('📊 受信側統計更新:', {
                progress: progress.toFixed(1) + '%',
                mainChunks: `${stats.mainChunksCompleted}/${stats.totalMainChunks}`,
                subChunks: `${stats.chunksCompleted}/${stats.totalChunks}`
            });

            if (this.onStatsUpdate) {
                this.onStatsUpdate(stats);
            }
        }

        if (this.onProgress && progress !== null) {
            this.onProgress(progress);
        }
    }

    /**
     * 受信側統計情報取得
     */
    getReceiveStats() {
        if (!this.receiveManager) {
            return {
                progress: { percentage: 0 },
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
            fileName: this.receiveManager.filename,
            fileSize: this.formatFileSize(this.receiveManager.filesize),
            progress: {
                percentage: progress,
                bytesCompleted: this.receiveManager.totalReceived,
                totalBytes: this.receiveManager.filesize
            },
            chunksCompleted: this.receiveManager.completedChunks.size,
            totalChunks: this.receiveManager.totalSubChunks || Math.ceil(this.receiveManager.filesize / (1024 * 1024)), // 1MB単位で推定
            mainChunksCompleted: receivedMainChunks,
            totalMainChunks: this.receiveManager.totalMainChunks || estimatedMainChunks,
            failedChunks: 0 // 受信側では失敗は再送で解決されるため0
        };
    }

    /**
     * ステータス更新
     */
    updateStatus(state, message) {
        if (this.onStatusChange) {
            this.onStatusChange(state, message);
        }
    }

    /**
     * WebRTC基本メソッド（Offer/Answerなど）
     */
    async createOffer() {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        return offer;
    }

    async createAnswer(offer) {
        await this.pc.setRemoteDescription(offer);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return answer;
    }

    async setRemoteDescription(description) {
        await this.pc.setRemoteDescription(description);
    }

    async addIceCandidate(candidate) {
        await this.pc.addIceCandidate(candidate);
    }

    /**
     * ArrayBufferをBase64に変換
     */
    arrayBufferToBase64(buffer) {
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
    base64ToArrayBuffer(base64) {
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
    async calculateChecksum(buffer) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * ユーティリティ
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * サーバー送信（オーバーライド用）
     */
    sendToServer(_data) {
        // 子クラスで実装
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

// グローバルエクスポート
window.WebRTCManagerV2 = WebRTCManagerV2;