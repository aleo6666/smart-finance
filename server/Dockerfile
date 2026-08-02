FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN rm -rf node_modules && \
    npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev --ignore-engines

COPY src/ ./src/
RUN mkdir -p uploads

EXPOSE 3000
CMD ["node", "src/index.js"]
