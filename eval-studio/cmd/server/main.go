package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mupt-ai/self-bench/eval-studio/internal/api"
	"github.com/mupt-ai/self-bench/eval-studio/internal/store"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databasePath := environment("EVAL_STUDIO_DB", "eval-studio.db")
	dataStore, err := store.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer dataStore.Close()

	var static fs.FS
	staticDirectory := environment("EVAL_STUDIO_STATIC", "web/dist")
	if info, err := os.Stat(staticDirectory); err == nil && info.IsDir() {
		static = os.DirFS(staticDirectory)
	} else {
		logger.Warn("frontend assets are unavailable; serving API only", "directory", staticDirectory)
	}

	adminToken := os.Getenv("EVAL_STUDIO_ADMIN_TOKEN")
	if adminToken == "" {
		logger.Warn("EVAL_STUDIO_ADMIN_TOKEN is unset; uploads and deletions are open to anyone who can reach the listener")
	}

	server := &http.Server{
		Addr: environment("EVAL_STUDIO_ADDR", ":8080"),
		Handler: api.New(api.Options{
			Store:      dataStore,
			Logger:     logger,
			AdminToken: adminToken,
			Static:     static,
		}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	errChannel := make(chan error, 1)
	go func() {
		logger.Info("eval studio listening", "address", server.Addr, "database", databasePath)
		errChannel <- server.ListenAndServe()
	}()

	select {
	case err := <-errChannel:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownContext)
	}
}

func environment(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
