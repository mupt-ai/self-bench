package importer

import (
	"bytes"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mupt-ai/self-bench/eval-studio/internal/eval"
)

const maxUploadBytes = 25 << 20

var requiredCSVHeaders = []string{
	"evaluation_name",
	"benchmark",
	"run_name",
	"model",
	"provider",
	"harness",
	"thinking_level",
	"task_id",
	"passed",
	"score",
	"cost_usd",
}

func Parse(filename string, reader io.Reader) (eval.Evaluation, error) {
	contents, err := io.ReadAll(io.LimitReader(reader, maxUploadBytes+1))
	if err != nil {
		return eval.Evaluation{}, fmt.Errorf("reading upload: %w", err)
	}
	if len(contents) > maxUploadBytes {
		return eval.Evaluation{}, fmt.Errorf("upload exceeds %d MiB", maxUploadBytes>>20)
	}

	extension := strings.ToLower(filepath.Ext(filename))
	var evaluation eval.Evaluation
	switch extension {
	case ".csv":
		evaluation, err = parseCSV(bytes.NewReader(contents))
	case ".json":
		evaluation, err = parseJSON(contents)
	default:
		return eval.Evaluation{}, errors.New("upload a .csv or .json file")
	}
	if err != nil {
		return eval.Evaluation{}, err
	}

	evaluation.SourceFile = filepath.Base(filename)
	if evaluation.ID == "" {
		evaluation.ID = newID("eval")
	}
	if evaluation.UploadedAt.IsZero() {
		evaluation.UploadedAt = time.Now().UTC()
	}
	for runIndex := range evaluation.Runs {
		if evaluation.Runs[runIndex].ID == "" {
			evaluation.Runs[runIndex].ID = newID("run")
		}
	}
	if err := Validate(evaluation); err != nil {
		return eval.Evaluation{}, err
	}

	return evaluation, nil
}

func Validate(evaluation eval.Evaluation) error {
	if strings.TrimSpace(evaluation.Name) == "" {
		return errors.New("evaluation name is required")
	}
	if strings.TrimSpace(evaluation.Benchmark) == "" {
		return errors.New("benchmark is required")
	}
	if len(evaluation.Runs) == 0 {
		return errors.New("at least one run is required")
	}

	runIDs := make(map[string]int, len(evaluation.Runs))
	for runIndex, run := range evaluation.Runs {
		row := fmt.Sprintf("run %d", runIndex+1)
		if strings.TrimSpace(run.Name) == "" {
			return fmt.Errorf("%s: name is required", row)
		}
		if strings.TrimSpace(run.Model) == "" {
			return fmt.Errorf("%s: model is required", row)
		}
		if strings.TrimSpace(run.Provider) == "" {
			return fmt.Errorf("%s: provider is required", row)
		}
		if strings.TrimSpace(run.Harness) == "" {
			return fmt.Errorf("%s: harness is required", row)
		}
		if strings.TrimSpace(run.ThinkingLevel) == "" {
			return fmt.Errorf("%s: thinking_level is required", row)
		}
		if len(run.Results) == 0 {
			return fmt.Errorf("%s: at least one task result is required", row)
		}
		if run.ID != "" {
			if previous, ok := runIDs[run.ID]; ok {
				return fmt.Errorf("run %d reuses run id %q from run %d", runIndex+1, run.ID, previous+1)
			}
			runIDs[run.ID] = runIndex
		}

		taskIDs := make(map[string]struct{}, len(run.Results))
		for resultIndex, result := range run.Results {
			field := fmt.Sprintf("%s result %d", row, resultIndex+1)
			if strings.TrimSpace(result.TaskID) == "" {
				return fmt.Errorf("%s: task_id is required", field)
			}
			if _, ok := taskIDs[result.TaskID]; ok {
				return fmt.Errorf("%s: task_id %q is repeated within %s", field, result.TaskID, row)
			}
			taskIDs[result.TaskID] = struct{}{}
			if result.Score < 0 || result.Score > 1 {
				return fmt.Errorf("%s: score must be between 0 and 1", field)
			}
			if result.CostUSD < 0 {
				return fmt.Errorf("%s: cost_usd cannot be negative", field)
			}
			if result.DurationMS < 0 {
				return fmt.Errorf("%s: duration_ms cannot be negative", field)
			}
			if result.InputTokens < 0 {
				return fmt.Errorf("%s: input_tokens cannot be negative", field)
			}
			if result.OutputTokens < 0 {
				return fmt.Errorf("%s: output_tokens cannot be negative", field)
			}
		}
	}

	return nil
}

func parseJSON(contents []byte) (eval.Evaluation, error) {
	var evaluation eval.Evaluation
	if err := json.Unmarshal(contents, &evaluation); err != nil {
		return eval.Evaluation{}, fmt.Errorf("parsing JSON: %w", err)
	}
	return evaluation, nil
}

