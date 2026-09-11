resource "google_compute_global_address" "sql" {
  count         = var.create_cloud_sql ? 1 : 0
  project       = var.project_id
  name          = "${local.name}-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.app.id
}
resource "google_service_networking_connection" "sql" {
  count                   = var.create_cloud_sql ? 1 : 0
  network                 = google_compute_network.app.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql[0].name]
  depends_on              = [google_project_service.api]
}
resource "google_sql_database_instance" "app" {
  count               = var.create_cloud_sql ? 1 : 0
  project             = var.project_id
  region              = var.region
  name                = local.name
  database_version    = "POSTGRES_17"
  deletion_protection = true
  settings {
    edition                     = "ENTERPRISE"
    tier                        = var.cloud_sql_tier
    availability_type           = var.cloud_sql_availability_type
    disk_size                   = 20
    disk_autoresize             = true
    disk_autoresize_limit       = 100
    deletion_protection_enabled = true
    user_labels                 = local.labels
    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = var.cloud_sql_retained_backups
      }
    }
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.app.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    maintenance_window {
      day          = 7
      hour         = 5
      update_track = "stable"
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_service_networking_connection.sql]
}
resource "google_sql_database" "app" {
  count    = var.create_cloud_sql ? 1 : 0
  project  = var.project_id
  instance = google_sql_database_instance.app[0].name
  name     = "selfbench"
  lifecycle {
    prevent_destroy = true
  }
}
# The DB login/password and TLS connection string are intentionally NOT Terraform-managed.
# Provision a scoped login through an approved DB-admin path, then store its URL in Secret Manager.
