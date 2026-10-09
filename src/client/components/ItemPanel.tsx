import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { formatTrack, relativeExpiry } from '../format';
import type { CreateLinkResponse, ItemDetails, Preset, Track } from '../types';
import { Hero } from './Hero';
import { Icon } from './icons';
import { CopyButton, ErrorBanner, Field, Spinner } from './ui';

const PRESETS: Array<{ id: Preset; label: string; detail: string }> = [
  { id: '1080p', label: '1080p', detail: '8 Mbps' },
  { id: '720p', label: '720p', detail: '4 Mbps' },
];

const JAPANESE_TRACK_RE = /japanese|\bjpn\b|\bjp\b|\bja\b/i;
const ENGLISH_TRACK_RE = /english|\beng\b|\ben\b/i;

/** Index of the first track whose language or label roughly matches, else null. */
export function preferredTrackIndex(tracks: Track[], pattern: RegExp): number | null {
  const match = tracks.find(
    (track) => pattern.test(track.language ?? '') || pattern.test(track.label),
  );
  return match ? match.index : null;
}

export function ItemPanel({
  item,
  top,
  onClose,
  onBrowse,
  onCreated,
}: {
  item: ItemDetails;
  top: ReactNode;
  onClose: () => void;
  onBrowse: (path: string[]) => void;
  onCreated: () => void;
}) {
  const [sourceId, setSourceId] = useState(item.mediaSources[0]?.id ?? '');
  const [audio, setAudio] = useState('');
  const [subtitle, setSubtitle] = useState(-1);
  const [preset, setPreset] = useState<Preset>('1080p');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLinkResponse | null>(null);

  const source = useMemo(
    () => item.mediaSources.find((candidate) => candidate.id === sourceId) ?? item.mediaSources[0],
    [item.mediaSources, sourceId],
  );

  useEffect(() => {
    setSourceId(item.mediaSources[0]?.id ?? '');
    setPreset('1080p');
    setResult(null);
    setError(null);
  }, [item]);

  // Prefer Japanese audio and English subtitles when the selected source has
  // them; otherwise fall back to the server defaults (auto audio, no subtitles).
  useEffect(() => {
    if (!source) {
      setAudio('');
      setSubtitle(-1);
      return;
    }
    const japanese = preferredTrackIndex(source.audioTracks, JAPANESE_TRACK_RE);
    setAudio(japanese !== null ? String(japanese) : '');
    const english = preferredTrackIndex(source.subtitleTracks, ENGLISH_TRACK_RE);
    setSubtitle(english !== null ? english : -1);
  }, [source]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!source) {
      setError("This item can't be played.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created = await api.createLink({
        itemId: item.id,
        mediaSourceId: source.id,
        audioStreamIndex: audio === '' ? undefined : Number(audio),
        subtitleStreamIndex: subtitle,
        preset,
      });
      setResult(created);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const seriesId = item.seriesId;

  return (
    <article className="detail" aria-labelledby="item-heading">
      <Hero
        item={item}
        top={top}
        headingId="item-heading"
        onHeading={seriesId ? () => onBrowse([seriesId]) : undefined}
      >
        {seriesId && item.type === 'Episode' ? (
          <button
            type="button"
            className="btn btn-glass"
            onClick={() => onBrowse(item.seasonId ? [seriesId, item.seasonId] : [seriesId])}
          >
            <Icon name="grid" size={16} />
            All Episodes
          </button>
        ) : null}
      </Hero>

      <div className="wrap">
        {result ? (
          <div className="sheet result">
            <div className="result-head">
              <span className="result-icon">
                <Icon name="check" size={20} />
              </span>
              <div>
                <h2>Link Ready</h2>
                <p className="lead">Expires {relativeExpiry(result.expiresAt)}</p>
              </div>
            </div>
            <div className="input-row">
              <input
                type="text"
                className="mono"
                readOnly
                value={result.url}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Playback link"
              />
              <CopyButton value={result.url} label="Copy Link" className="btn btn-primary" />
            </div>
            <p className="callout" role="note">
              <Icon name="alert" size={16} />
              <span>
                This link is shown only once. Anyone with it can watch until it expires or you
                revoke it.
              </span>
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setResult(null)}>
                Create Another
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="sheet">
            <h2>New Link</h2>

            {item.mediaSources.length === 0 ? (
              <ErrorBanner message="This item can't be played." />
            ) : null}

            <div className="field-grid">
              {item.mediaSources.length > 1 ? (
                <div className="field-span">
                  <Field label="Version" htmlFor="cfg-source">
                    <select
                      id="cfg-source"
                      value={source?.id ?? ''}
                      onChange={(event) => setSourceId(event.target.value)}
                      disabled={busy}
                    >
                      {item.mediaSources.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name || candidate.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}

              <Field label="Audio" htmlFor="cfg-audio">
                <select
                  id="cfg-audio"
                  value={audio}
                  onChange={(event) => setAudio(event.target.value)}
                  disabled={busy}
                >
                  <option value="">Auto</option>
                  {(source?.audioTracks ?? []).map((track) => (
                    <option key={track.index} value={track.index}>
                      {formatTrack(track)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Subtitles" htmlFor="cfg-subtitle">
                <select
                  id="cfg-subtitle"
                  value={subtitle}
                  onChange={(event) => setSubtitle(Number(event.target.value))}
                  disabled={busy}
                >
                  <option value={-1}>None</option>
                  {(source?.subtitleTracks ?? []).map((track) => (
                    <option key={track.index} value={track.index}>
                      {formatTrack(track)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <fieldset className="fieldset">
              <legend>Quality</legend>
              <div className="choice-row">
                {PRESETS.map((option) => (
                  <label key={option.id} className="choice">
                    <input
                      type="radio"
                      name="preset"
                      value={option.id}
                      checked={preset === option.id}
                      onChange={() => setPreset(option.id)}
                      disabled={busy}
                    />
                    <span className="choice-text">
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </span>
                    <span className="choice-check">
                      <Icon name="check" size={14} />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error ? <ErrorBanner message={error} /> : null}

            <div className="actions">
              <button
                type="submit"
                className="btn btn-primary btn-large"
                disabled={busy || item.mediaSources.length === 0}
              >
                {busy ? <Spinner label="Creating link" /> : <Icon name="link" />}
                Create Link
              </button>
            </div>
          </form>
        )}
      </div>
    </article>
  );
}
