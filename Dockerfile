# Ricky — small production image.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0 \
    SELF_POLL=1

WORKDIR /app

# Install first so the layer is reused when only source changes.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data/audio && chown -R node:node /app

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
