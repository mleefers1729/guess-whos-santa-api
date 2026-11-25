FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir -p certs && node --input-type=module -e \
  "import { writeFile } from 'node:fs/promises'; const r = await fetch('https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem'); if (!r.ok) throw new Error('RDS CA download failed: ' + r.status); await writeFile('certs/rds.pem', await r.text());"
COPY --chown=node:node src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
