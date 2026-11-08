# syntax=docker/dockerfile:1.10
# chat-converter.robyrew.com: the Astro site in web/ on the shared static-web runtime (RobyRew/platform).
# Build context = repo root, because web/ takes the library from it ("@robyrew/chat-converter": "file:..").
FROM node:22-alpine AS build
WORKDIR /app
# git: web/'s @robyrew/web-config is a github: tag dependency, which npm can clone.
RUN apk add --no-cache git
# The root install comes first: when Vite bundles ../src through the file:.. link, the library's
# dependencies (and zod, its peer) resolve from /app/node_modules.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web --no-audit --no-fund
COPY . .
RUN npm run build --prefix web

# Shared runtime: pinned, non-root, port 8080, one security-header set. The default CSP fits: the
# converter's worker is a same-origin file, and the page loads nothing from other hosts.
FROM ghcr.io/robyrew/static-web:1
# Astro emits extensionless URLs; $uri is escaped so nginx receives it literally (Docker would
# substitute an undefined $uri with an empty string).
ENV WEB_FALLBACK="\$uri/index.html \$uri.html =404"
COPY --from=build --chown=nginx:nginx /app/web/dist /usr/share/nginx/html
