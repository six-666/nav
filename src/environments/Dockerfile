FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock /app/

RUN yarn && npm install -g pm2 tsx

COPY . /app/

RUN npm run build

EXPOSE 7777

CMD ["pm2-runtime", "start", "--interpreter", "tsx", "src/environments/main.ts"]