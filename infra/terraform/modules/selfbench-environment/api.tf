# The API on Cloud Run behind a global HTTPS load balancer, apart from the worker VM, so a
# busy or broken worker (disk, memory, Harbor processes) cannot take the site down with it.
# Terraform owns the service's shape; each release deploys its image and pinned secret
# versions with `gcloud run deploy`, so those fields are ignored here.
locals {
  lb_domains = concat(var.api_domains, keys(var.redirect_domains))
}

# The API's own identity: artifacts, the shared and API secrets, and URL signing. Never the
# worker's secret.
resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "${local.name}-api"
  display_name = "SelfBench ${var.environment} API on Cloud Run"
  depends_on   = [google_project_service.api]
}
resource "google_storage_bucket_iam_member" "api_artifacts" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "api_reader" {
  for_each  = toset(["shared-env", "api-env"])
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_service_account_iam_member" "api_signer" {
  service_account_id = google_service_account.api.name
  role               = google_project_iam_custom_role.artifact_signer.name
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  location            = var.region
  name                = "${local.name}-api"
  labels              = local.labels
  deletion_protection = var.environment == "prod"
  # Only the load balancer reaches it, so X-Forwarded-For always carries its two hops.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  template {
    service_account                  = google_service_account.api.email
    timeout                          = "900s"
    max_instance_request_concurrency = 250
    # Exactly one instance: Codex sign-in keeps its pending login process in memory, and the
    # public-site rate limit is per process.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    # Cloud SQL is private; everything else leaves directly.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.app.id
        subnetwork = google_compute_subnetwork.app.id
      }
    }
    containers {
      # Placeholder until the first release deploys the SelfBench image.
      image = "us-docker.pkg.dev/cloudrun/container/hello"
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "2Gi" }
        # Always-on CPU: background refreshes and Codex login processes run between requests.
        cpu_idle          = false
        startup_cpu_boost = true
      }
    }
  }
  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].revision,
      template[0].labels,
      template[0].annotations,
      template[0].volumes,
      template[0].containers[0].image,
      template[0].containers[0].command,
      template[0].containers[0].args,
      template[0].containers[0].env,
      template[0].containers[0].volume_mounts,
    ]
  }
  depends_on = [google_project_service.api]
}

resource "google_compute_global_address" "api" {
  project    = var.project_id
  name       = "${local.name}-api"
  depends_on = [google_project_service.api]
}
resource "google_compute_region_network_endpoint_group" "api" {
  project               = var.project_id
  region                = var.region
  name                  = "${local.name}-api"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}
resource "google_compute_backend_service" "api" {
  project               = var.project_id
  name                  = "${local.name}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  # Kept from the VM's former Caddy proxy.
  custom_response_headers = [
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
  ]
  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }
}
resource "google_compute_url_map" "api" {
  project         = var.project_id
  name            = "${local.name}-api"
  default_service = google_compute_backend_service.api.id
  dynamic "host_rule" {
    for_each = var.redirect_domains
    content {
      hosts        = [host_rule.key]
      path_matcher = replace(host_rule.key, ".", "-")
    }
  }
  dynamic "path_matcher" {
    for_each = var.redirect_domains
    content {
      name = replace(path_matcher.key, ".", "-")
      default_url_redirect {
        host_redirect          = path_matcher.value
        https_redirect         = true
        strip_query            = false
        redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
      }
    }
  }
}

# Certificates are authorized by DNS (a CNAME per domain, listed in the deployment output), so
# they are active before DNS moves to the load balancer and the cutover has no TLS gap.
resource "google_certificate_manager_dns_authorization" "api" {
  for_each   = toset(local.lb_domains)
  project    = var.project_id
  name       = "${local.name}-${replace(each.key, ".", "-")}"
  domain     = each.key
  depends_on = [google_project_service.api]
}
resource "google_certificate_manager_certificate" "api" {
  project = var.project_id
  name    = "${local.name}-api"
  managed {
    domains            = local.lb_domains
    dns_authorizations = [for domain in local.lb_domains : google_certificate_manager_dns_authorization.api[domain].id]
  }
}
resource "google_certificate_manager_certificate_map" "api" {
  project    = var.project_id
  name       = "${local.name}-api"
  depends_on = [google_project_service.api]
}
resource "google_certificate_manager_certificate_map_entry" "api" {
  for_each     = toset(local.lb_domains)
  project      = var.project_id
  name         = "${local.name}-${replace(each.key, ".", "-")}"
  map          = google_certificate_manager_certificate_map.api.name
  certificates = [google_certificate_manager_certificate.api.id]
  hostname     = each.key
}
resource "google_compute_target_https_proxy" "api" {
  project         = var.project_id
  name            = "${local.name}-api"
  url_map         = google_compute_url_map.api.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.api.id}"
}
resource "google_compute_global_forwarding_rule" "api_https" {
  project               = var.project_id
  name                  = "${local.name}-api-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.api.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.api.id
}

# Plain HTTP only redirects to HTTPS.
resource "google_compute_url_map" "api_http" {
  project = var.project_id
  name    = "${local.name}-api-http"
  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}
resource "google_compute_target_http_proxy" "api" {
  project = var.project_id
  name    = "${local.name}-api-http"
  url_map = google_compute_url_map.api_http.id
}
resource "google_compute_global_forwarding_rule" "api_http" {
  project               = var.project_id
  name                  = "${local.name}-api-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.api.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.api.id
}
