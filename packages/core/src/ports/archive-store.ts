export interface ArchiveReceipt {
  readonly key: string;
  readonly format: 'txt' | 'json';
  readonly digest: string;
  readonly bytes: number;
}

export interface ArchiveContent {
  readonly body: ReadableStream | Uint8Array;
  readonly format: 'txt' | 'json';
  readonly digest: string;
}

export interface ArchiveStore {
  put(archive: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly format: 'txt' | 'json';
    readonly digest: string;
  }): Promise<ArchiveReceipt>;
  head(receipt: ArchiveReceipt): Promise<boolean>;
  read(receipt: ArchiveReceipt): Promise<ArchiveContent | null>;
  remove(key: string): Promise<boolean>;
}
