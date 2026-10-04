# Verified task images. When a task is accepted, the worker exports the images its verification
# ran on into this repository, so every provider starts from exactly those, by digest. Sandbox
# providers in users' own accounts pull through the API (src/api/routes/registry.ts) with a grant
# for one task's images, so no provider ever holds a credential for the repository.
resource "google_artifact_registry_repository" "tasks" {
  count         = var.task_images ? 1 : 0
  project       = var.project_id
  location      = var.region
  repository_id = "selfbench-tasks"
  format        = "DOCKER"
  labels        = local.labels
  docker_config {
    immutable_tags = true
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.api]
}

# The worker (Cloud Run pool and GKE Harbor jobs, both the runtime account) pushes the exports.
resource "google_artifact_registry_repository_iam_member" "runtime_task_images" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.tasks[0].name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}

# The API reads manifests and blob locations to serve pulls.
resource "google_artifact_registry_repository_iam_member" "api_task_images" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.tasks[0].name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.api.email}"
}

locals {
  task_image_env = var.task_images ? {
    SELFBENCH_TASK_IMAGE_REPOSITORY = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.tasks[0].repository_id}"
  } : {}
}
