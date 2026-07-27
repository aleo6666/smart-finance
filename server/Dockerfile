FROM node:22.21.1-alpine

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    (apk add --no-cache python3 make g++ pkgconfig \
    cairo-dev pango-dev pixman-dev giflib-dev jpeg-dev freetype-dev || true)

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev

COPY src/ ./src/
RUN mkdir -p uploads

EXPOSE 3000
CMD ["node", "src/index.js"]
