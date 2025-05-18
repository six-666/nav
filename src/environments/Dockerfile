FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc /app/

RUN npm install -g pm2 tsx pnpm && pnpm install

COPY . /app/

RUN npm run build

VOLUME ["/app/data", "/app/_upload"]

EXPOSE 7777

CMD ["sh", "-c", "npm run init && pm2-runtime start --interpreter tsx src/environments/main.ts"]
