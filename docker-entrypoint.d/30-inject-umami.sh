#!/bin/sh
# Replace the <!-- UMAMI --> placeholder in served HTML with the real
# Umami <script> tag at container start. Skips injection when either env
# var is missing — the placeholder is just stripped, page ships clean.
#
# Required env (set in Dokploy → App → Environment):
#   UMAMI_SCRIPT_URL  e.g. https://stats.cosmincalin.es/script.js
#   UMAMI_WEBSITE_ID  the UUID Umami assigns to this site
#
# Runs once per container start. `nginx:alpine` and `nginx-unprivileged`
# images both execute /docker-entrypoint.d/*.sh before the nginx master starts.

set -eu

HTML_DIR=/usr/share/nginx/html
PLACEHOLDER='<!-- UMAMI -->'

if [ ! -d "$HTML_DIR" ]; then
  echo "[inject-umami] $HTML_DIR not found, skipping" >&2
  exit 0
fi

if [ -z "${UMAMI_SCRIPT_URL:-}" ] || [ -z "${UMAMI_WEBSITE_ID:-}" ]; then
  echo "[inject-umami] UMAMI_SCRIPT_URL or UMAMI_WEBSITE_ID unset — stripping placeholder."
  find "$HTML_DIR" -name '*.html' -type f -exec sed -i "s|$PLACEHOLDER||g" {} +
  exit 0
fi

TAG="<script defer src=\"$UMAMI_SCRIPT_URL\" data-website-id=\"$UMAMI_WEBSITE_ID\" data-do-not-track=\"true\"></script>"
ESCAPED=$(printf '%s' "$TAG" | sed -e 's/[\/&|]/\\&/g')

find "$HTML_DIR" -name '*.html' -type f -exec sed -i "s|$PLACEHOLDER|$ESCAPED|g" {} +
echo "[inject-umami] injected $UMAMI_WEBSITE_ID into $(find "$HTML_DIR" -name '*.html' -type f | wc -l) HTML file(s)."
