output "deployment" {
  description = "Nonsecret coordinates only; this output is NOT a deployable release."
  value = {
    environment     = var.environment
    project_id      = var.project_id
    region          = var.region
    zone            = var.zone
    instance        = google_compute_instance.app.name
    external_ip     = google_compute_address.app.address
    runtime_account = google_service_account.runtime.email
    artifact_bucket = google_storage_bucket.artifacts.name
    image_prefix    = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/selfbench"
    task_queue      = local.name
    secret_ids      = { for key, secret in google_secret_manager_secret.runtime : key => secret.secret_id }
    database = var.create_cloud_sql ? {
      instance   = google_sql_database_instance.app[0].connection_name
      private_ip = google_sql_database_instance.app[0].private_ip_address
      name       = google_sql_database.app[0].name
    } : null
  }
}
