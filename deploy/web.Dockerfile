# Static build of apps/web (landing page at /) served by nginx.
# Build from the repository root: docker build -f deploy/web.Dockerfile .
FROM node:24-bookworm-slim AS build
ENV CI=true \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@audivra/web..."
RUN pnpm --filter @audivra/web build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
