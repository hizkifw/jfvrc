import type { ItemDetails } from '../types';
import { ItemPanel } from './ItemPanel';
import { ErrorBanner, Spinner } from './ui';

/**
 * Renders the configure-playback panel for an item that may still be loading or
 * may have failed to load.
 */
export function ItemDetail({
  item,
  error,
  onClose,
  onRetry,
  onCreated,
}: {
  item: ItemDetails | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onCreated: () => void;
}) {
  if (item) {
    return <ItemPanel item={item} onClose={onClose} onCreated={onCreated} />;
  }
  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />;
  }
  return (
    <div className="center-pad">
      <Spinner label="Loading item" />
    </div>
  );
}
