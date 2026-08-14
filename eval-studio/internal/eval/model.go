package eval

import "time"

type Evaluation struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Benchmark   string    `json:"benchmark"`
	UploadedAt  time.Time `json:"uploaded_at"`
	SourceFile  string    `json:"source_file,omitempty"`
	Runs        []Run     `json:"runs"`
}

type Run struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	Model         string       `json:"model"`
	Provider      string       `json:"provider"`
	Harness       string       `json:"harness"`
	ThinkingLevel string       `json:"thinking_level"`
	StartedAt     *time.Time   `json:"started_at,omitempty"`
	Results       []TaskResult `json:"results"`
}

type TaskResult struct {
	TaskID       string  `json:"task_id"`
	TaskName     string  `json:"task_name"`
	Passed       bool    `json:"passed"`
	Score        float64 `json:"score"`
	CostUSD      float64 `json:"cost_usd"`
	DurationMS   int64   `json:"duration_ms,omitempty"`
	InputTokens  int64   `json:"input_tokens,omitempty"`
	OutputTokens int64   `json:"output_tokens,omitempty"`
	Error        string  `json:"error,omitempty"`
}

type Summary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Benchmark   string    `json:"benchmark"`
	UploadedAt  time.Time `json:"uploaded_at"`
	RunCount    int       `json:"run_count"`
	TaskCount   int       `json:"task_count"`
	BestScore   float64   `json:"best_score"`
	TotalCost   float64   `json:"total_cost_usd"`
}

func (evaluation Evaluation) Summary() Summary {
	summary := Summary{
		ID:          evaluation.ID,
		Name:        evaluation.Name,
		Description: evaluation.Description,
		Benchmark:   evaluation.Benchmark,
		UploadedAt:  evaluation.UploadedAt,
		RunCount:    len(evaluation.Runs),
	}

	tasks := map[string]struct{}{}
	for _, run := range evaluation.Runs {
		var score float64
		for _, result := range run.Results {
			tasks[result.TaskID] = struct{}{}
			score += result.Score
			summary.TotalCost += result.CostUSD
		}
		if len(run.Results) > 0 {
			score /= float64(len(run.Results))
		}
		if score > summary.BestScore {
			summary.BestScore = score
		}
	}
	summary.TaskCount = len(tasks)

	return summary
}
