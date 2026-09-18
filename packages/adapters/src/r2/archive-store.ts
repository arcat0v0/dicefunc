import type { ArchiveContent, ArchiveReceipt, ArchiveStore } from '@dicefunc/core';

export class R2ArchiveStore implements ArchiveStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(archive: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly format: 'txt' | 'json';
    readonly digest: string;
  }): Promise<ArchiveReceipt> {
    const contentType =
      archive.format === 'txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    await this.bucket.put(archive.key, archive.body, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        format: archive.format,
        digest: archive.digest,
        bytes: String(archive.body.byteLength),
      },
    });

    const headObj = await this.bucket.head(archive.key);
    if (headObj === null) {
      throw new Error(`R2 put verification failed: object not found for key ${archive.key}`);
    }

    const recordedDigest = headObj.customMetadata?.digest;
    if (headObj.size !== archive.body.byteLength || recordedDigest !== archive.digest) {
      throw new Error(`R2 put verification failed: size or digest mismatch for key ${archive.key}`);
    }

    return {
      key: archive.key,
      format: archive.format,
      digest: archive.digest,
      bytes: headObj.size,
    };
  }

  async head(receipt: ArchiveReceipt): Promise<boolean> {
    const headObj = await this.bucket.head(receipt.key);
    if (headObj === null) {
      return false;
    }

    const recordedDigest = headObj.customMetadata?.digest;
    return headObj.size === receipt.bytes && recordedDigest === receipt.digest;
  }

  async read(receipt: ArchiveReceipt): Promise<ArchiveContent | null> {
    const obj = await this.bucket.get(receipt.key);
    if (obj === null) {
      return null;
    }

    const recordedDigest = obj.customMetadata?.digest;
    if (obj.size !== receipt.bytes || recordedDigest !== receipt.digest) {
      await obj.body.cancel();
      return null;
    }

    const recordedFormat = obj.customMetadata?.format;
    const format: 'txt' | 'json' =
      recordedFormat === 'txt' || recordedFormat === 'json' ? recordedFormat : receipt.format;

    return {
      body: obj.body,
      format,
      digest: recordedDigest,
    };
  }

  async remove(key: string): Promise<boolean> {
    const headObj = await this.bucket.head(key);
    if (headObj === null) {
      return false;
    }

    await this.bucket.delete(key);
    return true;
  }
}
