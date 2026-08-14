package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/mupt-ai/self-bench/eval-studio/internal/eval"
)

var ErrNotFound = errors.New("evaluation not found")
var ErrConflict = errors.New("evaluation already exists")

type Store struct {
	db *sql.DB
}

func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening SQLite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(time.Minute)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("pinging SQLite: %w", err)
	}
	if _, err := db.ExecContext(ctx, `
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS evaluations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			benchmark TEXT NOT NULL,
			uploaded_at INTEGER NOT NULL,
			payload BLOB NOT NULL
		);
		CREATE INDEX IF NOT EXISTS evaluations_uploaded_at_idx
			ON evaluations(uploaded_at DESC);
	`); err != nil {
		db.Close()
		return nil, fmt.Errorf("initializing SQLite: %w", err)
	}

	return &Store{db: db}, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) Create(ctx context.Context, evaluation eval.Evaluation) error {
	payload, err := json.Marshal(evaluation)
	if err != nil {
		return fmt.Errorf("encoding evaluation: %w", err)
	}
	_, err = store.db.ExecContext(
		ctx,
		`INSERT INTO evaluations (id, name, benchmark, uploaded_at, payload)
		 VALUES (?, ?, ?, ?, ?)`,
		evaluation.ID,
		evaluation.Name,
		evaluation.Benchmark,
		evaluation.UploadedAt.UnixNano(),
		payload,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return fmt.Errorf("inserting evaluation: %w", err)
	}
	return nil
}

func (store *Store) List(ctx context.Context) ([]eval.Summary, error) {
	rows, err := store.db.QueryContext(ctx, `SELECT payload FROM evaluations ORDER BY uploaded_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("querying evaluations: %w", err)
	}
	defer rows.Close()

	summaries := []eval.Summary{}
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("scanning evaluation: %w", err)
		}
		var evaluation eval.Evaluation
		if err := json.Unmarshal(payload, &evaluation); err != nil {
			return nil, fmt.Errorf("decoding evaluation: %w", err)
		}
		summaries = append(summaries, evaluation.Summary())
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating evaluations: %w", err)
	}
	return summaries, nil
}

func (store *Store) Get(ctx context.Context, id string) (eval.Evaluation, error) {
	var payload []byte
	err := store.db.QueryRowContext(
		ctx,
		`SELECT payload FROM evaluations WHERE id = ?`,
		id,
	).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return eval.Evaluation{}, ErrNotFound
	}
	if err != nil {
		return eval.Evaluation{}, fmt.Errorf("querying evaluation: %w", err)
	}

	var evaluation eval.Evaluation
	if err := json.Unmarshal(payload, &evaluation); err != nil {
		return eval.Evaluation{}, fmt.Errorf("decoding evaluation: %w", err)
	}
	return evaluation, nil
}

func (store *Store) Delete(ctx context.Context, id string) error {
	result, err := store.db.ExecContext(ctx, `DELETE FROM evaluations WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("deleting evaluation: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("reading deleted row count: %w", err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func isUniqueViolation(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "UNIQUE constraint failed") || strings.Contains(err.Error(), "constraint failed"))
}
