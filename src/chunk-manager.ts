interface MainChunk {
    id: string;
    index: number;
    start: number;
    end: number;
    size: number;
    subChunks: SubChunk[];
    status: 'pending' | 'sending' | 'completed' | 'failed';
    checksum: string | null;
    data: ArrayBuffer | null;
}

interface SubChunk {
    id: string;
    mainChunkId: string;
    start: number;
    end: number;
    size: number;
    status: 'pending' | 'sending' | 'completed' | 'failed';
    data: ArrayBuffer | null;
}

interface Progress {
    percent: number;
    bytesCompleted: number;
    totalBytes: number;
    mainChunksCompleted: number;
    totalMainChunks: number;
    chunksCompleted: number;
    totalChunks: number;
    failedChunks: number;
}

/**
 * 階層チャンクマネージャー
 * 100GBファイル転送用の高度なチャンク管理システム
 */
class ChunkManager {
    public fileName: string;
    public fileSize: number;
    public totalMainChunks: number = 0;

    private MAIN_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
    private SUB_CHUNK_SIZE = 1 * 1024 * 1024;    // 1MB

    public mainChunks: MainChunk[] = [];
    private completedSubChunks = new Set<string>();
    private failedSubChunks = new Set<string>();

    constructor(fileName: string, fileSize: number) {
        this.fileName = fileName;
        this.fileSize = fileSize;
        this.init();
    }

    /**
     * チャンク初期化
     */
    private init(): void {
        const totalSize = this.fileSize;
        const mainChunkCount = Math.ceil(totalSize / this.MAIN_CHUNK_SIZE);
        this.totalMainChunks = mainChunkCount;

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
                status: 'pending',
                checksum: null,
                data: null
            };

            // サブチャンク作成
            const subChunkCount = Math.ceil(mainChunk.size / this.SUB_CHUNK_SIZE);
            for (let j = 0; j < subChunkCount; j++) {
                const subStart = start + (j * this.SUB_CHUNK_SIZE);
                const subEnd = Math.min(subStart + this.SUB_CHUNK_SIZE, end);

                const subChunk: SubChunk = {
                    id: `sub_${i}_${j}`,
                    mainChunkId: mainChunk.id,
                    start: subStart,
                    end: subEnd,
                    size: subEnd - subStart,
                    status: 'pending',
                    data: null
                };

                mainChunk.subChunks.push(subChunk);
            }

