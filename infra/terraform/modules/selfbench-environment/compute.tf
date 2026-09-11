resource "google_compute_instance" "app" {
  project             = var.project_id
  zone                = var.zone
  name                = local.name
  machine_type        = var.machine_type
  labels              = local.labels
  deletion_protection = var.environment == "prod"
  # Resizing must be deliberate; Terraform cannot silently stop an active worker.
  allow_stopping_for_update = false
  boot_disk {
    initialize_params {
      image = var.boot_image
      type  = "pd-balanced"
      size  = 50
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.app.id
    access_config {
      nat_ip = google_compute_address.app.address
    }
  }
  service_account {
    email  = google_service_account.runtime.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
    # No app release or secret values in Terraform or instance metadata.
  }
  metadata_startup_script = file("${path.module}/startup.sh")
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  lifecycle {
    # A boot image/startup-script change can otherwise replace the VM.
    prevent_destroy = true
  }
}
