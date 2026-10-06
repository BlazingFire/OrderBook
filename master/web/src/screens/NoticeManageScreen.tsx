/**
 * Notice board management on the Master Panel (U5): every notice, with the editor, the audience picker,
 * pin and expiry, who has read each, and delete. The kit's `NoticeManageView` draws it; this reads and
 * writes through the Master. A write that fails is thrown to the view, which says why.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Notice, NoticeInput, NoticeUpdate } from '@orderbook/shared';

import { api } from '../api';
import { NoticeManageView, apiErrorText } from '@orderbook/ui';
import { todayForNotices } from '../noticeToday';

interface Props {
  /** Moves when a notice changes, so the list re-reads. */
  revision: number;
}

export function NoticeManageScreen({ revision }: Props) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const reload = useCallback(() => setRetry((count) => count + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([api.noticeManageList(), api.noticeAudiences().catch(() => [])])
      .then(([list, audiences]) => {
        if (!live) return;
        setNotices(list);
        setRoles(audiences);
        setError(null);
      })
      .catch((caught) => live && setError(apiErrorText(caught, 'notices.manage.loadFailed')))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [revision, retry]);

  /** A write, then the list as the Master now has it (the change event arrives too; this is for the writer's own screen). */
  const afterWrite = useCallback(async (write: () => Promise<unknown>) => {
    await write();
    setNotices(await api.noticeManageList());
  }, []);

  return (
    <NoticeManageView
      notices={notices}
      roles={roles}
      loading={loading}
      error={error}
      onRetry={reload}
      onCreate={(input: NoticeInput) => afterWrite(() => api.createNotice(input))}
      onUpdate={(id: string, update: NoticeUpdate) => afterWrite(() => api.updateNotice(id, update))}
      onDelete={(id: string) => afterWrite(() => api.deleteNotice(id))}
      loadReaders={(id) => api.noticeReaders(id)}
      today={todayForNotices()}
    />
  );
}
