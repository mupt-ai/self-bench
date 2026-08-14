package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mupt-ai/self-bench/eval-studio/internal/eval"
	"github.com/mupt-ai/self-bench/eval-studio/internal/store"
)

const testCSV = `evaluation_name,description,benchmark,run_name,model,provider,harness,thinking_level,task_id,task_name,passed,score,cost_usd,duration_ms,input_tokens,output_tokens,error
Example,Test evaluation,SWE-bench,Sol high,gpt-5.6-sol,OpenAI,Harbor + Codex,high,task-1,Fix routing,true,1,0.42,1000,120,40,
`

func TestEvaluationAPI(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, "secret")

	unauthorized := uploadRequest(t, http.MethodPost, "/api/evaluations", "results.csv", testCSV, "")
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorizedResponse.Code)
	}

	preview := uploadRequest(t, http.MethodPost, "/api/evaluations/preview", "results.csv", testCSV, "secret")
	previewResponse := httptest.NewRecorder()
	handler.ServeHTTP(previewResponse, preview)
	if previewResponse.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", previewResponse.Code, previewResponse.Body.String())
	}
	var previewed eval.Evaluation
	if err := json.NewDecoder(previewResponse.Body).Decode(&previewed); err != nil {
		t.Fatalf("decoding preview: %v", err)
	}

	create := uploadRequest(t, http.MethodPost, "/api/evaluations", "results.csv", testCSV, "secret")
	createResponse := httptest.NewRecorder()
	handler.ServeHTTP(createResponse, create)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createResponse.Code, createResponse.Body.String())
	}
	var created eval.Evaluation
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		t.Fatalf("decoding create: %v", err)
	}

	list := httptest.NewRequest(http.MethodGet, "/api/evaluations", nil)
	listResponse := httptest.NewRecorder()
	handler.ServeHTTP(listResponse, list)
	if listResponse.Code != http.StatusOK || !bytes.Contains(listResponse.Body.Bytes(), []byte(created.ID)) {
		t.Fatalf("list status = %d, body = %s", listResponse.Code, listResponse.Body.String())
	}

	get := httptest.NewRequest(http.MethodGet, "/api/evaluations/"+created.ID, nil)
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || !bytes.Contains(getResponse.Body.Bytes(), []byte("gpt-5.6-sol")) {
		t.Fatalf("get status = %d, body = %s", getResponse.Code, getResponse.Body.String())
	}
}

func TestAdminTokenIsMatchedExactly(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, "secret")
	for _, authorization := range []string{"secret", "Bearer secret ", "bearer secret", "Bearer  secret"} {
		request := uploadRequest(t, http.MethodPost, "/api/evaluations/preview", "results.csv", testCSV, "")
		request.Header.Set("Authorization", authorization)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("authorization %q status = %d, want %d", authorization, response.Code, http.StatusUnauthorized)
		}
	}
}

func TestUploadBodyLimit(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, "secret")
	request := uploadRequest(t, http.MethodPost, "/api/evaluations/preview", "oversized.csv", strings.Repeat("x", 27<<20), "secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized upload status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if !bytes.Contains(response.Body.Bytes(), []byte("request body too large")) {
		t.Fatalf("oversized upload body = %s", response.Body.String())
	}
}

func testHandler(t *testing.T, token string) http.Handler {
	t.Helper()
	dataStore, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })
	return New(Options{
		Store:      dataStore,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		AdminToken: token,
	}).Handler()
}

func uploadRequest(t *testing.T, method string, path string, filename string, contents string, token string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("creating form file: %v", err)
	}
	if _, err := io.WriteString(part, contents); err != nil {
		t.Fatalf("writing form file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("closing multipart writer: %v", err)
	}
	request := httptest.NewRequest(method, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}
