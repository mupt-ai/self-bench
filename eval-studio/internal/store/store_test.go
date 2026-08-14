package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/mupt-ai/self-bench/eval-studio/internal/eval"
)

func TestStoreLifecycle(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dataStore, err := Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	evaluation := eval.Evaluation{
		ID:         "eval-1",
		Name:       "Example",
		Benchmark:  "SWE-bench",
		UploadedAt: time.Date(2026, time.August, 11, 12, 0, 0, 0, time.UTC),
		Runs: []eval.Run{{
			ID: "run-1", Name: "Run", Model: "model", Provider: "provider", Harness: "harness", ThinkingLevel: "high",
			Results: []eval.TaskResult{{TaskID: "task-1", TaskName: "Task", Passed: true, Score: 1, CostUSD: 0.25}},
		}},
	}
	if err := dataStore.Create(ctx, evaluation); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := dataStore.Create(ctx, evaluation); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate Create() error = %v, want ErrConflict", err)
	}

	summaries, err := dataStore.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 1 || summaries[0].TotalCost != 0.25 {
		t.Fatalf("List() = %#v", summaries)
	}

	loaded, err := dataStore.Get(ctx, "eval-1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if loaded.Runs[0].Model != "model" {
		t.Fatalf("loaded model = %q", loaded.Runs[0].Model)
	}

	if err := dataStore.Delete(ctx, "eval-1"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := dataStore.Get(ctx, "eval-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() after delete error = %v, want ErrNotFound", err)
	}
}
