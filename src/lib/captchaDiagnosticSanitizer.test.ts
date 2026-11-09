import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeDiagnosticUrl } from './captchaDiagnosticSanitizer';

test('removes query parameters and fragments from page URLs', () => {
  assert.equal(
    sanitizeDiagnosticUrl('https://suno.com/create?__clerk_handshake=secret#state'),
    'https://suno.com/create'
  );
});

test('keeps Turnstile state without exposing dynamic challenge identifiers', () => {
  assert.equal(
    sanitizeDiagnosticUrl(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/token/failure_retry/normal?lang=auto'
    ),
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/failure_retry'
  );
});
