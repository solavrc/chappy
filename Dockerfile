FROM node:20-bullseye-slim

WORKDIR /app
COPY ./src/ /app/src
COPY ./package.json /app
RUN npm install

CMD ["-r", "esbuild-register", "/app/src/index.ts"]
