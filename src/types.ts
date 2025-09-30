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

declare global {
    interface Window {
        WebRTCManagerV2: any;
    }
}