            this.mainChunks.push(mainChunk);
        }
    }

    /**
     * メインチャンク作成（ファイルデータから）
     */
    public createMainChunks(fileData: ArrayBuffer): void {
        console.log('📦 メインチャンク作成開始');

        for (const mainChunk of this.mainChunks) {
            const start = mainChunk.start;
            const end = mainChunk.end;
            mainChunk.data = fileData.slice(start, end);

            console.log(`📦 メインチャンク ${mainChunk.id}: ${this.formatFileSize(mainChunk.size)}`);
        }

        console.log(`✅ メインチャンク作成完了: ${this.mainChunks.length}個`);
    }

    /**
     * メインチャンクID取得
     */
    public getMainChunkIds(): string[] {
        return this.mainChunks.map(mc => mc.id);
    }

    /**
     * サブチャンク取得
     */
    public getSubChunks(mainChunkId: string): SubChunk[] {
        const mainChunk = this.mainChunks.find(mc => mc.id === mainChunkId);
        return mainChunk ? mainChunk.subChunks : [];
    }

    /**
     * サブチャンク受信
     */
    public receiveSubChunk(mainChunkId: string, subChunkId: string, data: ArrayBuffer): void {
        const mainChunk = this.mainChunks.find(mc => mc.id === mainChunkId);
        if (!mainChunk) return;

        const subChunk = mainChunk.subChunks.find(sc => sc.id === subChunkId);
        if (!subChunk) return;

        subChunk.data = data;
        subChunk.status = 'completed';

        const key = `${mainChunkId}-${subChunkId}`;
        this.completedSubChunks.add(key);
        this.failedSubChunks.delete(key);

        // メインチャンクの完了チェック
        this.checkMainChunkCompletion(mainChunk);
    }

    /**
     * サブチャンク完了マーク
     */
    public markSubChunkCompleted(mainChunkId: string, subChunkId: string): void {
        const mainChunk = this.mainChunks.find(mc => mc.id === mainChunkId);
        if (!mainChunk) return;

        const subChunk = mainChunk.subChunks.find(sc => sc.id === subChunkId);
        if (!subChunk) return;

        subChunk.status = 'completed';
        const key = `${mainChunkId}-${subChunkId}`;
        this.completedSubChunks.add(key);
        this.failedSubChunks.delete(key);

        this.checkMainChunkCompletion(mainChunk);
    }

    /**
     * メインチャンク完了チェック
     */
    private checkMainChunkCompletion(mainChunk: MainChunk): void {
        const allSubChunksCompleted = mainChunk.subChunks.every(sc => sc.status === 'completed');

        if (allSubChunksCompleted) {
            mainChunk.status = 'completed';

            // メインチャンクデータ組み立て
            const subChunksSorted = mainChunk.subChunks.sort((a, b) => a.start - b.start);
            const totalSize = subChunksSorted.reduce((sum, sc) => sum + sc.size, 0);
            const combinedData = new Uint8Array(totalSize);

            let offset = 0;
            for (const subChunk of subChunksSorted) {
                if (subChunk.data) {
                    combinedData.set(new Uint8Array(subChunk.data), offset);
                    offset += subChunk.size;
                }
            }

            mainChunk.data = combinedData.buffer;
            mainChunk.checksum = this.calculateChecksum(mainChunk.data);

            console.log(`✅ メインチャンク ${mainChunk.id} 完了`);
        }
    }

    /**
     * 進捗取得
     */
    public getProgress(): Progress {
        const totalSubChunks = this.mainChunks.reduce((sum, mc) => sum + mc.subChunks.length, 0);
        const completedSubChunks = this.completedSubChunks.size;
        const completedMainChunks = this.mainChunks.filter(mc => mc.status === 'completed').length;

        const bytesCompleted = this.mainChunks.reduce((sum, mc) => {
            if (mc.status === 'completed') return sum + mc.size;

            const mcBytesCompleted = mc.subChunks
                .filter(sc => sc.status === 'completed')
                .reduce((sum, sc) => sum + sc.size, 0);
            return sum + mcBytesCompleted;
        }, 0);

        const percent = this.fileSize > 0 ? (bytesCompleted / this.fileSize) * 100 : 0;

        return {
            percent,
            bytesCompleted,
            totalBytes: this.fileSize,
            mainChunksCompleted: completedMainChunks,
            totalMainChunks: this.mainChunks.length,
            chunksCompleted: completedSubChunks,
            totalChunks: totalSubChunks,
            failedChunks: this.failedSubChunks.size
        };
    }

    /**
     * 完全なファイルデータ取得
     */
    public getAssembledFile(): ArrayBuffer | null {
        const allMainChunksCompleted = this.mainChunks.every(mc => mc.status === 'completed');

        if (!allMainChunksCompleted) {
            console.warn('⚠️  全てのメインチャンクが完了していません');
            return null;
        }

        // メインチャンクを正しい順序で結合
        const sortedMainChunks = this.mainChunks.sort((a, b) => a.start - b.start);
        const totalSize = sortedMainChunks.reduce((sum, mc) => sum + mc.size, 0);
        const fileData = new Uint8Array(totalSize);

        let offset = 0;
        for (const mainChunk of sortedMainChunks) {
            if (mainChunk.data) {
                fileData.set(new Uint8Array(mainChunk.data), offset);
                offset += mainChunk.size;
            }
        }

        // チェックサム検証
        const actualChecksum = this.calculateChecksum(fileData.buffer);
        console.log(`🔍 ファイルチェックサム: ${actualChecksum}`);

        return fileData.buffer;
    }

    /**
     * チェックサム計算
     */
    private calculateChecksum(data: ArrayBuffer): string {
        const hash = new Uint8Array(data).reduce((acc, val) => acc + val, 0);
        return hash.toString(16).padStart(8, '0');
    }

    /**
     * ファイルサイズ整形
     */
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * 再送試行
     */
    public retryFailedChunks(): void {
        const failedChunks = Array.from(this.failedSubChunks);

        for (const chunkKey of failedChunks) {
            const [mainChunkId, subChunkId] = chunkKey.split('-');

            const mainChunk = this.mainChunks.find(mc => mc.id === mainChunkId);
            if (!mainChunk) continue;

            const subChunk = mainChunk.subChunks.find(sc => sc.id === subChunkId);
            if (!subChunk) continue;

            subChunk.status = 'pending';
            this.failedSubChunks.delete(chunkKey);

            console.log(`🔄 再送準備: ${chunkKey}`);
        }
    }

    /**
     * 統計情報取得
     */
    public getStats(): any {
        const progress = this.getProgress();
        return {
            ...progress,
            fileName: this.fileName,
            totalMainChunks: this.totalMainChunks,
            retryQueue: this.failedSubChunks.size,
            memoryUsage: this.estimateMemoryUsage()
        };
    }

    /**
     * メモリ使用量推定
     */
    private estimateMemoryUsage(): number {
        let totalBytes = 0;

        for (const mainChunk of this.mainChunks) {
            if (mainChunk.data) {
                totalBytes += mainChunk.size;
            }

            for (const subChunk of mainChunk.subChunks) {
                if (subChunk.data) {
                    totalBytes += subChunk.size;
                }
            }
        }

        return totalBytes;
    }
}

// グローバル登録
(window as any).ChunkManager = ChunkManager;

export default ChunkManager;