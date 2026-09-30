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
    labels          = merge(local.labels, { release = var.release_id })
    service_account = google_service_account.runtime.email
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app.id
        subnetwork = google_compute_subnetwork.app.id
      }
    }
    containers {
      image   = var.image
      command = ["node", "dist/temporal/worker-main.js"]
      env {
        name  = "SELFBENCH_ACTIVITY_CONCURRENCY"
        value = tostring(var.activity_concurrency)
      }
      env {
        name  = "SELFBENCH_ENVIRONMENT"
        value = var.environment
      }
      dynamic "env" {
        for_each = local.shared_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      # Once the GKE Harbor workers are proven, this pool leaves the Harbor queue to them.
      dynamic "env" {
        for_each = var.worker_pool_polls_harbor ? [] : ["workflows"]
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
    }
  }
  # The API migrates the schema on start; the worker rolls only after it is ready.
  depends_on = [
    google_cloud_run_v2_service.api,
    google_secret_manager_secret_iam_member.runtime_reader,
    google_secret_manager_secret_iam_member.runtime_temporal_reader,
  ]
}
