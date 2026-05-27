FROM nginx:alpine

# Copy static files
COPY index.html /usr/share/nginx/html/
COPY script.js /usr/share/nginx/html/
COPY styles.css /usr/share/nginx/html/

# Configure nginx
RUN echo 'server { \
    listen 80; \
    server_name _; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Runtime Umami injection — picks up UMAMI_SCRIPT_URL + UMAMI_WEBSITE_ID from container env.
COPY --chmod=755 docker-entrypoint.d/30-inject-umami.sh /docker-entrypoint.d/30-inject-umami.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
