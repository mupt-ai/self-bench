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
  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