func parseCSV(reader io.Reader) (eval.Evaluation, error) {
	csvReader := csv.NewReader(reader)
	csvReader.TrimLeadingSpace = true
	records, err := csvReader.ReadAll()
	if err != nil {
		return eval.Evaluation{}, fmt.Errorf("parsing CSV: %w", err)
	}
	if len(records) < 2 {
		return eval.Evaluation{}, errors.New("CSV must include a header and at least one result row")
	}

	indexes, err := headerIndexes(records[0])
	if err != nil {
		return eval.Evaluation{}, err
	}

	first := records[1]
	evaluation := eval.Evaluation{
		Name:        value(first, indexes["evaluation_name"]),
		Description: optionalValue(first, indexes, "description"),
		Benchmark:   value(first, indexes["benchmark"]),
		Runs:        []eval.Run{},
	}
	runIndexes := map[string]int{}

	for rowIndex, record := range records[1:] {
		rowNumber := rowIndex + 2
		runKey := strings.Join([]string{
			value(record, indexes["run_name"]),
			value(record, indexes["model"]),
			value(record, indexes["provider"]),
			value(record, indexes["harness"]),
			value(record, indexes["thinking_level"]),
		}, "\x00")
		if runKey == "\x00\x00\x00\x00" {
			return eval.Evaluation{}, fmt.Errorf("row %d: run metadata is required", rowNumber)
		}

		runIndex, ok := runIndexes[runKey]
		if !ok {
			runIndex = len(evaluation.Runs)
			runIndexes[runKey] = runIndex
			evaluation.Runs = append(evaluation.Runs, eval.Run{
				Name:          value(record, indexes["run_name"]),
				Model:         value(record, indexes["model"]),
				Provider:      value(record, indexes["provider"]),
				Harness:       value(record, indexes["harness"]),
				ThinkingLevel: value(record, indexes["thinking_level"]),
				Results:       []eval.TaskResult{},
			})
		}

		result, err := parseResult(record, indexes)
		if err != nil {
			return eval.Evaluation{}, fmt.Errorf("row %d: %w", rowNumber, err)
		}
		evaluation.Runs[runIndex].Results = append(evaluation.Runs[runIndex].Results, result)
	}

	return evaluation, nil
}

func headerIndexes(header []string) (map[string]int, error) {
	indexes := make(map[string]int, len(header))
	for index, raw := range header {
		name := strings.TrimSpace(strings.ToLower(raw))
		indexes[name] = index
	}
	for _, required := range requiredCSVHeaders {
		if _, ok := indexes[required]; !ok {
			return nil, fmt.Errorf("CSV is missing required column %q", required)
		}
	}
	return indexes, nil
}

func parseResult(record []string, indexes map[string]int) (eval.TaskResult, error) {
	passed, err := strconv.ParseBool(value(record, indexes["passed"]))
	if err != nil {
		return eval.TaskResult{}, fmt.Errorf("passed must be true or false: %w", err)
	}
	score, err := parseFloat(value(record, indexes["score"]), "score")
	if err != nil {
		return eval.TaskResult{}, err
	}
	cost, err := parseFloat(value(record, indexes["cost_usd"]), "cost_usd")
	if err != nil {
		return eval.TaskResult{}, err
	}
	duration, err := parseInteger(optionalValue(record, indexes, "duration_ms"), "duration_ms")
	if err != nil {
		return eval.TaskResult{}, err
	}
	inputTokens, err := parseInteger(optionalValue(record, indexes, "input_tokens"), "input_tokens")
	if err != nil {
		return eval.TaskResult{}, err
	}
	outputTokens, err := parseInteger(optionalValue(record, indexes, "output_tokens"), "output_tokens")
	if err != nil {
		return eval.TaskResult{}, err
	}

	return eval.TaskResult{
		TaskID:       value(record, indexes["task_id"]),
		TaskName:     optionalValue(record, indexes, "task_name"),
		Passed:       passed,
		Score:        score,
		CostUSD:      cost,
		DurationMS:   duration,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		Error:        optionalValue(record, indexes, "error"),
	}, nil
}

func parseFloat(raw string, field string) (float64, error) {
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", field, err)
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, fmt.Errorf("%s must be a finite number", field)
	}
	return parsed, nil
}

func parseInteger(raw string, field string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", field, err)
	}
	return parsed, nil
}

func value(record []string, index int) string {
	if index >= len(record) {
		return ""
	}
	return strings.TrimSpace(record[index])
}

func optionalValue(record []string, indexes map[string]int, field string) string {
	index, ok := indexes[field]
	if !ok {
		return ""
	}
	return value(record, index)
}

func newID(prefix string) string {
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(random[:])
}
