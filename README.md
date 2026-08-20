# Round 2 files — structured data + shared site-url helper

The patch failed because your working copy doesn't match byte-for-byte
(probably line-ending differences from Windows, or a small manual edit).
Easiest fix: just replace these 5 files directly with the versions here —
no `git apply` needed.

## Copy these files into your repo (same relative paths)

- `lib/site.ts` **(new file — create it)**
- `app/sitemap.ts` **(overwrite)**
- `app/robots.ts` **(overwrite — or create it, if round 1 never actually
  created it; that may be why "No such file or directory" showed up)**
- `app/layout.tsx` **(overwrite)**
- `app/games/[game]/page.tsx` **(overwrite)**

On Windows, drag each file from this zip into the matching folder in
`C:\Users\ACER\Downloads\partytogether\party-together\...` and let it
replace the existing one.

## After copying
Run this from inside the `party-together` folder to make sure everything
still compiles:
```
npx tsc --noEmit
```
Then rebuild/redeploy as usual.

## What's new in this round
- `lib/site.ts` — a small shared `getSiteUrl()` helper (used by the other
  4 files instead of repeating the domain fallback in each one).
- `app/games/[game]/page.tsx` — adds JSON-LD structured data to
  `/games/who-am-i` and `/games/who-are-you`:
  - `BreadcrumbList` (Home → Games → game) — the structured data type
    Google supports most reliably for search results.
  - `VideoGame` entry — name, description, image, player count, genre,
    free `Offer`, publisher.
