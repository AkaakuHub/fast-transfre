/**
 * 共通型定義
 * Fast Transfer V2 用の型定義
 */

export interface FileInfo {
    name: string;
    size: number;
    data: ArrayBuffer;
}

export interface TransferStats {
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

export type ControlMessage = {
    type: 'file-start-v2';
    filename: string;
    filesize: number;
    totalMainChunks: number;
    totalSubChunks: number;
} | {
    type: 'chunk-data';
    chunkId: string;
    mainChunkId: string;
    size: number;
    checksum: string;
    data: string;
} | {
    type: 'chunk-ack';
    chunkId: string;
    success: boolean;
} | {
    type: 'transfer-complete';
} | {
    type: 'retry-request';
    chunkId: string;
};

export interface MainChunk {
    id: string;
    index: number;
    start: number;
    end: number;
    size: number;
    subChunks: SubChunk[];
    status: 'pending' | 'sending' | 'completed' | 'failed';
    checksum: string | null;
}

export interface SubChunk {
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

export interface ChunkManager {
    file: File;
    mainChunks: MainChunk[];
    completedSubChunks: Set<string>;
    failedSubChunks: Set<string>;
    startTime: number;
    MAIN_CHUNK_SIZE: number;
    SUB_CHUNK_SIZE: number;

    startTransfer(): void;
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
        failedChunks: number;
    };
    isCompleted(): boolean;
    getRetryList(): SubChunk[];
    findSubChunk(subChunkId: string): SubChunk | null;
    getChunkData(chunk: SubChunk): Promise<ArrayBuffer>;
    calculateChecksum(buffer: ArrayBuffer): Promise<string>;
    formatFileSize(bytes: number): string;
    getStats(): {
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
    };
}

declare global {
    interface Window {
        WebRTCManagerV2: any;
        ChunkManager: {
            new(file: File): ChunkManager;
        };
    }
}