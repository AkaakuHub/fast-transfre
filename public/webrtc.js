class WebRTCManager {
    constructor() {
        this.pc = null;
        this.dataChannel = null;
        this.onStatusChange = null;
        this.onProgress = null;
        this.onFileReceived = null;
        this.onConnected = null;
        this.onDisconnected = null;
    }

    // WebRTC接続初期化
    init(isHost = false) {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        this.pc = new RTCPeerConnection(config);

        if (isHost) {
            // ホスト側: DataChannelを作成
            this.dataChannel = this.pc.createDataChannel('fileTransfer');
            this.setupDataChannel();
        } else {
            // クライアント側: DataChannelを受け取る
            this.pc.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };
        }

        // ICE Candidateイベント
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendToServer({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        // 接続状態変更
        this.pc.onconnectionstatechange = () => {
            if (this.onStatusChange) {
                this.onStatusChange(this.pc.connectionState);
            }

            if (this.pc.connectionState === 'connected') {
                this.updateStatus('connected', '✅ P2P接続確立');
                if (this.onConnected) {
                    this.onConnected();
                }
            } else if (this.pc.connectionState === 'disconnected') {
                this.updateStatus('disconnected', '❌ 接続切断');
                if (this.onDisconnected) {
                    this.onDisconnected();
                }
            }
        };
    }

    // DataChannel設定
    setupDataChannel() {
        // バイナリタイプをArrayBufferに設定
        this.dataChannel.binaryType = 'arraybuffer';

        this.dataChannel.onopen = () => {
            console.log('DataChannel開通');
        };

        this.dataChannel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'file-start') {
                    this.receiveFile(data);
                    console.log('📁 ファイル受信開始:', data.filename);
                }
            } catch (e) {
                // バイナリデータ（ArrayBuffer）の場合
                if (this.fileReceivingData && event.data instanceof ArrayBuffer) {
                    // 二重受信防止チェック
                    if (this.fileReceivingData.receivedBytes >= this.fileReceivingData.filesize) {
                        console.log('⚠️ すでに受信完了済みのため、メッセージを無視します');
                        return;
                    }

                    this.fileReceivingData.chunks.push(event.data);
                    this.fileReceivingData.receivedBytes += event.data.byteLength;

                    // ログを先に記録
                    // const currentBytes = this.fileReceivingData.receivedBytes;
                    // const totalBytes = this.fileReceivingData.filesize;
                    // console.log(`📊 進捗: ${currentBytes}/${totalBytes} bytes`);

                    // 進捗更新（完了する可能性あり）
                    this.updateFileProgress();
                }
            }
        };

        this.dataChannel.onclose = () => {
            console.log('DataChannel切断');
            // 切断時に受信データをクリア
            this.fileReceivingData = null;
        };
    }

    // Offer作成（ホスト側）
    async createOffer() {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        return offer;
    }

    // Answer作成（クライアント側）
    async createAnswer(offer) {
        await this.pc.setRemoteDescription(offer);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return answer;
    }

    // リモート記述設定
    async setRemoteDescription(description) {
        await this.pc.setRemoteDescription(description);
    }

    // ICE Candidate追加
    async addIceCandidate(candidate) {
        await this.pc.addIceCandidate(candidate);
    }

    // ファイル送信
    async sendFile(file) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('DataChannelが準備できていません');
        }

        const chunkSize = 16384; // 16KBに減らす
        let offset = 0;

        console.log(`📤 ファイル送信開始: ${file.name} (${file.size} bytes)`);

        // ファイル情報送信
        this.dataChannel.send(JSON.stringify({
            type: 'file-start',
            filename: file.name,
            filesize: file.size
        }));

        // チャンク送信
        while (offset < file.size) {
            // 送信キューが空くまで待機
            while (this.dataChannel.bufferedAmount > 0) {
                console.log(`⏳ 送信キュー待機: ${this.dataChannel.bufferedAmount} bytes`);
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            const chunk = file.slice(offset, offset + chunkSize);
            const arrayBuffer = await chunk.arrayBuffer();

            try {
                this.dataChannel.send(arrayBuffer);
                offset += arrayBuffer.byteLength;

                // 進捗更新
                const progress = (offset / file.size) * 100;
                if (this.onProgress) {
                    this.onProgress(progress);
                }

                console.log(`📤 送信進捗: ${offset}/${file.size} bytes (${progress.toFixed(1)}%)`);

                // 適度な待機時間
                await new Promise(resolve => setTimeout(resolve, 5));
            } catch (error) {
                if (error.message.includes('send queue is full')) {
                    console.log('⚠️ 送信キュー満杯、少し待機して再試行');
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue; // 同じチャンクを再試行
                } else {
                    throw error;
                }
            }
        }

        console.log('✅ ファイル送信完了');
    }

    // ファイル受信開始
    receiveFile(fileInfo) {
        this.fileReceivingData = {
            filename: fileInfo.filename,
            filesize: fileInfo.filesize,
            chunks: [],
            receivedBytes: 0
        };

        console.log(`📁 ファイル受信開始: ${fileInfo.filename} (${fileInfo.filesize} bytes)`);
    }

    // ファイルチャンク処理
    handleFileChunk(chunkData) {
        // バイナリチャンクは直接onmessageで処理
    }

    // ファイル進捗更新
    updateFileProgress() {
        if (!this.fileReceivingData) return;

        const progress = (this.fileReceivingData.receivedBytes / this.fileReceivingData.filesize) * 100;

        if (this.onProgress) {
            this.onProgress(progress);
        }

        // 完了チェック
        if (this.fileReceivingData.receivedBytes >= this.fileReceivingData.filesize) {
            console.log('✅ ファイル受信完了');
            this.completeFileReception();
        }
    }

    // ファイル受信完了
    completeFileReception() {
        if (!this.fileReceivingData) return;

        const blob = new Blob(this.fileReceivingData.chunks);
        const file = new File([blob], this.fileReceivingData.filename, {
            type: 'application/octet-stream'
        });

        // コールバックを呼び出す前にデータをクリア
        const fileData = this.fileReceivingData;
        this.fileReceivingData = null;

        if (this.onFileReceived) {
            this.onFileReceived(file);
        }

        console.log(`✅ ${fileData.filename} の処理完了`);
    }

    // ステータス更新
    updateStatus(state, message) {
        if (this.onStatusChange) {
            this.onStatusChange(state, message);
        }
    }

    // サーバーへの送信（オーバーライド用）
    sendToServer(data) {
        // 子クラスで実装
    }

    // クリーンアップ
    destroy() {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.pc) {
            this.pc.close();
        }
    }
}