FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS api
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /eval-studio ./cmd/server

FROM alpine:3.22
RUN addgroup -S app && adduser -S -G app app && mkdir /data && chown app:app /data
WORKDIR /app
COPY --from=api /eval-studio /usr/local/bin/eval-studio
COPY --from=web /app/web/dist /app/web/dist
USER app
ENV EVAL_STUDIO_ADDR=:8080 \
    EVAL_STUDIO_DB=/data/eval-studio.db \
    EVAL_STUDIO_STATIC=/app/web/dist
EXPOSE 8080
CMD ["eval-studio"]
