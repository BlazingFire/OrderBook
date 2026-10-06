/**
 * Notice board management on the Office panel, for `notices.manage` holders.
 *
 * Online-only through the Master, like the Recycle Bin: a notice carries a version,
 * not a field clock, so there is nothing the outbox could merge. With the Master out of
 * reach the list fails with the proxy's 503 and the view offers Retry. A fresh snapshot
 * (`revision`, bumped by the snapshot-forcing `notice` change) re-reads the list, so a
 * notice another manager changed appears without a reload.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Notice } from '@orderbook/shared';
import { NoticeManageView, apiErrorText } from '@orderbook/ui';

import { api } from '../api';

interface Props {
  revision: number;
}

export function NoticeManageScreen({ revision }: Props) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
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
    />
  );
}
