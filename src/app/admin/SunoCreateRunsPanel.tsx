'use client';

import { useCallback, useEffect, useState } from 'react';

type RunStatus = 'running' | 'success' | 'failed';

interface SunoCreateRun {
  id: number;
  runId: string;
  accountId: string;
  accountEmail: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  generateUrl?: string;
}

const STATUS_COPY: Record<RunStatus, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
};

const STATUS_CLASS: Record<RunStatus, string> = {
  running: 'bg-yellow-100 text-yellow-700',
  success: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
};

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return '-';
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export default function SunoCreateRunsPanel() {
  const [runs, setRuns] = useState<SunoCreateRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/suno-create-runs?limit=30');
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `请求失败 (${res.status})`);
        setRuns([]);
      } else {
        setRuns(Array.isArray(data) ? data : []);
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || '网络请求错误');
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mt-8">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
        <div>
          <h2 className="font-semibold text-gray-700">定时创建运行记录</h2>
          <p className="text-xs text-gray-400 mt-1">scripts/suno-create.ts 最近执行情况</p>
        </div>
        <button onClick={fetchRuns} className="text-sm text-blue-600 hover:underline">
          刷新
        </button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-gray-400">加载中...</div>
      ) : error ? (
        <div className="p-6 text-center">
          <div className="text-red-500 bg-red-50 inline-block px-4 py-2 rounded-lg text-sm border border-red-100 max-w-xl break-all">
            <strong>加载失败:</strong> {error}
          </div>
          <button onClick={fetchRuns} className="block mx-auto mt-3 text-xs text-blue-600 hover:underline">
            重试
          </button>
        </div>
      ) : runs.length === 0 ? (
        <div className="p-10 text-center text-gray-400">暂无运行记录</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-gray-500 font-medium">账号</th>
                <th className="text-left px-5 py-3 text-gray-500 font-medium">状态</th>
                <th className="text-left px-5 py-3 text-gray-500 font-medium">开始时间</th>
                <th className="text-left px-5 py-3 text-gray-500 font-medium">耗时</th>
                <th className="text-left px-5 py-3 text-gray-500 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {runs.map(run => (
                <tr key={run.id} className="hover:bg-gray-50/50 transition">
                  <td className="px-5 py-4">
                    <div className="font-medium text-gray-900">{run.accountEmail}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{run.accountId}</div>
                  </td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[run.status]}`}>
                      {STATUS_COPY[run.status]}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-gray-500 text-xs">
                    {new Date(run.startedAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-5 py-4 text-gray-500 text-xs">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td className="px-5 py-4 text-gray-600">
                    {run.message ? (
                      <span className={run.status === 'failed' ? 'text-red-600' : ''}>{run.message}</span>
                    ) : run.generateUrl ? (
                      <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{run.generateUrl}</code>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
