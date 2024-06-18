# syntax=docker/dockerfile:1

FROM node:lts-alpine AS builder
WORKDIR /src
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:lts-alpine
WORKDIR /app
COPY package*.json ./

ARG SUNO_COOKIE
RUN if [ -z "$SUNO_COOKIE" ]; then echo "SUNO_COOKIE is not set" && exit 1; fi
ENV SUNO_COOKIE=${SUNO_COOKIE}

RUN npm install --only=production
COPY --from=builder /src/.next ./.next
EXPOSE 3000
CMD ["npm", "run", "start"]
