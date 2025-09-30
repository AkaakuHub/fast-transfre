/**
 * 階層チャンクマネージャー
 * 100GBファイル転送用の高度なチャンク管理システム
 */
import type { MainChunk, SubChunk } from './types.js';

class ChunkManager {
    public file: File;
    public MAIN_CHUNK_SIZE: number = 50 * 1024 * 1024; // 50MB
    public SUB_CHUNK_SIZE: number = 1 * 1024 * 1024;    // 1MB
    public mainChunks: MainChunk[] = [];
    public completedSubChunks: Set<string> = new Set();
    public failedSubChunks: Set<string> = new Set();
    public startTime: number = 0;

    constructor(file: File) {
        this.file = file;
        this.init();
    }

    /**
     * チャンク初期化
     */
    init(): void {
        const totalSize = this.file.size;
        const mainChunkCount = Math.ceil(totalSize / this.MAIN_CHUNK_SIZE);

        console.log(`📁 ファイル解析: ${this.formatFileSize(totalSize)}`);
        console.log(`📦 メインチャンク数: ${mainChunkCount} (50MB each)`);
        console.log(`🔲 サブチャンク数: 約${Math.ceil(totalSize / this.SUB_CHUNK_SIZE)} (1MB each)`);

        // メインチャンク作成
        for (let i = 0; i < mainChunkCount; i++) {
            const start = i * this.MAIN_CHUNK_SIZE;
            const end = Math.min(start + this.MAIN_CHUNK_SIZE, totalSize);

            const mainChunk: MainChunk = {
                id: `main_${i}`,
                index: i,
                start: start,
                end: end,
                size: end - start,
                subChunks: [],
                status: 'pending' as const,
                checksum: null
            };

            // サブチャンク作成
            const subChunkCount = Math.ceil(mainChunk.size / this.SUB_CHUNK_SIZE);
            for (let j = 0; j < subChunkCount; j++) {
                const subStart = start + (j * this.SUB_CHUNK_SIZE);
                const subEnd = Math.min(subStart + this.SUB_CHUNK_SIZE, end);

                const subChunk: SubChunk = {
                    id: `${mainChunk.id}_sub_${j}`,
                    mainChunkId: mainChunk.id,
                    index: j,
                    start: subStart,
                    end: subEnd,
                    size: subEnd - subStart,
                    status: 'pending' as const,
                    checksum: null,
                    retryCount: 0
                };

                mainChunk.subChunks.push(subChunk);
            }

            this.mainChunks.push(mainChunk);
        }
    }

    /**
     * 次の送信するメインチャンクを取得
     */
    getNextMainChunk(): MainChunk | null {
        return this.mainChunks.find(chunk => chunk.status === 'pending') || null;
    }

    /**
     * メインチャンクのサブチャンクを取得
     */
    getSubChunks(mainChunkId: string): SubChunk[] {
        const mainChunk = this.mainChunks.find(chunk => chunk.id === mainChunkId);
        return mainChunk ? mainChunk.subChunks : [];
    }

    /**
     * 次の送信するサブチャンクを取得
     */
    getNextSubChunk(mainChunkId: string): SubChunk | null {
        const subChunks = this.getSubChunks(mainChunkId);
        return subChunks.find(chunk => chunk.status === 'pending' && !this.failedSubChunks.has(chunk.id)) || null;
    }

    /**
     * サブチャンク完了を記録
     */
    markSubChunkCompleted(subChunkId: string, checksum: string): void {
        this.completedSubChunks.add(subChunkId);
        this.failedSubChunks.delete(subChunkId);

        // サブチャンクを更新
        for (const mainChunk of this.mainChunks) {
            const subChunk = mainChunk.subChunks.find(sc => sc.id === subChunkId);
            if (subChunk) {
                subChunk.status = 'completed';
                subChunk.checksum = checksum;
                break;
            }
        }

        // メインチャンクの完了チェック
        this.updateMainChunkStatus();
    }

    /**
     * サブチャンク失敗を記録
     */
    markSubChunkFailed(subChunkId: string): void {
        this.failedSubChunks.add(subChunkId);

        const subChunk = this.findSubChunk(subChunkId);
        if (subChunk) {
            subChunk.retryCount++;
            if (subChunk.retryCount > 3) {
                subChunk.status = 'failed';
                console.error(`❌ サブチャンク ${subChunkId} が3回失敗しました`);
            }
        }
    }

