/** CursorPager (§9.1) — keyset pagination only. No page numbers. */

import { Button } from './Button';
import { t } from './i18n.js';

export function LoadMorePager({
  hasMore,
  loading,
  onLoadMore,
  label = t('common.loadMore'),
}: {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  if (!hasMore) return null;
  return (
    <div className="ob-pager">
      <Button variant="secondary" busy={loading} onClick={onLoadMore}>
        {label}
      </Button>
    </div>
  );
}

export function NewerOlderPager({
  hasNewer,
  hasOlder,
  onNewer,
  onOlder,
}: {
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}) {
  return (
    <div className="ob-pager">
      <Button variant="secondary" size="sm" disabled={!hasNewer} onClick={onNewer}>
        {t('common.newer')}
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasOlder} onClick={onOlder}>
        {t('common.older')}
      </Button>
    </div>
  );
}
