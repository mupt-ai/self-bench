package api

import (
	"crypto/subtle"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/mupt-ai/self-bench/eval-studio/internal/eval"
	"github.com/mupt-ai/self-bench/eval-studio/internal/importer"
	"github.com/mupt-ai/self-bench/eval-studio/internal/store"
)

type Server struct {
	store      *store.Store
	logger     *slog.Logger
	adminToken string
	static     fs.FS
}

type Options struct {
	Store      *store.Store
	Logger     *slog.Logger
	AdminToken string
	Static     fs.FS
}

func New(options Options) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		store:      options.Store,
		logger:     logger,
		adminToken: options.AdminToken,
		static:     options.Static,
	}
}

func (server *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", server.health)
	mux.HandleFunc("GET /api/evaluations", server.listEvaluations)
	mux.HandleFunc("GET /api/evaluations/{id}", server.getEvaluation)
	mux.HandleFunc("POST /api/evaluations/preview", server.requireAdmin(server.previewEvaluation))
	mux.HandleFunc("POST /api/evaluations", server.requireAdmin(server.createEvaluation))
	mux.HandleFunc("DELETE /api/evaluations/{id}", server.requireAdmin(server.deleteEvaluation))
	mux.HandleFunc("GET /api/template.csv", server.downloadTemplate)
	if server.static != nil {
		mux.Handle("/", spaHandler(server.static))
	}
	return server.logRequests(mux)
}

func (server *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (server *Server) listEvaluations(writer http.ResponseWriter, request *http.Request) {
	summaries, err := server.store.List(request.Context())
	if err != nil {
		server.internalError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, summaries)
}

func (server *Server) getEvaluation(writer http.ResponseWriter, request *http.Request) {
	evaluation, err := server.store.Get(request.Context(), request.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "evaluation not found")
		return
	}
	if err != nil {
		server.internalError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, evaluation)
}

func (server *Server) previewEvaluation(writer http.ResponseWriter, request *http.Request) {
	evaluation, err := parseUpload(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, evaluation)
}

func (server *Server) createEvaluation(writer http.ResponseWriter, request *http.Request) {
	evaluation, err := parseUpload(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if err := server.store.Create(request.Context(), evaluation); errors.Is(err, store.ErrConflict) {
		writeError(writer, http.StatusConflict, "an evaluation with this ID already exists")
		return
	} else if err != nil {
		server.internalError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusCreated, evaluation)
}

func (server *Server) deleteEvaluation(writer http.ResponseWriter, request *http.Request) {
	err := server.store.Delete(request.Context(), request.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "evaluation not found")
		return
	}
	if err != nil {
		server.internalError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *Server) downloadTemplate(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Disposition", `attachment; filename="eval-template.csv"`)
	writer.Header().Set("Content-Type", "text/csv; charset=utf-8")
	csvWriter := csv.NewWriter(writer)
	_ = csvWriter.Write([]string{
		"evaluation_name", "description", "benchmark", "run_name", "model", "provider",
		"harness", "thinking_level", "task_id", "task_name", "passed", "score", "cost_usd",
		"duration_ms", "input_tokens", "output_tokens", "error",
	})
	_ = csvWriter.Write([]string{
		"SWE-bench Verified · August", "Agent coding benchmark", "SWE-bench Verified",
		"GPT-5.6 high", "gpt-5.6-sol", "OpenAI", "Harbor + Codex", "high",
		"django__django-11099", "Fix request routing regression", "true", "1", "0.284",
		"94210", "41231", "8152", "",
	})
	csvWriter.Flush()
}

func (server *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if server.adminToken == "" {
			next(writer, request)
			return
		}
		authorization := request.Header.Get("Authorization")
		token, ok := strings.CutPrefix(authorization, "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(server.adminToken)) != 1 {
			writeError(writer, http.StatusUnauthorized, "admin token required")
			return
		}
		next(writer, request)
	}
}

func (server *Server) internalError(writer http.ResponseWriter, request *http.Request, err error) {
	server.logger.Error("request failed", "method", request.Method, "path", request.URL.Path, "error", err)
	writeError(writer, http.StatusInternalServerError, "internal server error")
}

func (server *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		server.logger.Info("request", "method", request.Method, "path", request.URL.Path)
		next.ServeHTTP(writer, request)
	})
}

func parseUpload(request *http.Request) (eval.Evaluation, error) {
	request.Body = http.MaxBytesReader(nil, request.Body, 26<<20)
	if err := request.ParseMultipartForm(25 << 20); err != nil {
		return eval.Evaluation{}, fmt.Errorf("reading multipart upload: %w", err)
	}
	if request.MultipartForm != nil {
		defer request.MultipartForm.RemoveAll()
	}
	file, header, err := request.FormFile("file")
	if err != nil {
		return eval.Evaluation{}, errors.New("multipart field \"file\" is required")
	}
	defer file.Close()
	return importer.Parse(header.Filename, file)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}

func spaHandler(contents fs.FS) http.Handler {
	files := http.FileServer(http.FS(contents))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path := strings.TrimPrefix(request.URL.Path, "/")
		if path != "" {
			if _, err := fs.Stat(contents, path); err == nil {
				files.ServeHTTP(writer, request)
				return
			}
		}
		index, err := contents.Open("index.html")
		if err != nil {
			http.NotFound(writer, request)
			return
		}
		defer index.Close()
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.Copy(writer, index)
	})
}
