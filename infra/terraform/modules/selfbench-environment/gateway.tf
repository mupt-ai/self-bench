# The model gateway every trial's agent calls, as its own Cloud Run service from the same image.
# Its calls are long streams of large requests; served by the API they took the site's CPU
# whenever a batch ran. The load balancer sends `/gateway` on the app's hosts here, so sandboxes
# keep calling the address they already reach. It runs as the API's identity, which already
# reads the vault key and the database, but is given only the values the gateway needs.
locals {
  gateway_secret_keys = ["database_url", "eval_credential_key", "sandbox_secret", "managed_openrouter_api_key"]
  gateway_secret_env = {
    for key in local.gateway_secret_keys : local.readable_secrets[key].env => local.readable_secrets[key].id
    if local.readable_secrets[key].enabled
  }
  gateway_env = { for name, value in {
    SELFBENCH_API_HOST           = local.shared_env.SELFBENCH_API_HOST
    SELFBENCH_API_PORT           = local.shared_env.SELFBENCH_API_PORT
    SELFBENCH_CUSTOM_MODEL_HOSTS = lookup(local.shared_env, "SELFBENCH_CUSTOM_MODEL_HOSTS", null)
    SELFBENCH_MANAGED_OFFERING   = lookup(local.shared_env, "SELFBENCH_MANAGED_OFFERING", null)
    SENTRY_DSN                   = var.sentry_dsn
  } : name => value if value != null }
  # The results site never serves the gateway; every other app host does.
  gateway_hosts = [for domain in var.api_domains : domain if domain != var.results_site_domain]
}

resource "google_cloud_run_v2_service" "gateway" {
  project             = var.project_id
  location            = var.region
  name                = "${local.name}-gateway"
  labels              = local.labels
  deletion_protection = var.environment == "prod"
  # Only the load balancer reaches it; a trial key, not IAM, authenticates each call.
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true
  template {
    labels          = merge(local.labels, { release = var.release_id })
    service_account = google_service_account.api.email
    # A model may think for many minutes before its stream ends.
    timeout = "1800s"
    # Each call holds a stream and parses a request of up to a megabyte, so few share a CPU and
    # Cloud Run adds instances well before one saturates.
    max_instance_request_concurrency = var.gateway_request_concurrency
    scaling {
      min_instance_count = 1
      max_instance_count = var.gateway_max_instances
    }
    # Cloud SQL is private; providers are reached directly.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app.id
        subnetwork = google_compute_subnetwork.app.id
      }
    }
    containers {
      image   = var.image
      command = ["bun", "dist/gateway/main.js"]
      env {
        name  = "SELFBENCH_ENVIRONMENT"
        value = var.environment
      }
      dynamic "env" {
        for_each = local.gateway_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.gateway_secret_env
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
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
        # Usage is recorded after a call's response ends.
        cpu_idle          = false
        startup_cpu_boost = true
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 5
        failure_threshold = 36
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.api_reader]
}

resource "google_compute_region_network_endpoint_group" "gateway" {
  project               = var.project_id
  region                = var.region
  name                  = "${local.name}-gateway"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.gateway.name
  }
}
resource "google_compute_backend_service" "gateway" {
  project               = var.project_id
  name                  = "${local.name}-gateway"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = google_compute_region_network_endpoint_group.gateway.id
  }
}
