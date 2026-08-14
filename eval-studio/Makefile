.PHONY: dev api web build test clean

api:
	go run ./cmd/server

web:
	cd web && npm run dev

dev:
	@printf '%s\n' 'Run `make api` and `make web` in separate terminals.'

build:
	cd web && npm run build
	go build -o bin/eval-studio ./cmd/server

test:
	go test ./...
	go vet ./...
	cd web && npm run typecheck
	cd web && npm run build

clean:
	rm -rf bin web/dist eval-studio.db
