# StrikeZone — production image
FROM node:20-alpine

WORKDIR /app

# install deps first (layer cache)
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --workspaces --include-workspace-root || npm install --omit=dev

# client build needs dev deps (esbuild)
RUN npm install --no-save esbuild@^0.24.0
COPY shared/ shared/
COPY client/ client/
RUN node client/build.js

# server sources
COPY server/ server/

ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server/src/index.js"]
