locals {
  name = "selfbench-${var.environment}"
  labels = {
    application = "selfbench"
    environment = var.environment
    managed_by  = "terraform"
  }
  apis = toset(concat([
    "compute.googleapis.com", "artifactregistry.googleapis.com", "storage.googleapis.com",
    "secretmanager.googleapis.com", "iam.googleapis.com", "iap.googleapis.com",
    "oslogin.googleapis.com", "iamcredentials.googleapis.com",
  ], var.create_cloud_sql ? ["sqladmin.googleapis.com", "servicenetworking.googleapis.com"] : []))
}
resource "google_project_service" "api" {
  for_each           = local.apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${local.name}-runtime"
  display_name = "SelfBench ${var.environment} API and worker runtime"
  depends_on   = [google_project_service.api]
}
