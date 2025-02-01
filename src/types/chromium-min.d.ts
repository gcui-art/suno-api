declare module '@sparticuz/chromium' {
  export const args: string[];
  export const executablePath: () => Promise<string>;
}