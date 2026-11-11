# wiki-walk

Nearby English Wikipedia articles, sorted by distance, with read-aloud. An iPhone web app (PWA) for walking around towns on a France trip.

Live at https://walk.xoleigh.com

**Install:** open the link in Safari → Share → Add to Home Screen. Allow location when asked.

## Current (v1.1)
- Nearby list by distance and compass direction (0.25–2 mi radius)
- Full article reader with text size control, Directions (Apple Maps) and Wikipedia links
- Tap-to-play read-aloud: pause/resume, paragraph skip, speed, voice picker, keep-screen-on
- Articles you open and places you've seen are saved on the phone and work offline
- "Browse from a stop" fallback when GPS isn't available
- Map view (OpenStreetMap) with pins; tiles you've viewed are kept for offline
- French Wikipedia: French-only places tagged FR and translated to English by AI when opened (cached for offline)
- AI voice (OpenAI gpt-4o-mini-tts) when an API key is entered in Settings; audio is saved for offline replay. Falls back to the iPhone voice.

## Next
- Release 2: preload each stop on Wi-Fi for offline use

Static files only (no build step). `lib.js` holds pure helpers; `app.js` the UI; `sw.js` caches the app shell. Bump `CACHE` in `sw.js` and `VERSION` in `app.js` on each release so phones pick up the update.
