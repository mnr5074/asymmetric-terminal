# Asymmetric Terminal — read-only dashboard. Node 20 (server, zero deps) + Python 3 (research collector, stdlib only).
FROM node:20-slim
LABEL org.opencontainers.image.title="Asymmetric Terminal" \
      org.opencontainers.image.description="Read-only multi-chain token dashboard, rug scanner, moonshot research and macro panel"
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY research ./research
COPY scripts/start.sh ./scripts/start.sh
# Seed snapshot of research outputs (analysis/screener JSON) so the Moonshot tab works even on an ephemeral disk
COPY data/analysis.json data/screener.json data/macro_events.json ./seed/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 PUBLIC_MODE=1 DATA_DIR=/app/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "scripts/start.sh"]
