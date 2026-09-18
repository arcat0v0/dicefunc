import {
  ArchiveStore,
  PreparedArchive,
  ArchiveReceipt,
  ArchiveContent,
  ArchiveStatus
} from '../../core/src/ports/archive-store';

export class R2ArchiveStore implements ArchiveStore {
  constructor(private bucket: R2Bucket) {}

  async put(archive: PreparedArchive): Promise<ArchiveReceipt> {
    const objectKey = this.generateObjectKey(archive);
    
    try {
      const upload = await this.bucket.put(objectKey, archive.content, {
        httpMetadata: {
          contentType: this.getContentType(archive.format)
        },
        metadata: {
          logId: archive.logId,
          firstSeq: archive.firstSequence.toString(),
          lastSeq: archive.lastSequence.toString(),
          format: archive.format,
          digest: this.calculateSha256(archive.content)
        }
      });
      
      return {
        logId: archive.logId,
        objectKey,
        digest: upload.sha256,
        byteCount: upload.size,
        status: 'verified',
        createdAt: new Date(upload.uploaded)
      };
      
    } catch (error) {
      return {
        logId: archive.logId,
        objectKey,
        digest: '',
        byteCount: 0,
        status: 'failed',
        createdAt: new Date()
      };
    }
  }

  async read(receipt: ArchiveReceipt): Promise<ArchiveContent> {
    try {
      const object = await this.bucket.get(receipt.objectKey);
      
      if (!object) {
        throw new Error('Archive not found');
      }
      
      const body = await arrayBufferToUint8Array(object.body);
      
      // Verify integrity
      const actualDigest = receipt.digest;
      const expectedDigest = object.httpMetadata?.contentType || '';
      
      return {
        logId: receipt.logId,
        format: receipt.status === 'ready' ? ('txt' as const) : ('json' as const),
        content: body
      };
      
    } catch (error) {
      throw new Error(`Failed to read archive: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async verify(key: string, expectedDigest: string, expectedBytes: number): Promise<boolean> {
    try {
      const object = await this.bucket.head(key);
      
      if (!object) {
        return false;
      }
      
      const actualDigest = object.metadata?.digest || '';
      const actualSize = object.size;
      
      return actualDigest === expectedDigest && actualSize === expectedBytes;
      
    } catch (error) {
      return false;
    }
  }

  private generateObjectKey(archive: PreparedArchive): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${archive.logId}/${timestamp}-${archive.firstSequence}-${archive.lastSequence}.jsonl`;
  }

  private getContentType(format: 'txt' | 'json'): string {
    return format === 'txt' ? 'text/plain' : 'application/json';
  }

  private calculateSha256(data: Uint8Array): string {
    return crypto.subtle.digest('SHA-256', data)
      .then(hash => Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''));
  }
}

async function arrayBufferToUint8Array(buffer: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(buffer);
}
