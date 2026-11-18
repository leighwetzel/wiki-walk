# Wiki Walk

Leigh's family iPhone web app: nearby Wikipedia articles (English + French) sorted by distance, a map, and read-aloud. Live at https://walk.xoleigh.com. Built for a November 2026 France trip (Rhône/Saône cruise, then Beaune), and now a keeper project. It's one of her xoleigh.com side projects and shares TV Rex's look (the "xoleigh apps" design system: blue #2864B4 on #F1F4F8, system font, rounded cards).

## How it's built
- Static PWA, no build step: `index.html`, `style.css`, `lib.js` (pure helpers, testable in Node), `app.js` (all UI), `sw.js` (service worker), `vendor/leaflet/`.
- Hosted on GitHub Pages from `main`, at the root. `CNAME` = walk.xoleigh.com. Pushing to `main` deploys in about a minute.
- Data lives on the phone: localStorage for settings (including the OpenAI key) and IndexedDB for articles, places, translations and AI audio. The home-screen app and Safari don't share storage.

## Shipping a change (every time)
Bump the version in all four places together, or phones end up running mismatched files:
1. `VERSION` in `app.js`
2. `data-v` on `<html>` in `index.html`
3. the `?v=` on the css/js links in `index.html`
4. `CACHE` in `sw.js`

Put the version in the commit message, e.g. `(v1.4.7)`. After pushing, tell Leigh to fully close and reopen the app and check Settings → Version.

## Testing
The sandbox can't reach Wikipedia, OpenAI, Nominatim or the live site. Run `python3 -m http.server` in the repo and drive it with Playwright, mocking `*.wikipedia.org`, `api.openai.com`, `nominatim.openstreetmap.org` and `tile.openstreetmap.org` with `context.route`. Use `service_workers="block"` unless you're testing offline behavior. Be clear with Leigh about what was tested with mocks and what still needs her phone.

## Decisions to keep
- **Wikipedia:** geosearch on en + fr (`ggslimit` 300, `ggsprimary=all`). French pages with an English twin show as English, with the French name underneath. French-only pages are tagged FR and translated by AI only when opened, then cached.
- **AI voice:** OpenAI `gpt-4o-mini-tts`, with the iPhone voice as fallback when there's no key, no signal or an error. The key is entered per device and never goes in the repo (the repo is public). All OpenAI calls go through one queue, one at a time, with retry on 429 (new accounts have low per-minute limits).
- **Translation models:** tried in order: `gpt-5-mini`, `gpt-4.1-mini`, `gpt-4o-mini`. Update the list as OpenAI retires models.
- **Map:** Leaflet + OSM tiles. Only tiles already viewed are cached; bulk prefetch breaks OSM's tile policy. The map loads places for the visible area (zoom 12+).
- **Address search:** Nominatim, only on submit (never as-you-type), per its usage policy.
- **iOS limits:** the iPhone voice stops when the screen locks, so the app keeps the screen on while playing (wake lock, iOS 18.4+ in home-screen apps). The AI voice is regular audio and may keep playing while locked; that's untested on a real phone.

## Leigh's preferences for this project
Ship small, working changes fast; she tests on her iPhone right away. Explain in plain language what changed and how to get it. No jargon.

## Backlog / ideas
- "Save this area" button: download the nearby list plus article text on Wi-Fi for dead zones.
- Optional relay server if OpenAI ever blocks direct browser calls.
- Approximate stop coordinates in `lib.js` (`STOPS`) are town centers; add new trip stops there.

## Analytics
Google Analytics uses the standard gtag.js snippet for measurement ID `G-X6FH2TP6C8` (stream "xoleigh (all)", added Nov 16, 2026), right after `<meta charset>` in `index.html`. One GA4 stream covers xoleigh.com and the walk/tv subdomains; keep the same snippet on all three. (A GTM container, GTM-K6GPQTLB, was tried first and replaced; don't add both or visits double count.)

## Release notes (shown on xoleigh.com)

When you ship a change people will notice, add a line at the top of `updates.json` in the same commit: `{"date": "YYYY-MM-DD", "text": "..."}`. One short sentence, written the way you'd tell a relative (no jargon, no internal names). Skip fixes nobody would notice, and group same-day changes. The xoleigh.com home page reads this file live, so nothing else needs updating.
