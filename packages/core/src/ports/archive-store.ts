export interface PreparedArchive {
  readonly logId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly format: ArchiveFormat;
  readonly content: Uint8Array;
  readonly manifest?: ArchiveManifest;
}

export type ArchiveFormat = 'txt' | 'json';

export interface ArchiveManifest {
  readonly schemaVersion: number;
  readonly captureMode: CaptureMode;
  readonly entryCount: number;
  readonly cursor: number;
  readonly createdAt: Date;
  readonly gaps?: number[];
}

export type CaptureMode = 'all' | 'at_only';

export interface ArchiveReceipt {
  readonly logId: string;
  readonly objectKey: string;
  readonly digest: string;
  readonly byteCount: number;
  readonly status: ArchiveStatus;
  readonly createdAt: Date;
}

export type ArchiveStatus = 'pending' | 'uploading' | 'verified' | 'ready' | 'failed' | 'deleting' | 'deleted';

export interface ArchiveContent {
  readonly logId: string;
  readonly format: ArchiveFormat;
  readonly content: Uint8Array;
  readonly manifest?: ArchiveManifest;
}

export interface ArchiveStore {
  put(archive: PreparedArchive): Promise<ArchiveReceipt>;
  read(receipt: ArchiveReceipt): Promise<ArchiveContent>;
  verify(key: string, expectedDigest: string, expectedBytes: number): Promise<boolean>;
}
