# Node.js edition of the dashboard + scraper. The Playwright image already
# contains Node and the Chromium build that matches the pinned playwright
# version, so nothing is downloaded at build time.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

CMD ["node", "src/dashboard/server.js"]
