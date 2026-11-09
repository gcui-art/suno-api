import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';

export interface RequestLog {
  id: number;
  request_id: string;
  action: string;
  account_id?: string;
  success: boolean;
  duration_ms?: number;
  error?: string;
  created_at: string;
}

export interface ActionStats {
  action: string;
  total: number;
  success: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
}

export interface MonitorStats {
  period: string;
  total: number;
  success: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
  by_action: ActionStats[];
  recent_failures: RequestLog[];
}

/** 记录一次请求 */
export async function recordRequest(
  action: string,
  accountId: string | undefined,
  success: boolean,
  durationMs: number,
  error?: string
): Promise<void> {
  try {
    const db = await getDb();
    db.prepare(`
      INSERT INTO request_logs (request_id, action, account_id, success, duration_ms, error, created_at)
      VALUES (@request_id, @action, @account_id, @success, @duration_ms, @error, @created_at)
    `).run({
      request_id: randomUUID(),
      action,
      account_id: accountId ?? null,
      success: success ? 1 : 0,
      duration_ms: durationMs,
      error: error ?? null,
      created_at: new Date().toISOString(),
    });
  } catch {
    // 监控本身不能影响主流程，静默忽略
  }
}

/** 获取统计数据
 * @param hours 统计过去多少小时，默认 24
 */
export async function getMonitorStats(hours: number = 24): Promise<MonitorStats> {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const totRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(success) as success,
      AVG(duration_ms) as avg_duration_ms
    FROM request_logs
    WHERE created_at >= @since
  `).get({ since }) as { total: number; success: number; avg_duration_ms: number } | undefined;

  const total = totRow?.total ?? 0;
  const success = totRow?.success ?? 0;
  const failed = total - success;
  const avg_duration_ms = Math.round(totRow?.avg_duration_ms ?? 0);

  const byAction = db.prepare(`
    SELECT
      action,
      COUNT(*) as total,
      SUM(success) as success,
      AVG(duration_ms) as avg_duration_ms
    FROM request_logs
    WHERE created_at >= @since
    GROUP BY action
    ORDER BY total DESC
  `).all({ since }) as Array<{ action: string; total: number; success: number; avg_duration_ms: number }>;

  const by_action: ActionStats[] = byAction.map(r => ({
    action: r.action,
    total: r.total,
    success: r.success,
    failed: r.total - r.success,
    success_rate: r.total > 0 ? Math.round((r.success / r.total) * 1000) / 10 : 0,
    avg_duration_ms: Math.round(r.avg_duration_ms ?? 0),
  }));

  const recentFails = db.prepare(`
    SELECT id, request_id, action, account_id, success, duration_ms, error, created_at
    FROM request_logs
    WHERE success = 0 AND created_at >= @since
    ORDER BY created_at DESC
    LIMIT 20
  `).all({ since }) as any[];

  const recent_failures: RequestLog[] = recentFails.map(r => ({
    ...r,
    success: r.success === 1,
  }));

  return {
    period: `${hours}h`,
    total,
    success,
    failed,
    success_rate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
    avg_duration_ms,
    by_action,
    recent_failures,
  };
}

/** 获取最近的请求日志 */
export async function getRecentLogs(limit: number = 50): Promise<RequestLog[]> {
  const db = await getDb();
  const rows = db.prepare(`
    SELECT id, request_id, action, account_id, success, duration_ms, error, created_at
    FROM request_logs
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ limit }) as any[];

  return rows.map(r => ({ ...r, success: r.success === 1 }));
}

/** 清理旧日志（保留最近 N 天）*/
export async function purgeOldLogs(days: number = 30): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM request_logs WHERE created_at < @cutoff`).run({ cutoff });
  return result.changes;
}
