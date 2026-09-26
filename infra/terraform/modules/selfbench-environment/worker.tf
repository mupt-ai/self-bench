# The Temporal worker as a Cloud Run worker pool: pollers with no HTTP surface, a fixed
# instance count, and a fresh filesystem on every release, apart from the API.
resource "google_cloud_run_v2_worker_pool" "worker" {
  project             = var.project_id
  location            = var.region
  name                = "${local.name}-worker"
  labels              = local.labels
  deletion_protection = var.environment == "prod"
  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.worker_instances
  }
  template {
    service_account = google_service_account.runtime.email
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app.id
        subnetwork = google_compute_subnetwork.app.id
      }
    }
    dynamic "volumes" {
      for_each = google_secret_manager_secret_iam_member.runtime_reader
      content {
        name = volumes.key
        secret {
          secret = google_secret_manager_secret.runtime["${volumes.key}-env"].secret_id
          items {
            version = var.secret_versions[volumes.key]
            path    = "env"
          }
        }
      }
    }
    containers {
      image   = var.image
      command = ["node", "--env-file=/secrets/shared/env", "--env-file=/secrets/worker/env", "dist/temporal/worker-main.js"]
      env {
        name  = "SELFBENCH_ACTIVITY_CONCURRENCY"
        value = tostring(var.activity_concurrency)
      }
      # With the GKE workers on, Harbor work runs there and this pool polls only the workflow queue.
      dynamic "env" {
        for_each = var.gke_workers ? ["workflows"] : []
        content {
          name  = "SELFBENCH_WORKER_ROLE"
          value = env.value
        }
      }
      # Files the worker writes (Harbor checks, task bundles) count against memory, and the
      # worker sizes its Harbor slots to it.
      resources {
        limits = { cpu = "2", memory = "8Gi" }
      }
      dynamic "volume_mounts" {
        for_each = google_secret_manager_secret_iam_member.runtime_reader
        content {
          name       = volume_mounts.key
          mount_path = "/secrets/${volume_mounts.key}"
        }
      }
    }
  }
  # The API migrates the schema on start; the worker rolls only after it is ready.
  depends_on = [google_cloud_run_v2_service.api]
}
