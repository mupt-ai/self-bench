resource "google_compute_network" "app" {
  project                 = var.project_id
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.api]
}
resource "google_compute_subnetwork" "app" {
  project                  = var.project_id
  region                   = var.region
  name                     = local.name
  network                  = google_compute_network.app.id
  ip_cidr_range            = var.environment == "prod" ? "10.42.0.0/24" : "10.41.0.0/24"
  private_ip_google_access = true
  # GKE worker pod and service addresses, clear of the Cloud SQL peering range (10.92/16 in prod,
  # 10.252/16 in dev).
  dynamic "secondary_ip_range" {
    for_each = var.gke_workers ? {
      gke-pods     = var.environment == "prod" ? "10.64.0.0/14" : "10.68.0.0/14"
      gke-services = var.environment == "prod" ? "10.44.32.0/20" : "10.43.32.0/20"
    } : {}
    content {
      range_name    = secondary_ip_range.key
      ip_cidr_range = secondary_ip_range.value
    }
  }
  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
