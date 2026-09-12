import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, itemLabel } from '../api';
import { formatDateTime, formatRuntime, formatTrack, relativeExpiry } from '../format';
import type { CreateLinkResponse, ItemDetails, Preset } from '../types';
import { CopyButton, ErrorBanner, Field, Spinner } from './ui';

const MAX_EXPIRY_HOURS = 168;

export function ItemPanel({
  item,
  onClose,
  onCreated,
}: {
  item: ItemDetails;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [sourceId, setSourceId] = useState(item.mediaSources[0]?.id ?? '');
  const [audio, setAudio] = useState('');
  const [subtitle, setSubtitle] = useState(-1);
  const [preset, setPreset] = useState<Preset>('1080p');
  const [startSeconds, setStartSeconds] = useState('0');
  const [expiryHours, setExpiryHours] = useState('24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLinkResponse | null>(null);

  const source = useMemo(
    () => item.mediaSources.find((candidate) => candidate.id === sourceId) ?? item.mediaSources[0],
    [item.mediaSources, sourceId],
  );

  useEffect(() => {
    setSourceId(item.mediaSources[0]?.id ?? '');
    setAudio('');
    setSubtitle(-1);
    setPreset('1080p');
    setStartSeconds('0');
    setExpiryHours('24');
    setResult(null);
    setError(null);
  }, [item]);

  function selectSource(id: string) {
    setSourceId(id);
    setAudio('');
    setSubtitle(-1);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!source) {
      setError('This item has no playable media sources.');
      return;
    }
    const start = Number(startSeconds);
    const expiry = Number(expiryHours);
    if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) {
      setError('Start position must be a whole number of seconds (0 or more).');
      return;
    }
    if (item.runTimeSeconds !== undefined && start > item.runTimeSeconds) {
      setError('Start position is past the end of this item.');
      return;
    }
    if (!Number.isFinite(expiry) || !Number.isInteger(expiry) || expiry < 1 || expiry > MAX_EXPIRY_HOURS) {
      setError(`Expiry must be between 1 and ${MAX_EXPIRY_HOURS} hours.`);
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
        startSeconds: start,
        expiresInHours: expiry,
      });
      setResult(created);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const runtime = formatRuntime(item.runTimeSeconds);

  return (
    <section className="panel panel-accent" aria-labelledby="item-heading">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Configure playback</p>
          <h2 id="item-heading">{itemLabel(item)}</h2>
          {runtime ? <p className="hint">Run time {runtime}</p> : null}
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {item.overview ? <p className="overview">{item.overview}</p> : null}

      {result ? (
        <div className="result">
          <h3>Link created</h3>
          <p className="result-title">{result.title}</p>
          <div className="input-row">
            <input
              type="text"
              readOnly
              value={result.url}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Generated playback URL"
            />
            <CopyButton value={result.url} label="Copy link" />
          </div>
          <p className="warn" role="note">
            Anyone with this link can watch until it is revoked or expires
            {` (${formatDateTime(result.expiresAt)}, ${relativeExpiry(result.expiresAt)})`}. It is
            shown only once; save it now.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setResult(null)}>
              Create another
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="config-form">
          {item.mediaSources.length === 0 ? (
            <ErrorBanner message="No media sources are available for this item." />
          ) : null}

          <Field label="Media source" htmlFor="cfg-source">
            <select
              id="cfg-source"
              value={source?.id ?? ''}
              onChange={(event) => selectSource(event.target.value)}
              disabled={busy || item.mediaSources.length === 0}
            >
              {item.mediaSources.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.id}
                </option>
              ))}
            </select>
          </Field>

          <div className="field-grid">
            <Field label="Audio" htmlFor="cfg-audio">
              <select
                id="cfg-audio"
                value={audio}
                onChange={(event) => setAudio(event.target.value)}
                disabled={busy}
              >
                <option value="">Auto (server default)</option>
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
            <legend>Compatibility preset</legend>
            <div className="radio-row">
              <label className="radio">
                <input
                  type="radio"
                  name="preset"
                  value="1080p"
                  checked={preset === '1080p'}
                  onChange={() => setPreset('1080p')}
                  disabled={busy}
                />
                <span>
                  <strong>1080p</strong>
                  <small>8 Mbps · H.264 / AAC</small>
                </span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="preset"
                  value="720p"
                  checked={preset === '720p'}
                  onChange={() => setPreset('720p')}
                  disabled={busy}
                />
                <span>
                  <strong>720p</strong>
                  <small>4 Mbps · H.264 / AAC</small>
                </span>
              </label>
            </div>
          </fieldset>

          <div className="field-grid">
            <Field
              label="Start at (seconds)"
              htmlFor="cfg-start"
              hint={runtime ? `0 to ${item.runTimeSeconds ?? 0} · run time ${runtime}` : '0 to start from the beginning.'}
            >
              <input
                id="cfg-start"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={startSeconds}
                onChange={(event) => setStartSeconds(event.target.value)}
                disabled={busy}
              />
            </Field>

            <Field
              label="Expires in (hours)"
              htmlFor="cfg-expiry"
              hint={`1 to ${MAX_EXPIRY_HOURS} hours.`}
            >
              <input
                id="cfg-expiry"
                type="number"
                min={1}
                max={MAX_EXPIRY_HOURS}
                step={1}
                inputMode="numeric"
                value={expiryHours}
                onChange={(event) => setExpiryHours(event.target.value)}
                disabled={busy}
              />
            </Field>
          </div>

          {error ? <ErrorBanner message={error} /> : null}

          <div className="actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || item.mediaSources.length === 0}
            >
              {busy ? <Spinner label="Creating link" /> : 'Create link'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
