FROM node:22.21.1-alpine

# better-sqlite3 原生编译所需工具链
RUN apk add --no-cache python3 make g++ wget pkgconfig cairo-dev pango-dev pixman-dev jpeg-dev giflib-dev librsvg-dev

WORKDIR /app

# 依赖层（利用 Docker 缓存）
COPY package.json package-lock.json ./
RUN npm ci

# 源代码
COPY src/ ./src/

# 确保数据目录存在
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
