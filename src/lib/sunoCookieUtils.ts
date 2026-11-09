import * as cookie from 'cookie';

export function serializeCookieRecord(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => cookie.serialize(key, value as string))
    .join('; ');
}
