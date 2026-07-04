FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# tsx is a runtime dependency — no build step, TS runs directly (team convention from kept).
CMD ["npx", "tsx", "src/server.ts"]
