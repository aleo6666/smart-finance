FROM node:22-alpine

RUN apk add --no-cache python3 make g++ pkgconfig \
    cairo-dev pango-dev pixman-dev giflib-dev jpeg-dev freetype-dev

WORKDIR /app

# Use Chinese mirrors for node-gyp headers (GFW workaround)
ENV NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --only=production

COPY src/ ./src/

RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "src/index.js"]
