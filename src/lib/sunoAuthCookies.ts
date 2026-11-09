/** Keep Clerk's short-lived session cookies aligned with the refreshed JWT. */
export function applySunoSessionToken(
  cookies: Record<string, string | undefined>,
  sessionToken: string
): boolean {
  const names = Object.keys(cookies).filter(
    (name) => name === '__session' || name.startsWith('__session_')
  );
  if (names.length === 0) names.push('__session');

  let changed = false;
  for (const name of names) {
    if (cookies[name] === sessionToken) continue;
    cookies[name] = sessionToken;
    changed = true;
  }
  return changed;
}
