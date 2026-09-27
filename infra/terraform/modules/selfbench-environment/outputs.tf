output "deployment" {
  description = "Nonsecret coordinates only; this output is NOT a deployable release."
  value = {
    environment     = var.environment
    project_id      = var.project_id
    region          = var.region
    worker_pool     = google_cloud_run_v2_worker_pool.worker.name
    workers_cluster = var.gke_workers ? google_container_cluster.workers[0].name : null
    runtime_account = google_service_account.runtime.email
    artifact_bucket = google_storage_bucket.artifacts.name
    image_prefix    = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/selfbench"
    task_queue      = local.name
    # Add each dns_authorization CNAME and point the domains' A records at address.
    api = {
      service = google_cloud_run_v2_service.api.name
      address = google_compute_global_address.api.address
      dns_authorizations = {
        for domain, authorization in google_certificate_manager_dns_authorization.api :
        domain => authorization.dns_resource_record[0]
      }
    }
    secret_ids = { for key, secret in google_secret_manager_secret.runtime : key => secret.secret_id }
    database = var.create_cloud_sql ? {
      instance   = google_sql_database_instance.app[0].connection_name
      private_ip = google_sql_database_instance.app[0].private_ip_address
      name       = google_sql_database.app[0].name
    } : null
  }
}
output "workers_cluster" {
  description = "Where the Helm provider reaches the GKE worker cluster; null while gke_workers is off."
  value = var.gke_workers ? {
    endpoint               = google_container_cluster.workers[0].endpoint
    cluster_ca_certificate = one(google_container_cluster.workers[0].master_auth[*].cluster_ca_certificate)
  } : null
}
