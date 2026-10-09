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

/** English name for a language code ("jpn" -> "Japanese"), or null when unknown. */
function languageName(code: string): string | null {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * One-line track label. Jellyfin display titles usually already spell out the
 * language and codec, so those are only appended when the label lacks them.
 */
export function formatTrack(track: {
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault?: boolean;
  isForced?: boolean;
}): string {
  const label = track.label || `Track ${track.index}`;
  const mentions = (value: string) => label.toLowerCase().includes(value.toLowerCase());
  const bits = [label];
  if (track.language) {
    const name = languageName(track.language);
    if (!mentions(track.language) && !(name && mentions(name))) bits.push(name ?? track.language);
  }
  if (track.codec && !mentions(track.codec)) bits.push(track.codec.toUpperCase());
  if (track.isDefault && !mentions('default')) bits.push('Default');
  if (track.isForced && !mentions('forced')) bits.push('Forced');
  return bits.join(' · ');
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

/** "S1 E3" for an episode, or null when it has no numbering. */
export function episodeCode(item: {
  type: string;
  seasonNumber?: number;
  episodeNumber?: number;
}): string | null {
  if (item.type !== 'Episode') return null;
  const season = item.seasonNumber !== undefined ? `S${item.seasonNumber}` : '';
  const episode = item.episodeNumber !== undefined ? `E${item.episodeNumber}` : '';
  return [season, episode].filter(Boolean).join(' ') || null;
}