    /**
     * メインチャンクのステータスを更新
     */
    updateMainChunkStatus() {
        for (const mainChunk of this.mainChunks) {
            const completedSubs = mainChunk.subChunks.filter(sc => sc.status === 'completed').length;
            const totalSubs = mainChunk.subChunks.length;

            if (completedSubs === totalSubs && totalSubs > 0) {
                mainChunk.status = 'completed';
                console.log(`✅ メインチャンク ${mainChunk.id} 完了 (${completedSubs}/${totalSubs})`);
            } else if (completedSubs > 0) {
                mainChunk.status = 'sending';
            }
        }
    }

    /**
     * 転送進捗を取得
     */
    getProgress() {
        const totalSubChunks = this.mainChunks.reduce((sum, chunk) => sum + chunk.subChunks.length, 0);
        const completedSubChunks = this.completedSubChunks.size;

        const totalBytes = this.file.size;
        const completedBytes = this.mainChunks.reduce((sum, chunk) => {
            const completedSubs = chunk.subChunks.filter(sc => sc.status === 'completed');
            return sum + completedSubs.reduce((subSum, sub) => subSum + sub.size, 0);
        }, 0);

        return {
            percentage: (completedSubChunks / totalSubChunks) * 100,
            bytesCompleted: completedBytes,
            totalBytes: totalBytes,
            chunksCompleted: completedSubChunks,
            totalChunks: totalSubChunks,
            mainChunksCompleted: this.mainChunks.filter(c => c.status === 'completed').length,
            totalMainChunks: this.mainChunks.length
        };
    }

    /**
     * 転送が完了したかチェック
     */
    isCompleted() {
        return this.mainChunks.every(chunk => chunk.status === 'completed');
    }

    /**
     * 失敗したサブチャンクの再送リストを取得
     */
    getRetryList() {
        const retryList = [];
        for (const mainChunk of this.mainChunks) {
            const failedSubs = mainChunk.subChunks.filter(sc =>
                this.failedSubChunks.has(sc.id) && sc.retryCount <= 3
            );
            retryList.push(...failedSubs);
        }
        return retryList;
    }

    /**
     * サブチャンクを検索
     */
    findSubChunk(subChunkId: string): SubChunk | null {
        for (const mainChunk of this.mainChunks) {
            const subChunk = mainChunk.subChunks.find(sc => sc.id === subChunkId);
            if (subChunk) return subChunk;
        }
        return null;
    }

    /**
     * チャンクデータを取得（ArrayBuffer形式）
     */
    async getChunkData(chunk: SubChunk): Promise<ArrayBuffer> {
        const fileSlice = this.file.slice(chunk.start, chunk.end);
        return await fileSlice.arrayBuffer();
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
     * ファイルサイズを整形
     */
    formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * 転送統計情報を取得
     */
    getStats() {
        const progress = this.getProgress();
        const failedChunks = this.getRetryList().length;

        return {
            fileName: this.file.name,
            fileSize: this.formatFileSize(this.file.size),
            progress: progress,
            chunksCompleted: progress.chunksCompleted,
            totalChunks: progress.totalChunks,
            mainChunksCompleted: progress.mainChunksCompleted,
            totalMainChunks: progress.totalMainChunks,
            failedChunks: failedChunks,
            estimatedTimeRemaining: this.calculateETA(progress)
        };
    }

    /**
     * 推定残り時間を計算
     */
    calculateETA(progress: { percentage: number }): string {
        // 簡易的なETA計算（実際には転送速度の履歴から計算する方が良い）
        if (progress.percentage === 0) return '計算中...';

        const remainingPercentage = 100 - progress.percentage;
        const estimatedSeconds = (remainingPercentage / progress.percentage) *
                                  (Date.now() - this.startTime) / 1000;

        if (estimatedSeconds < 60) return `${Math.round(estimatedSeconds)}秒`;
        if (estimatedSeconds < 3600) return `${Math.round(estimatedSeconds / 60)}分`;
        return `${Math.round(estimatedSeconds / 3600)}時間`;
    }

    /**
     * 転送開始時間を記録
     */
    startTransfer(): void {
        this.startTime = Date.now();
    }
}

// グローバルエクスポート
(window as any).ChunkManager = ChunkManager;