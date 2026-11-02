import os from 'node:os';
const DEFAULT_CHROMIUM_VERSION = '148.0.7778.96';

export function createBrowserUserAgent(): string {
  const configured = process.env.BROWSER_USER_AGENT;
  if (configured) {
    return configured;
  }
  const version = process.env.BROWSER_CHROMIUM_VERSION || DEFAULT_CHROMIUM_VERSION;
  return createMatchingChromiumUserAgent(version);
}

export function createDesktopChromiumClientHints(userAgent: string): Record<string, string> {
  const match = userAgent.match(/(?:Chrome|Chromium)\/(\d+)/);
  const majorVersion = match?.[1] || DEFAULT_CHROMIUM_VERSION.split('.')[0];
  const platform = userAgent.includes('Windows')
    ? 'Windows'
    : userAgent.includes('Macintosh')
      ? 'macOS'
      : 'Linux';
  return {
    'sec-ch-ua': `"Chromium";v="${majorVersion}", "Not=A?Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`
  };
}

export function createMatchingChromiumUserAgent(
  browserVersion: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = os.arch()
): string {
  if (!/^\d+(?:\.\d+){3}$/.test(browserVersion)) {
    throw new Error(`Unsupported Chromium version: ${browserVersion}`);
  }

  const platformToken = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : `X11; Linux ${architecture === 'arm64' ? 'aarch64' : 'x86_64'}`;
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;
}
