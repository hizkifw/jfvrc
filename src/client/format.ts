export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRuntime(seconds?: number): string | null {
  if (seconds === undefined || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatTrack(track: {
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault?: boolean;
  isForced?: boolean;
}): string {
  const bits = [track.label || `Track ${track.index}`];
  if (track.language) bits.push(`[${track.language}]`);
  if (track.codec) bits.push(track.codec);
  if (track.isDefault) bits.push('default');
  if (track.isForced) bits.push('forced');
  return bits.join(' ');
}

export function relativeExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
