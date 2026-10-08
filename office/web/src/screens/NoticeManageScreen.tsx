/**
 * Notice board management on the Office panel, for `notices.manage` holders.
 *
 * Online-only through the Master, like the Recycle Bin: a notice carries a version,
 * not a field clock, so there is nothing the outbox could merge. With the Master out of
 * reach the list fails with the proxy's 503 and the view offers Retry. A fresh snapshot
 * (`revision`, bumped by the snapshot-forcing `notice` change) re-reads the list, so a
 * notice another manager changed appears without a reload.
 *
 * The "Sell today" tab (2026-10-08) reads and writes the same way. A Master too old for it answers
 * the list with `updateNeeded` (426), and then the tab is not offered.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Notice, Product, SellToday } from '@orderbook/shared';
import { NoticeManageView, apiErrorText } from '@orderbook/ui';

import { ApiError, api } from '../api';

interface Props {
  revision: number;
}

export function NoticeManageScreen({ revision }: Props) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sellToday, setSellToday] = useState<SellToday[]>([]);
  const [sellTodayError, setSellTodayError] = useState<string | null>(null);
  const [sellTodayOffered, setSellTodayOffered] = useState(true);
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    api
      .sellTodayManage()
      .then((entries) => {
        setSellToday(entries);
        setSellTodayError(null);
        setSellTodayOffered(true);
      })
      .catch((failure) => {
        if (failure instanceof ApiError && failure.code === 'updateNeeded') setSellTodayOffered(false);
        else setSellTodayError(apiErrorText(failure, 'sellToday.manage.loadFailed'));
      });
    try {
      const [list, audiences] = await Promise.all([
        api.manageNotices(),
        // The audience picker is optional: without the list it offers "everyone" only.
        api.noticeAudiences().catch(() => []),
      ]);
      setNotices(list);
      setRoles(audiences);
      setError(null);
    } catch (failure) {
      setError(apiErrorText(failure, 'error.requestFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  return (
    <NoticeManageView
      notices={notices}
      roles={roles}
      loading={loading}
      error={error}
      onRetry={() => void reload()}
      onCreate={async (input) => {
        await api.createNotice(input);
        await reload();
      }}
      onUpdate={async (id, update) => {
        await api.updateNotice(id, update);
        await reload();
      }}
      onDelete={async (id) => {
        await api.deleteNotice(id);
        await reload();
      }}
      loadReaders={api.noticeReaders}
      sellToday={sellToday}
      sellTodayError={sellTodayError}
      onCreateSellToday={
        sellTodayOffered
          ? async (input) => {
              await api.createSellToday(input);
              await reload();
            }
          : undefined
      }
      onUpdateSellToday={
        sellTodayOffered
          ? async (id, update) => {
              await api.updateSellToday(id, update);
              await reload();
            }
          : undefined
      }
      searchProducts={async (term) => (await api.pick<Product>('product', { term, limit: 20 })).items}
    />
  );
}
