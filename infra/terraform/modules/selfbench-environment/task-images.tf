# Task images. Before a task's checks, Cloud Build builds its agent and verifier images into this
# repository, and the checks and every later trial start from exactly those, by digest. Sandbox
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

# The worker (the runtime account) deletes the images a candidate built but did not keep, and a
# task's images once a person rejects or deletes it, which takes repoAdmin.
resource "google_artifact_registry_repository_iam_member" "runtime_task_images" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.tasks[0].name
  role       = "roles/artifactregistry.repoAdmin"
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

# Builds run the task's setup steps, which are code from the repository under test, so they run as
# an account of their own that may only push task and cache images, read the Docker Hub mirror and
# keep build logs in their bucket; never as the worker.
resource "google_service_account" "task_builder" {
  count        = var.task_images ? 1 : 0
  project      = var.project_id
  account_id   = "${local.name}-task-builder"
  display_name = "SelfBench ${var.environment} task image builds"
  depends_on   = [google_project_service.api]
}
resource "google_artifact_registry_repository_iam_member" "builder_task_images" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.tasks[0].name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.task_builder[0].email}"
}

# BuildKit's layer cache, one mutable tag per candidate, so a candidate's later checks rebuild only
# what changed. Only a cache: entries go two weeks after they were last written.
resource "google_artifact_registry_repository" "task_cache" {
  count                  = var.task_images ? 1 : 0
  project                = var.project_id
  location               = var.region
  repository_id          = "selfbench-task-cache"
  format                 = "DOCKER"
  labels                 = local.labels
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "expire"
    action = "DELETE"
    condition {
      older_than = "1209600s"
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_artifact_registry_repository_iam_member" "builder_task_cache" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.task_cache[0].name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.task_builder[0].email}"
}

# Docker Hub through Artifact Registry: builds pull base images (and BuildKit itself) from here by
# the same digests, so Cloud Build's shared addresses never meet Docker Hub's anonymous limit.
resource "google_artifact_registry_repository" "dockerhub" {
  count         = var.task_images ? 1 : 0
  project       = var.project_id
  location      = var.region
  repository_id = "dockerhub"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  labels        = local.labels
  remote_repository_config {
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_artifact_registry_repository_iam_member" "builder_dockerhub" {
  count      = var.task_images ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.dockerhub[0].name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.task_builder[0].email}"
}

# Build logs, which the worker reads to give the author a failed build's output; they go after two
# weeks. Cloud Build streams a log by rewriting its object, and documents Storage Admin on the bucket
# for a build's own account. Only this bucket: the build's task steps run in BuildKit's containers,
# off the network Cloud Build serves the account's token on.
resource "google_storage_bucket" "task_builds" {
  count                       = var.task_images ? 1 : 0
  project                     = var.project_id
  name                        = "${var.project_id}-task-builds"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = local.labels
  lifecycle_rule {
    condition {
      age = 14
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.api]
}
resource "google_storage_bucket_iam_member" "builder_logs" {
  count  = var.task_images ? 1 : 0
  bucket = google_storage_bucket.task_builds[0].name
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.task_builder[0].email}"
}
resource "google_storage_bucket_iam_member" "runtime_build_logs" {
  count  = var.task_images ? 1 : 0
  bucket = google_storage_bucket.task_builds[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# The worker starts and follows builds, as the builder's account and no other.
resource "google_project_iam_member" "runtime_cloud_build" {
  count   = var.task_images ? 1 : 0
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
# Cloud Build's own service agent mints the builder account's tokens for its builds.
resource "google_service_account_iam_member" "cloud_build_agent_builder" {
  count              = var.task_images ? 1 : 0
  service_account_id = google_service_account.task_builder[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this[0].number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
  depends_on         = [google_project_service.api]
}
resource "google_service_account_iam_member" "runtime_acts_as_builder" {
  count              = var.task_images ? 1 : 0
  service_account_id = google_service_account.task_builder[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

# Customer exports copy verified images to their own private repository. The API has no
# provisioning/IAM permission. Workers may create repositories and read repository metadata
# (including nonexistent names); IAM management and builder writes stay in customer-* only.
resource "google_project_iam_custom_role" "customer_repository_create" {
  count       = var.task_images ? 1 : 0
  project     = var.project_id
  role_id     = "selfbenchCustomerRepositoryCreate"
  title       = "Create Customer Export Repositories"
  permissions = ["artifactregistry.repositories.create", "artifactregistry.repositories.get"]
}
resource "google_project_iam_member" "runtime_customer_repository_create" {
  count   = var.task_images ? 1 : 0
  project = var.project_id
  role    = google_project_iam_custom_role.customer_repository_create[0].name
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_project_iam_custom_role" "customer_repository_access" {
  count   = var.task_images ? 1 : 0
  project = var.project_id
  role_id = "selfbenchCustomerRepositoryAccess"
  title   = "Manage Customer Export Access"
  permissions = [
    "artifactregistry.repositories.getIamPolicy",
    "artifactregistry.repositories.setIamPolicy",
  ]
}
resource "google_project_iam_member" "runtime_customer_repository_access" {
  count   = var.task_images ? 1 : 0
  project = var.project_id
  role    = google_project_iam_custom_role.customer_repository_access[0].name
  member  = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title      = "customer-export-repositories"
    expression = "resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/repositories/customer-')"
  }
}
resource "google_project_iam_member" "builder_customer_images" {
  count   = var.task_images ? 1 : 0
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.task_builder[0].email}"
  condition {
    title      = "customer-export-repositories"
    expression = "resource.name.startsWith('projects/${var.project_id}/locations/${var.region}/repositories/customer-')"
  }
}

locals {
  task_image_registry = "${var.region}-docker.pkg.dev/${var.project_id}"
  task_image_env = var.task_images ? {
    SELFBENCH_TASK_IMAGE_REPOSITORY       = "${local.task_image_registry}/${google_artifact_registry_repository.tasks[0].repository_id}"
    SELFBENCH_TASK_IMAGE_BUILDER          = "cloud-build"
    SELFBENCH_TASK_IMAGE_CACHE            = "${local.task_image_registry}/${google_artifact_registry_repository.task_cache[0].repository_id}"
    SELFBENCH_DOCKER_HUB_MIRROR           = "${local.task_image_registry}/${google_artifact_registry_repository.dockerhub[0].repository_id}"
    SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT = google_service_account.task_builder[0].email
    SELFBENCH_CLOUD_BUILD_LOGS_BUCKET     = google_storage_bucket.task_builds[0].name
  } : {}
}
