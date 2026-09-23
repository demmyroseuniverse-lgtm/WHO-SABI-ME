FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json README.md .env.example ./
COPY server.js storage.js postgres-storage.js realtime.js app.js index.html style.css sw.js manifest.json ./
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node
EXPOSE 8080
VOLUME ["/app/data", "/app/backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
