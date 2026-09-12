# Frontend handoff report

## Scope delivered
Owned files only: `index.html`, `vite.config.ts`, `tsconfig.client.json`, `src/client/**`, this report. Did not touch `package.json`, lockfile, server/shared, or root tsconfigs.

## Files
- `index.html` — root mount + module entry.
- `vite.config.ts` — React plugin, `build.outDir=dist/client`, dev server `:5173`, proxies `/api`, `/health`, `/s` → `http://localhost:3000`.
- `tsconfig.client.json` — strict, `react-jsx`, DOM libs, `noEmit`, `verbatimModuleSyntax`, includes only `src/client`.
- `src/client/env.d.ts` — local `*.css` module declaration (avoids depending on Vite client types).
- `src/client/types.ts` — local type contract mirroring `docs/architecture.md` API (ItemDetails, MediaSource, Track, LinkSummary, CreateLinkRequest/Response, StatusResponse, LibraryResponse). Switch to type-only imports from `src/shared/contracts.ts` at integration.
- `src/client/api.ts` — in-memory admin token, `Authorization: Bearer`, JSON/204 handling, normalized `{error:{code,message}}` parsing, `ApiError`, global 401 handler, network error mapping, `itemLabel`.
- `src/client/format.ts` — date/time, runtime, track, relative-expiry formatters.
- `src/client/App.tsx` — token gate → status check, tab state, global busy bar, 401 auto-lock, not-configured warning, footer with sanitized URLs.
- `src/client/components/` — `TokenGate`, `ResolvePanel`, `LibraryPanel`, `ItemPanel`, `LinksPanel`, `ui.tsx` (Spinner, ErrorBanner, EmptyState, CopyButton, Field).
- `src/client/styles.css` — plain dark CSS, system fonts, responsive breakpoints, reduced-motion support.

## Behavior vs contract
- POST /api/resolve primary flow; GET /api/library?query&startIndex&limit (24/page, prev/next, total); GET /api/items/:id on card click.
- Config: media source, audio (Auto or index), subtitles (None = -1 or index), preset 1080p/720p, start seconds, expiry 1–168h; client-side range checks then POST /api/links.
- Created URL shown once with copy + bearer-link warning; GET /api/links list with revoked/expired states; DELETE /api/links/:id with two-step confirm.
- No mock data: every view is API-driven with loading/error/empty states; accessible labels, `role=alert/status`, `aria-live`, keyboard focus.

## Verification (real installed deps from root `node_modules`)
- `./node_modules/.bin/tsc -p tsconfig.client.json --noEmit` → exit 0.
- `./node_modules/.bin/vite build` → exit 0 (37 modules; dist/client emitted; artifact removed after check to avoid colliding with backend build).
- Also compiled/built against an isolated temp install before backend deps existed — both exit 0.

## Remaining limits / integration notes
- Local types until `src/shared/contracts.ts` exists; no runtime coupling yet.
- No live backend run (backend still in progress); API paths follow the architecture contract exactly.
- Library paging uses simple page steps, not infinite scroll; episodes show series/season/episode label plus name.
