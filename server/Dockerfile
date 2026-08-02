FROM node:22-alpine AS build

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/' /etc/apk/repositories && \
    apk add --no-cache \
    python3 \
    make \
    g++ \
    pkgconf \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    pixman-dev

COPY package*.json ./
RUN rm -rf node_modules && \
    npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev --ignore-engines

FROM node:22-alpine

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/' /etc/apk/repositories && \
    apk add --no-cache \
    cairo \
    pango \
    libjpeg-turbo \
    giflib \
    pixman

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY src/ ./src/
RUN mkdir -p uploads

EXPOSE 3000
CMD ["node", "src/index.js"]
