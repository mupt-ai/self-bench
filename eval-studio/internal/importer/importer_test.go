package importer

import (
	"strings"
	"testing"
)

func TestParseCSVGroupsRowsByRun(t *testing.T) {
	t.Parallel()

	contents := `evaluation_name,description,benchmark,run_name,model,provider,harness,thinking_level,task_id,task_name,passed,score,cost_usd,duration_ms,input_tokens,output_tokens,error
SWE-bench August,Comparison,SWE-bench Verified,Sol high,gpt-5.6-sol,OpenAI,Harbor + Codex,high,task-1,Routing fix,true,1,0.42,1000,120,40,
SWE-bench August,Comparison,SWE-bench Verified,Sol high,gpt-5.6-sol,OpenAI,Harbor + Codex,high,task-2,Auth fix,false,0,0.18,2000,140,20,tests failed
SWE-bench August,Comparison,SWE-bench Verified,Kimi high,kimi-k2.5,Fireworks,Harbor + Pi,high,task-1,Routing fix,true,0.8,0.07,900,110,35,
`

	evaluation, err := Parse("results.csv", strings.NewReader(contents))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if evaluation.Name != "SWE-bench August" {
		t.Fatalf("Name = %q", evaluation.Name)
	}
	if len(evaluation.Runs) != 2 {
		t.Fatalf("len(Runs) = %d, want 2", len(evaluation.Runs))
	}
	if len(evaluation.Runs[0].Results) != 2 {
		t.Fatalf("len(first Results) = %d, want 2", len(evaluation.Runs[0].Results))
	}
	if evaluation.Runs[0].Results[1].Error != "tests failed" {
		t.Fatalf("Error = %q", evaluation.Runs[0].Results[1].Error)
	}
	if evaluation.Runs[1].Provider != "Fireworks" {
		t.Fatalf("Provider = %q", evaluation.Runs[1].Provider)
	}
}

func TestParseRejectsMissingRequiredColumn(t *testing.T) {
	t.Parallel()

	_, err := Parse("results.csv", strings.NewReader("evaluation_name\nexample\n"))
	if err == nil || !strings.Contains(err.Error(), "missing required column") {
		t.Fatalf("Parse() error = %v, want missing required column", err)
	}
}

func TestParseJSONValidatesRequiredRunMetadata(t *testing.T) {
	t.Parallel()

	contents := `{
		"name":"Example",
		"benchmark":"Terminal-Bench",
		"runs":[{"name":"Run","model":"m","provider":"","harness":"h","thinking_level":"high","results":[{"task_id":"t","task_name":"T","passed":true,"score":1,"cost_usd":0.1}]}]
	}`
	_, err := Parse("results.json", strings.NewReader(contents))
	if err == nil || !strings.Contains(err.Error(), "provider is required") {
		t.Fatalf("Parse() error = %v, want provider validation error", err)
	}
}

func TestParseRejectsNonFiniteNumbers(t *testing.T) {
	t.Parallel()

	contents := `evaluation_name,description,benchmark,run_name,model,provider,harness,thinking_level,task_id,task_name,passed,score,cost_usd
Example,,SWE-bench,Run,m,p,h,high,task-1,T,true,NaN,0.1
`
	_, err := Parse("results.csv", strings.NewReader(contents))
	if err == nil || !strings.Contains(err.Error(), "score must be a finite number") {
		t.Fatalf("Parse() error = %v, want finite-number error", err)
	}
}

func TestParseRejectsDuplicateTaskIDWithinRun(t *testing.T) {
	t.Parallel()

	contents := `evaluation_name,description,benchmark,run_name,model,provider,harness,thinking_level,task_id,task_name,passed,score,cost_usd
Example,,SWE-bench,Run,m,p,h,high,task-1,T,true,1,0.1
Example,,SWE-bench,Run,m,p,h,high,task-1,T,true,0.5,0.1
`
	_, err := Parse("results.csv", strings.NewReader(contents))
	if err == nil || !strings.Contains(err.Error(), "task_id \"task-1\" is repeated") {
		t.Fatalf("Parse() error = %v, want duplicate task_id error", err)
	}
}

func TestParseRejectsDuplicateRunIDFromJSON(t *testing.T) {
	t.Parallel()

	contents := `{"name":"Example","benchmark":"Terminal-Bench","runs":[{"id":"run-x","name":"Run","model":"m","provider":"p","harness":"h","thinking_level":"high","results":[{"task_id":"t","task_name":"T","passed":true,"score":1,"cost_usd":0.1}]},{"id":"run-x","name":"Run2","model":"m","provider":"p","harness":"h","thinking_level":"high","results":[{"task_id":"t","task_name":"T","passed":true,"score":1,"cost_usd":0.1}]}]}`
	_, err := Parse("results.json", strings.NewReader(contents))
	if err == nil || !strings.Contains(err.Error(), "reuses run id") {
		t.Fatalf("Parse() error = %v, want duplicate run id error", err)
	}
}

func TestParseRejectsNegativeDuration(t *testing.T) {
	t.Parallel()

	contents := `evaluation_name,description,benchmark,run_name,model,provider,harness,thinking_level,task_id,task_name,passed,score,cost_usd,duration_ms
Example,,SWE-bench,Run,m,p,h,high,task-1,T,true,1,0.1,-5
`
	_, err := Parse("results.csv", strings.NewReader(contents))
	if err == nil || !strings.Contains(err.Error(), "duration_ms cannot be negative") {
		t.Fatalf("Parse() error = %v, want negative duration error", err)
	}
}
