/**
 * Next.js Instrumentation Hook
 * 服务器启动时自动调用，用于初始化定时调度器
 * 文档：https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
