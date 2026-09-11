resource "google_storage_bucket" "artifacts" {
  project                     = var.project_id
  name                        = "${var.project_id}-artifacts"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning {
    enabled = true
  }
  # No age-based deletion of live data. Noncurrent copies need a reviewed retention policy.
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.api]
}
resource "google_storage_bucket_iam_member" "runtime_artifacts" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_artifact_registry_repository" "app" {
  project       = var.project_id
  location      = var.region
  repository_id = "selfbench"
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
resource "google_artifact_registry_repository_iam_member" "runtime_reader" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}
# Bundles map to protected runtime env-files, not Terraform variables. Keep values out of state.
resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(["shared-env", "api-env", "worker-env"])
  project   = var.project_id
  secret_id = "selfbench-${each.value}"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_iam_member" "runtime_reader" {
  for_each  = google_secret_manager_secret.runtime
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# Verifier material is delivered to hosted sandboxes through short-lived signed GCS URLs.
# ADC on a VM has no local signing key; authorize ONLY signBlob on its own service account.
resource "google_project_iam_custom_role" "artifact_signer" {
  project     = var.project_id
  role_id     = "selfbenchArtifactSigner"
  title       = "SelfBench artifact URL signer"
  permissions = ["iam.serviceAccounts.signBlob"]
  depends_on  = [google_project_service.api]
}
resource "google_service_account_iam_member" "runtime_signer" {
  service_account_id = google_service_account.runtime.name
  role               = google_project_iam_custom_role.artifact_signer.name
  member             = "serviceAccount:${google_service_account.runtime.email}"
}
