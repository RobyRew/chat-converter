# ChatConverter
A web based tool to convert chat exports of popular messaging apps like Telegram, WhatsApp, Instagram, etc.

## Analytics (optional)

Self-hosted Umami can be wired at deploy time without rebuilding. In Dokploy → this app → **Environment**, set:

| Variable | Value |
|---|---|
| `UMAMI_SCRIPT_URL` | `https://stats.cosmincalin.es/script.js` |
| `UMAMI_WEBSITE_ID` | UUID from Umami → Settings → Websites |

A startup script in the container (`docker-entrypoint.d/30-inject-umami.sh`) substitutes a `<!-- UMAMI -->` placeholder in `index.html` with the real `<script defer …>` tag, with `data-do-not-track="true"` honouring browser DNT. If either env var is missing the placeholder is just stripped — no broken script tag ships.
