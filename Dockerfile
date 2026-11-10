# NGRM platform. Build: docker build -t ngrm .   Run: docker run -p 3000:3000 -v ngrm-data:/data ngrm
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=3000 DB_FILE=/data/ngrm.sqlite
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server/index.js"]
