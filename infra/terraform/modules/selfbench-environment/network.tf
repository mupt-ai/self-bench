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
resource "google_compute_firewall" "iap_ssh" {
  project                 = var.project_id
  name                    = "${local.name}-iap-ssh"
  network                 = google_compute_network.app.id
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.runtime.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
resource "google_compute_firewall" "web" {
  count                   = var.enable_public_web ? 1 : 0
  project                 = var.project_id
  name                    = "${local.name}-web"
  network                 = google_compute_network.app.id
  source_ranges           = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.runtime.email]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}
resource "google_compute_address" "app" {
  project    = var.project_id
  region     = var.region
  name       = local.name
  depends_on = [google_project_service.api]
}
