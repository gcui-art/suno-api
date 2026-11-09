'use client';

import { useState, useEffect, useCallback } from 'react';
import SunoCreateRunsPanel from './SunoCreateRunsPanel';

interface AccountCredits {
  credits_left: number;
  period: string;
  monthly_limit: number;
  monthly_usage: number;
}

interface Account {
  id: string;
  email: string;
  cookie: string;
  credits?: AccountCredits;
  lastRefreshed?: string;
  addedAt: string;
  enabled: boolean;
}

interface Song {
  id: string;
  title?: string;
  status: string;
  audio_url?: string;
  image_url?: string;
  created_at: string;
  tags?: string;
  duration?: string;
}

interface ActionStats {
  action: string;
  total: number;
  success: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
}

interface RecentFailure {
  id: number;
  request_id: string;
  action: string;
  account_id?: string;
  success: boolean;
  duration_ms?: number;
  error?: string;
  created_at: string;
}

interface MonitorStats {
  period: string;
  total: number;
  success: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
  by_action: ActionStats[];
  recent_failures: RecentFailure[];
}

export default function AdminPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSongsModal, setShowSongsModal] = useState(false);
  const [showCookieModal, setShowCookieModal] = useState<string | null>(null);
  const [selectedAccountSongs, setSelectedAccountSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(false);
  const [selectedAccountEmail, setSelectedAccountEmail] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newCookie, setNewCookie] = useState('');
  const [addError, setAddError] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [updateCookie, setUpdateCookie] = useState('');
  const [monitorStats, setMonitorStats] = useState<MonitorStats | null>(null);
  const [monitorHours, setMonitorHours] = useState(24);
  const [monitorLoading, setMonitorLoading] = useState(false);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMonitorStats = useCallback(async (hours: number) => {
    setMonitorLoading(true);
    try {
      const res = await fetch(`/api/monitor?hours=${hours}`);
      const data = await res.json();
      setMonitorStats(data);
    } catch (e) {
      console.error(e);
    } finally {
      setMonitorLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
    fetchMonitorStats(monitorHours);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAccounts, fetchMonitorStats]);

  const handleAddAccount = async () => {
    if (!newEmail.trim() || !newCookie.trim()) {
      setAddError('邮箱和 Cookie 不能为空');
      return;
    }
    setAddLoading(true);
    setAddError('');
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, cookie: newCookie }),
      });
      if (!res.ok) {
        const err = await res.json();
        setAddError(err.error || '添加失败');
        return;
      }
      setNewEmail('');
      setNewCookie('');
      setShowAddModal(false);
      await fetchAccounts();
    } catch {
      setAddError('添加失败，请重试');
    } finally {
      setAddLoading(false);
    }
  };

  const handleDelete = async (id: string, email: string) => {
    if (!confirm(`确认删除账号 ${email}？此操作不可恢复。`)) return;
    await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    await fetchAccounts();
  };

  const handleRefresh = async (id: string) => {
    setRefreshingId(id);
    try {
      await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
      await fetchAccounts();
    } finally {
      setRefreshingId(null);
    }
  };

  const handleRefreshAll = async () => {
    for (const account of accounts) {
      setRefreshingId(account.id);
      try {
        await fetch(`/api/accounts/${account.id}/refresh`, { method: 'POST' });
      } catch { /* ignore individual errors */ }
    }
    setRefreshingId(null);
    await fetchAccounts();
  };

  const handleToggle = async (id: string) => {
    await fetch(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' }),
    });
    await fetchAccounts();
  };

  const handleViewSongs = async (id: string, email: string) => {
    setSelectedAccountEmail(email);
    setShowSongsModal(true);
    setSongsLoading(true);
    setSelectedAccountSongs([]);
    try {
      const res = await fetch(`/api/accounts/${id}/songs`);
      const data = await res.json();
      setSelectedAccountSongs(Array.isArray(data) ? data : []);
    } finally {
      setSongsLoading(false);
    }
  };

  const handleUpdateCookie = async (id: string) => {
    if (!updateCookie.trim()) return;
    await fetch(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateCookie', cookie: updateCookie }),
    });
    setShowCookieModal(null);
    setUpdateCookie('');
    await fetchAccounts();
  };

  const totalCredits = accounts.reduce((sum, a) => sum + (a.credits?.credits_left ?? 0), 0);
  const enabledCount = accounts.filter(a => a.enabled).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* 页头 */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Suno 账号管理</h1>
            <p className="text-sm text-gray-500 mt-1">
              管理所有 Suno 账号 Cookie，多账号轮询对外提供稳定服务
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleRefreshAll}
              disabled={accounts.length === 0 || refreshingId !== null}
              className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition disabled:opacity-50"
            >
              全部刷新积分
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
            >
              + 添加账号
            </button>
          </div>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <p className="text-xs text-gray-500 uppercase tracking-wide">总账号数</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{accounts.length}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <p className="text-xs text-gray-500 uppercase tracking-wide">启用中</p>
            <p className="text-3xl font-bold text-green-600 mt-1">{enabledCount}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <p className="text-xs text-gray-500 uppercase tracking-wide">总剩余积分</p>
            <p className="text-3xl font-bold text-blue-600 mt-1">{totalCredits}</p>
          </div>
        </div>

        {/* API 说明 */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-sm text-blue-800">
          <strong>API 接口：</strong>
          <code className="ml-2 bg-blue-100 px-1.5 py-0.5 rounded text-xs">
            POST /api/accounts
          </code>
          <span className="mx-2">body: </span>
          <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">{`{"email":"x@x.com","cookie":"..."}`}</code>
          <span className="ml-2 text-blue-600">— 通过 API 程序化添加账号</span>
        </div>

        {/* 账号列表 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-700">账号列表</h2>
            <button
              onClick={fetchAccounts}
              className="text-sm text-blue-600 hover:underline"
            >
              刷新
            </button>
          </div>

          {loading ? (
            <div className="p-12 text-center text-gray-400">加载中...</div>
          ) : accounts.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-gray-400 mb-4">暂无账号</p>
              <button
                onClick={() => setShowAddModal(true)}
                className="text-blue-600 text-sm hover:underline"
              >
                点击添加第一个账号
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">邮箱账号</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">剩余积分</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">本月用量</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">最后刷新</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">状态</th>
                    <th className="text-left px-5 py-3 text-gray-500 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {accounts.map(account => (
                    <tr key={account.id} className="hover:bg-gray-50/50 transition">
                      <td className="px-5 py-4">
                        <div className="font-medium text-gray-900">{account.email}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {new Date(account.addedAt).toLocaleDateString('zh-CN')} 添加
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        {account.credits ? (
                          <span className="font-semibold text-blue-600">
                            {account.credits.credits_left}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">未获取</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-gray-600">
                        {account.credits
                          ? `${account.credits.monthly_usage} / ${account.credits.monthly_limit}`
                          : <span className="text-gray-400 text-xs">-</span>
                        }
                      </td>
                      <td className="px-5 py-4 text-gray-500 text-xs">
                        {account.lastRefreshed
                          ? new Date(account.lastRefreshed).toLocaleString('zh-CN')
                          : '-'}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            account.enabled
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {account.enabled ? '启用' : '禁用'}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3 flex-wrap">
                          <button
                            onClick={() => handleRefresh(account.id)}
                            disabled={refreshingId === account.id}
                            className="text-xs text-blue-600 hover:underline disabled:opacity-50 whitespace-nowrap"
                          >
                            {refreshingId === account.id ? '刷新中...' : '刷新积分'}
                          </button>
                          <button
                            onClick={() => handleViewSongs(account.id, account.email)}
                            className="text-xs text-purple-600 hover:underline whitespace-nowrap"
                          >
                            查看歌曲
                          </button>
                          <button
                            onClick={() => handleToggle(account.id)}
                            className="text-xs text-yellow-600 hover:underline whitespace-nowrap"
                          >
                            {account.enabled ? '禁用' : '启用'}
                          </button>
                          <button
                            onClick={() => {
                              setShowCookieModal(account.id);
                              setUpdateCookie('');
                            }}
                            className="text-xs text-orange-500 hover:underline whitespace-nowrap"
                          >
                            更新 Cookie
                          </button>
                          <button
                            onClick={() => handleDelete(account.id, account.email)}
                            className="text-xs text-red-500 hover:underline whitespace-nowrap"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <SunoCreateRunsPanel />

        {/* 请求监控 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mt-8">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-700">请求监控</h2>
            <div className="flex items-center gap-3">
              <select
                value={monitorHours}
                onChange={e => {
                  const h = Number(e.target.value);
                  setMonitorHours(h);
                  fetchMonitorStats(h);
                }}
                className="text-sm border border-gray-200 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value={1}>最近 1 小时</option>
                <option value={6}>最近 6 小时</option>
                <option value={24}>最近 24 小时</option>
                <option value={168}>最近 7 天</option>
                <option value={720}>最近 30 天</option>
              </select>
              <button
                onClick={() => fetchMonitorStats(monitorHours)}
                className="text-sm text-blue-600 hover:underline"
              >
                刷新
              </button>
            </div>
          </div>

          {monitorLoading ? (
            <div className="p-10 text-center text-gray-400">加载中...</div>
          ) : !monitorStats ? (
            <div className="p-10 text-center text-gray-400">暂无数据</div>
          ) : (
            <div className="p-5 space-y-6">
              {/* 总体统计卡片 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-gray-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">总请求数</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{monitorStats.total}</p>
                </div>
                <div className="bg-green-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">成功率</p>
                  <p className="text-2xl font-bold text-green-600 mt-1">
                    {monitorStats.total === 0 ? '-' : `${monitorStats.success_rate}%`}
                  </p>
                </div>
                <div className="bg-red-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">失败次数</p>
                  <p className="text-2xl font-bold text-red-500 mt-1">{monitorStats.failed}</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">平均响应</p>
                  <p className="text-2xl font-bold text-blue-600 mt-1">
                    {monitorStats.avg_duration_ms > 0 ? `${(monitorStats.avg_duration_ms / 1000).toFixed(1)}s` : '-'}
                  </p>
                </div>
              </div>

              {/* 按接口细分 */}
              {monitorStats.by_action.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">各接口统计</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-4 py-2 text-gray-500 font-medium">接口</th>
                          <th className="text-right px-4 py-2 text-gray-500 font-medium">总数</th>
                          <th className="text-right px-4 py-2 text-gray-500 font-medium">成功</th>
                          <th className="text-right px-4 py-2 text-gray-500 font-medium">失败</th>
                          <th className="text-right px-4 py-2 text-gray-500 font-medium">成功率</th>
                          <th className="text-right px-4 py-2 text-gray-500 font-medium">均耗时</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {monitorStats.by_action.map(row => (
                          <tr key={row.action} className="hover:bg-gray-50/50">
                            <td className="px-4 py-2.5">
                              <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{row.action}</code>
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{row.total}</td>
                            <td className="px-4 py-2.5 text-right text-green-600">{row.success}</td>
                            <td className="px-4 py-2.5 text-right text-red-500">{row.failed}</td>
                            <td className="px-4 py-2.5 text-right">
                              <span className={`font-medium ${row.success_rate >= 90 ? 'text-green-600' : row.success_rate >= 70 ? 'text-yellow-600' : 'text-red-500'}`}>
                                {row.success_rate}%
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-500 text-xs">
                              {row.avg_duration_ms > 0 ? `${(row.avg_duration_ms / 1000).toFixed(1)}s` : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 最近失败记录 */}
              {monitorStats.recent_failures.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-3">最近失败记录</h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {monitorStats.recent_failures.map(log => (
                      <div key={log.id} className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border border-red-100 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="bg-red-100 px-1.5 py-0.5 rounded text-red-700">{log.action}</code>
                            {log.account_id && (
                              <span className="text-gray-400">账号: {log.account_id.slice(0, 8)}...</span>
                            )}
                            {log.duration_ms !== undefined && (
                              <span className="text-gray-400">{(log.duration_ms / 1000).toFixed(1)}s</span>
                            )}
                          </div>
                          {log.error && (
                            <p className="text-red-600 mt-1 break-all">{log.error}</p>
                          )}
                        </div>
                        <span className="text-gray-400 whitespace-nowrap flex-shrink-0">
                          {new Date(log.created_at).toLocaleString('zh-CN')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {monitorStats.total === 0 && (
                <div className="text-center text-gray-400 py-4">
                  该时段内暂无请求记录
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 添加账号弹窗 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="p-6 border-b">
              <h3 className="text-lg font-bold text-gray-900">添加账号</h3>
              <p className="text-sm text-gray-500 mt-1">
                请从浏览器开发者工具的 Network 标签中复制 Cookie
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  邮箱地址 <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cookie <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={newCookie}
                  onChange={e => setNewCookie(e.target.value)}
                  placeholder="从 suno.com 请求的 Request Headers → Cookie 中复制..."
                  rows={7}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y"
                />
              </div>
              {addError && (
                <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{addError}</p>
              )}
            </div>
            <div className="p-6 border-t flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setNewEmail('');
                  setNewCookie('');
                  setAddError('');
                }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleAddAccount}
                disabled={addLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                {addLoading ? '添加中...' : '添加账号'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 更新 Cookie 弹窗 */}
      {showCookieModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="p-6 border-b">
              <h3 className="text-lg font-bold text-gray-900">更新 Cookie</h3>
              <p className="text-sm text-gray-500 mt-1">粘贴新的 Cookie 值以替换旧的</p>
            </div>
            <div className="p-6">
              <textarea
                value={updateCookie}
                onChange={e => setUpdateCookie(e.target.value)}
                placeholder="粘贴新 Cookie..."
                rows={8}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-orange-400 focus:border-orange-400 outline-none resize-y"
              />
            </div>
            <div className="p-6 border-t flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowCookieModal(null);
                  setUpdateCookie('');
                }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => handleUpdateCookie(showCookieModal)}
                className="px-4 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 font-medium"
              >
                保存更新
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 歌曲列表弹窗 */}
      {showSongsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-lg font-bold text-gray-900">歌曲列表</h3>
                <p className="text-sm text-gray-500 mt-0.5">{selectedAccountEmail}</p>
              </div>
              <button
                onClick={() => setShowSongsModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-lg"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {songsLoading ? (
                <div className="text-center text-gray-400 py-12">加载歌曲中...</div>
              ) : selectedAccountSongs.length === 0 ? (
                <div className="text-center text-gray-400 py-12">暂无歌曲</div>
              ) : (
                <div className="space-y-3">
                  {selectedAccountSongs.map(song => (
                    <div
                      key={song.id}
                      className="flex items-center gap-4 p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition"
                    >
                      {song.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={song.image_url}
                          alt=""
                          className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-gradient-to-br from-purple-400 to-blue-500 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">
                          {song.title || '无标题'}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5 truncate">
                          {song.tags && <span>{song.tags} · </span>}
                          {song.duration && <span>{song.duration}s · </span>}
                          {new Date(song.created_at).toLocaleDateString('zh-CN')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            song.status === 'complete'
                              ? 'bg-green-100 text-green-700'
                              : song.status === 'error'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {song.status}
                        </span>
                        {song.audio_url && (
                          <a
                            href={song.audio_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            播放
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
