import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { audioContentType, decryptSunoAudio, decryptSunoAudioStream } from './sunoAudio';

async function createEncryptedFixture(plaintext: Uint8Array) {
  const clipId = 'clip-test';
  const sessionToken = 'session-token-test';
  const contentKeyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const contentIv = webcrypto.getRandomValues(new Uint8Array(16));
  const contentKey = await webcrypto.subtle.importKey('raw', contentKeyBytes, { name: 'AES-CTR' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-CTR', counter: contentIv, length: 128 },
    contentKey,
    plaintext
  ));

  const userKeyBytes = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionToken)));
  const userKey = await webcrypto.subtle.importKey('raw', userKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const wrap = async (value: Uint8Array): Promise<string> => {
    const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv, additionalData: new TextEncoder().encode(clipId) },
      userKey,
      value
    ));
    return Buffer.concat([Buffer.from(wrapIv), Buffer.from(wrapped)]).toString('base64');
  };

  return {
    clipId,
    sessionToken,
    encrypted,
    wrappedKey: await wrap(contentKeyBytes),
    wrappedIv: await wrap(contentIv)
  };
}

test('decrypts Suno wrapped AES-CTR media', async () => {
  const plaintext = Buffer.from('decoded audio payload');
  const fixture = await createEncryptedFixture(plaintext);

  const decoded = await decryptSunoAudio(
    fixture.encrypted,
    fixture.wrappedKey,
    fixture.wrappedIv,
    fixture.clipId,
    fixture.sessionToken
  );
  assert.deepEqual(decoded, plaintext);
});

test('decrypts arbitrarily chunked Suno AES-CTR media as a stream', async () => {
  const plaintext = Uint8Array.from({ length: 97 }, (_, index) => (index * 37 + 11) & 0xff);
  const fixture = await createEncryptedFixture(plaintext);
  const chunkLengths = [5, 17, 3, 29, 1, 31, 11];
  let offset = 0;
  const encryptedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const length of chunkLengths) {
        controller.enqueue(fixture.encrypted.slice(offset, offset + length));
        offset += length;
      }
      controller.close();
    }
  });

  const decodedStream = await decryptSunoAudioStream(
    encryptedStream,
    fixture.wrappedKey,
    fixture.wrappedIv,
    fixture.clipId,
    fixture.sessionToken
  );
  const reader = decodedStream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), Buffer.from(plaintext));
});

test('detects decoded audio containers', () => {
  assert.equal(audioContentType(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), 'audio/mp4');
  assert.equal(audioContentType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'audio/webm');
  assert.equal(audioContentType(Buffer.from([1, 2, 3]), 'audio/mpeg'), 'audio/mpeg');
});
