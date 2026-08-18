-- ---------------------------------------------------------------------------
-- Avatar look persistence: store each player's chosen mushroom (color) and
-- accessory alongside their nickname, so room members actually see each
-- other's look (not just a name) - previously the avatar creator
-- (app/components/AvatarCreator.tsx) was purely client-side and these
-- choices never left the browser.
--
-- Indices, not names/ids: matches how the client already tracks selection
-- (lib/avatar.ts's MUSHROOMS/ACCESSORIES arrays), and keeps this table
-- decoupled from the specific art catalog - renaming/reordering swatches in
-- lib/avatar.ts never requires a migration. `mushroom_index` defaults to 0
-- (not nullable) since every player has *some* look; `accessory_index`
-- defaults to 0, which lib/avatar.ts reserves for "None".
--
-- Bounds are intentionally loose (>= 0 only, no upper bound) rather than
-- hard-coding the current array lengths (8 mushrooms / 13 accessories) into
-- a check constraint: the art catalog is expected to grow, and an
-- out-of-range index is harmless (lib/avatar.ts's getMushroom/getAccessory
-- already clamp to a safe fallback when rendering). The app layer
-- (lib/rooms/index.ts) still validates against the current catalog length
-- before insert/update so a bogus client can't stuff an absurd value in.
alter table public.players
  add column mushroom_index int not null default 0 check (mushroom_index >= 0),
  add column accessory_index int not null default 0 check (accessory_index >= 0);
