FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DATA_DIR=/data TZ=Africa/Abidjan NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
