import pino from 'pino';
import { ensureLoaded, getAccounts, pickAccount } from '@/lib/accountStore';
import { cache, sunoApi } from '@/lib/SunoApi';
import { loadModels, saveModels } from '@/lib/modelStore';

const logger = pino();

const g = global as unknown as { _sunoSchedulerStarted?: boolean; _sunoAuthRefreshTimer?: ReturnType<typeof setInterval> };

function authRefreshIntervalMs(): number {
  const minutes = Number.parseInt(process.env.SUNO_AUTH_REFRESH_INTERVAL_MINUTES ?? '', 10);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60 * 1000;
}

/**
 * 上海时间 08:00 = UTC 00:00
 * 计算距下一次 UTC 00:00 的毫秒数
 */
function msUntilNextRunUTC(): number {
  const now = Date.now();
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);

  let target = todayMidnight.getTime();
  if (now >= target) {
    target += 24 * 3600 * 1000; // 明天 UTC 00:00
  }
  return target - now;
}

export async function fetchAndSaveModels(): Promise<{ added: string[]; removed: string[] } | null> {
  await ensureLoaded();
  const account = await pickAccount();
  if (!account) {
    logger.warn('[Scheduler] 无可用账号，跳过模型更新');
    return null;
  }
  try {
    const api = await sunoApi(account.id);
    const rawModels = await api.getModels();
    const diff = await saveModels(rawModels);
    logger.info(
      `[Scheduler] 模型列表已更新，共 ${rawModels.length} 个` +
      (diff.added.length ? `，新增：${diff.added.join(', ')}` : '') +
      (diff.removed.length ? `，移除：${diff.removed.join(', ')}` : '')
    );
    return diff;
  } catch (err) {
    logger.error('[Scheduler] 模型更新失败: ' + err);
    return null;
  }
}

export function startScheduler(): void {
  if (g._sunoSchedulerStarted) return;
  g._sunoSchedulerStarted = true;

  // 启动时从磁盘加载已有模型
  loadModels().catch(() => {});

  const delay = msUntilNextRunUTC();
  const h = Math.floor(delay / 3600000);
  const m = Math.floor((delay % 3600000) / 60000);

  logger.info(`[Scheduler] 已启动，下次模型更新将在 ${h}h ${m}m 后执行（上海时间 08:00）`);

  const run = () => {
    fetchAndSaveModels().catch(() => {});
    setTimeout(run, 24 * 3600 * 1000);
  };

  setTimeout(run, delay);

  // 低频刷新所有已使用账号；请求到来时 keepAlive 仍会按 JWT 过期时间续期。
  if (!g._sunoAuthRefreshTimer) {
    g._sunoAuthRefreshTimer = setInterval(async () => {
      await ensureLoaded();
      const accounts = await getAccounts();
      for (const account of accounts) {
        const instance = cache.get(account.id);
        if (!instance) continue;
        try {
          await instance.refreshAuth();
          logger.info(`[Scheduler] 账号 ${account.id} session 已刷新`);
        } catch (err) {
          logger.warn(`[Scheduler] 账号 ${account.id} session 刷新失败: ` + err);
        }
      }
    }, authRefreshIntervalMs());
  }
}
