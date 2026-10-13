# ---- Backend (Express) ----
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=4010
EXPOSE 4010

CMD ["node", "src/server.js"]
