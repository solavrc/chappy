FROM node:20-bullseye-slim

RUN apt update -y \
  && apt install curl -y

WORKDIR /app
COPY ./src/ /app/src
COPY ./package.json /app
RUN npm install

CMD ["-r", "esbuild-register", "/app/src/index.ts"]
