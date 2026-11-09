import { webcrypto } from 'node:crypto';

const textEncoder = new TextEncoder();

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

interface SunoAudioKeys {
  contentKey: CryptoKey;
  contentIv: Uint8Array;
}

async function unwrapSunoAudioKeys(
  wrappedKey: string,
  wrappedIv: string,
  clipId: string,
  sessionToken: string
): Promise<SunoAudioKeys> {
  const userKeyBytes = new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', textEncoder.encode(sessionToken))
  );
  const userKey = await webcrypto.subtle.importKey(
    'raw',
    userKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const unwrap = async (wrapped: string): Promise<ArrayBuffer> => {
    const value = decodeBase64(wrapped);
    if (value.byteLength <= 12) throw new Error('Suno license value is invalid');
    return webcrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: value.subarray(0, 12),
        additionalData: textEncoder.encode(clipId)
      },
      userKey,
      value.subarray(12)
    );
  };

  const contentKey = await webcrypto.subtle.importKey(
    'raw',
    await unwrap(wrappedKey),
    { name: 'AES-CTR' },
    false,
    ['decrypt']
  );
  const contentIv = new Uint8Array(await unwrap(wrappedIv));
  if (contentIv.byteLength !== 16) throw new Error('Suno license IV is invalid');
  return { contentKey, contentIv };
}

function advanceCounter(initial: Uint8Array, blocks: number): Uint8Array {
  const counter = new Uint8Array(initial);
  let carry = BigInt(blocks);
  for (let index = counter.length - 1; index >= 0 && carry > 0; index -= 1) {
    const sum = BigInt(counter[index]) + (carry & 0xffn);
    counter[index] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return counter;
}

/**
 * Suno's `media_urls` entries with an `encoding` field are AES-CTR media.
 * The media key and IV are wrapped with AES-GCM by /api/mango/rights.
 */
export async function decryptSunoAudio(
  encryptedMedia: Uint8Array,
  wrappedKey: string,
  wrappedIv: string,
  clipId: string,
  sessionToken: string
): Promise<Buffer> {
  const { contentKey, contentIv } = await unwrapSunoAudioKeys(
    wrappedKey,
    wrappedIv,
    clipId,
    sessionToken
  );

  const decoded = await webcrypto.subtle.decrypt(
    { name: 'AES-CTR', counter: contentIv, length: 128 },
    contentKey,
    encryptedMedia
  );
  return Buffer.from(decoded);
}

export async function decryptSunoAudioStream(
  encryptedMedia: ReadableStream<Uint8Array>,
  wrappedKey: string,
  wrappedIv: string,
  clipId: string,
  sessionToken: string
): Promise<ReadableStream<Uint8Array>> {
  const { contentKey, contentIv } = await unwrapSunoAudioKeys(
    wrappedKey,
    wrappedIv,
    clipId,
    sessionToken
  );
  let remainder = new Uint8Array(0);
  let blockOffset = 0;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const combined = new Uint8Array(remainder.byteLength + chunk.byteLength);
      combined.set(remainder);
      combined.set(chunk, remainder.byteLength);
      const alignedLength = combined.byteLength - (combined.byteLength % 16);
      if (alignedLength > 0) {
        const decoded = await webcrypto.subtle.decrypt(
          {
            name: 'AES-CTR',
            counter: advanceCounter(contentIv, blockOffset),
            length: 128
          },
          contentKey,
          combined.slice(0, alignedLength)
        );
        controller.enqueue(new Uint8Array(decoded));
        blockOffset += alignedLength / 16;
      }
      remainder = combined.slice(alignedLength);
    },
    async flush(controller) {
      if (remainder.byteLength === 0) return;
      const decoded = await webcrypto.subtle.decrypt(
        {
          name: 'AES-CTR',
          counter: advanceCounter(contentIv, blockOffset),
          length: 128
        },
        contentKey,
        remainder
      );
      controller.enqueue(new Uint8Array(decoded));
    }
  });
  return encryptedMedia.pipeThrough(transform);
}

export function audioContentType(bytes: Uint8Array, fallback = 'audio/mp4'): string {
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  if (bytes.byteLength >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    return 'audio/mp4';
  }
  return fallback;
}
