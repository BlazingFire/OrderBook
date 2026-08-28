/** CursorPager (§9.1) — keyset pagination only. No page numbers. */

import { Button } from './Button';

export function LoadMorePager({
  hasMore,
  loading,
  onLoadMore,
  label = 'Load more',
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
        Newer
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasOlder} onClick={onOlder}>
        Older
      </Button>
    </div>
  );
}
