# Phase 10 — Non-Functional Polish

Applies SPEC.md §11: mobile-first responsiveness, reconnect-safety
verification, accessibility, and clean loading/empty/error states for
room-not-found, room-full, and room-already-started.

## The one real gap: room-full was entirely unimplemented

`rooms.max_players` has existed since Phase 1, and the create-room form
has let a host set it since Phase 2 — but nothing ever enforced it. Phase
1's own notes flagged this explicitly ("No max-player-count enforcement at
the DB level ... deferred to app logic or a trigger later") and it stayed
that way through Phase 9. A host could cap a room at 4 players and a 5th
person would join without any error, anywhere.

Fixed with a matched pair, same pattern as everywhere else server-side
enforcement lives in this codebase (app-level for a friendly error message
+ RLS as the actual boundary):

- **`lib/rooms/index.ts`** — new `RoomFullError`; `joinRoomByCode` now
  counts current players against `room.max_players` before inserting a
  new one (reconnecting players are exempt — see below).
- **`supabase/migrations/20260806121000_room_full_guard.sql`** — tightens
  `players_insert_self_join_lobby` (the same policy from Phase 1, not a
  new overlapping one) to also require the count-under-cap condition.
  This is what actually closes the race the app-level check alone can't:
  two people submitting the join form for the last open seat at the same
  moment could both pass the count check before either insert lands: RLS
  runs its `with check` as part of each insert's own statement, so it's
  the one that can't be raced.
- **`app/api/rooms/join/route.ts`** — `RoomFullError` → HTTP 409.
- **`RoomClient.tsx`** — a new pre-join check: someone landing on a room
  link who isn't already a member, with the room still in `lobby` but at
  capacity, now sees a dedicated "Room is full" screen instead of the
  join form. An *existing* member is never affected by this — a room
  filling up around them after they joined doesn't evict them on refresh,
  by design (the check only runs for new joins, both at the RLS level and
  in `joinRoomByCode`).

## Loading/empty/error states

New `app/components/StatusScreen.tsx` — one shared shell for
room-not-found, room-full, room-already-started, the initial "loading
room…" state, and generic errors, instead of four-plus copies of similar
but subtly-inconsistent JSX. Three `kind`s map to the right ARIA role:
`"loading"` → `role="status"` + `aria-busy`, `"info"` → `role="status"`
+ `aria-live="polite"` (a calm, non-error state the visitor should be told
about), `"error"` → `role="alert"`. `RoomClient.tsx`'s not-found/
already-started/room-full/generic-error branches all route through it now;
the "known member" and "join form" branches stay as plain `<main>` since
they're the actual product UI, not a state screen.

## Accessibility

Aria labels on the yes/no buttons and turn indicator were already done in
Phase 6b (`aria-label="Answer yes"`/`"Answer no"`, `role="status"
aria-live="polite"` on the turn indicator) — verified still correct, not
re-done. What Phase 10 added:

- **Global `:focus-visible` styles** (`globals.css`) for every interactive
  element — previously only `.who-am-i-card` had its own focus ring;
  everything else relied on inconsistent browser defaults.
- **Skip-to-content link** (`app/layout.tsx` + `.skip-link`), landing on a
  new `id="main-content"` added to every page's `<main>`.
- **`prefers-reduced-motion` handling** — freezes the typing-pulse
  animation and the new loading spinner to a static frame rather than
  removing the animation's information entirely.
- **Contrast fix**: `--danger` (used for `.field-error` text, among other
  things) measured ~4.38:1 against white — just under WCAG AA's 4.5:1 for
  normal-size text. Changed `#d64545` → `#c0392b` (~5.4:1).
- **Viewport**: explicit `viewport` export in `layout.tsx` rather than
  relying on Next's default, deliberately *not* setting
  `maximum-scale`/`user-scalable` so pinch-zoom keeps working (WCAG 1.4.4)
  — this only pins the initial layout width, never disables zooming.

## Mobile-first responsiveness

Most of the app was already mobile-first by construction (single-column
flex/grid layouts that only add columns at a wider breakpoint — see
`.two-up`, already `min-width: 640px`-gated since Phase 2). What Phase 10
tightened:

- **Touch targets**: `min-height: 44px` globally on buttons and the
  character-board cards (WCAG 2.5.5 / platform guidance minimum),
  `touch-action: manipulation` + tap-highlight reset to kill the
  double-tap-zoom delay and grey flash on iOS.
- **Yes/No buttons** now grow to fill their row (`flex: 1`) instead of
  sitting at `fit-content` width, so they're easier to hit reliably with a
  thumb.
- **`@media (max-width: 480px)`** block: tighter page padding, a smaller
  `minmax()` floor on the 25-character grid (96px → 78px) so it settles
  into a clean 4-column layout around a typical phone width instead of an
  awkward 2-point-something columns, and full-width action buttons in a
  couple of spots where two side-by-side controls were cramped.

## Reconnect-safety

See `supabase/RECONNECT_VERIFICATION.md` for the full breakdown of what
was already correct (everything load-bearing was already
Postgres-backed and re-read on every mount, per SPEC.md §9's design) vs.
what Phase 10 actually added: `visibilitychange`/`online`/`pageshow`
listeners in `RoomClient.tsx` and `WhoAmIRoomView` that re-sync straight
from Postgres when a backgrounded tab/phone comes back, as a backstop to
Realtime's own reconnect logic rather than a replacement for it.

## Verified, not touched

- `npx tsc --noEmit` — clean.
- `npm run build` — clean (all 15 routes compile/prerender as expected).
- `npm run lint` — clean, no warnings.
- No changes to game logic, turn state machine, RLS beyond the one
  targeted room-full policy edit, or any API route's actual behavior
  besides the new `RoomFullError` branch in `/api/rooms/join`.

## Open items / not done in this phase

- No UI for a host to *change* `max_players` after room creation — the
  room-full copy intentionally doesn't imply that's possible ("ask the
  host to open a new room" rather than "raise the limit").
- Dark-mode contrast wasn't independently re-verified pixel-for-pixel —
  `color-scheme: light dark` plus currentColor-based borders should carry
  over reasonably, but the fixed hex colors (`--accent`, `--danger`,
  `--online`) weren't separately contrast-checked against a dark
  background.
- The reconnect-safety listeners are a backstop, not a guarantee — if
  Postgres itself is unreachable when a resync fires, the UI just quietly
  keeps showing the last state it had (matching the codebase's existing
  fail-open philosophy from Phase 9's rate limiter) rather than surfacing
  a background-refresh error.
