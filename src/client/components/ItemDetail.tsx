import type { ReactNode } from 'react';
import type { ItemDetails } from '../types';
import { HeroSkeleton } from './Hero';
import { ItemPanel } from './ItemPanel';
import { ErrorBanner } from './ui';

/**
 * Renders the configure-playback panel for an item that may still be loading or
 * may have failed to load.
 */
export function ItemDetail({
  item,
  error,
  top,
  onClose,
  onBrowse,
  onRetry,
  onCreated,
}: {
  item: ItemDetails | null;
  error: string | null;
  /** Navigation shown above the title, e.g. breadcrumbs or a back button. */
  top: ReactNode;
  onClose: () => void;
  /** Open a library path, used to jump from an episode to its series. */
  onBrowse: (path: string[]) => void;
  onRetry: () => void;
  onCreated: () => void;
}) {
  if (item) {
    return (
      <ItemPanel item={item} top={top} onClose={onClose} onBrowse={onBrowse} onCreated={onCreated} />
    );
  }
  if (error) {
    return (
      <div className="wrap page-pad">
        {top}
        <ErrorBanner message={error} onRetry={onRetry} />
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading item">
      <HeroSkeleton top={top} />
      <div className="wrap">
        <div className="sheet sheet-skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}
