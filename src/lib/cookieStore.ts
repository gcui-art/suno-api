// 全局内存 cookie 存储，使用 global 对象防止 Next.js 热重载后丢失
const g = global as unknown as { _sunoCookie?: string };

export const getCookie = (): string | undefined => g._sunoCookie;
export const setCookie = (cookie: string): void => { g._sunoCookie = cookie; };
export const clearCookie = (): void => { delete g._sunoCookie; };
