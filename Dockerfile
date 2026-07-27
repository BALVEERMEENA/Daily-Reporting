# Daily Reporting — production container image.
# Works on any container host (Render, Railway, Fly.io, a VPS, etc.).
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Keep the SQLite database on a mounted volume so data survives restarts.
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]
