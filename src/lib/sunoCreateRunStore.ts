import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type SunoCreateRunStatus = 'running' | 'success' | 'failed';

export interface SunoCreateRun {
  id: number;
  runId: string;
  accountId: string;
  accountEmail: string;
  status: SunoCreateRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  generateUrl?: string;
}

interface SunoCreateRunRow {
  id: number;
  run_id: string;
  account_id: string;
  account_email: string;
  status: SunoCreateRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  message: string | null;
  generate_url: string | null;
}

function rowToRun(row: SunoCreateRunRow): SunoCreateRun {
  return {
    id: row.id,
    runId: row.run_id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    message: row.message ?? undefined,
    generateUrl: row.generate_url ?? undefined,
  };
}

export async function startSunoCreateRun(accountId: string, accountEmail: string): Promise<number> {
  const db = await getDb();
  const res = db.prepare(`
    INSERT INTO suno_create_runs (run_id, account_id, account_email, status, started_at)
    VALUES (@run_id, @account_id, @account_email, 'running', @started_at)
  `).run({
    run_id: randomUUID(),
    account_id: accountId,
    account_email: accountEmail,
    started_at: new Date().toISOString(),
  });

  return res.lastInsertRowid;
}

export async function finishSunoCreateRun(
  id: number,
  status: Exclude<SunoCreateRunStatus, 'running'>,
  message?: string,
  generateUrl?: string,
): Promise<void> {
  const db = await getDb();
  const finishedAt = new Date().toISOString();
  db.prepare(`
    UPDATE suno_create_runs
    SET status = @status,
        finished_at = @finished_at,
        duration_ms = CAST((julianday(@finished_at) - julianday(started_at)) * 86400000 AS INTEGER),
        message = @message,
        generate_url = @generate_url
    WHERE id = @id
  `).run({
    id,
    status,
    finished_at: finishedAt,
    message: message ?? null,
    generate_url: generateUrl ?? null,
  });
}

export async function getRecentSunoCreateRuns(limit: number = 50): Promise<SunoCreateRun[]> {
  const db = await getDb();
  const rows = db.prepare(`
    SELECT id, run_id, account_id, account_email, status, started_at, finished_at,
           duration_ms, message, generate_url
    FROM suno_create_runs
    ORDER BY started_at DESC
    LIMIT @limit
  `).all({ limit }) as SunoCreateRunRow[];
  return rows.map(rowToRun);
}

export async function purgeOldSunoCreateRuns(days: number = 30): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const result = db.prepare('DELETE FROM suno_create_runs WHERE started_at < @cutoff').run({ cutoff });
  return result.changes;
}
