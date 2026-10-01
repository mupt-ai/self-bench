# The API on Cloud Run behind a global HTTPS load balancer, apart from the worker, so a busy
# or broken worker cannot take the site down with it.
locals {
  lb_domains = concat(var.api_domains, keys(var.redirect_domains))
}

# The API's own identity: artifacts, API and shared secret values, and URL signing. Never the
# worker's token.
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
  # Only the load balancer reaches it, so the client IP it appends to X-Forwarded-For is real.
  # The site is public: anyone the load balancer forwards may invoke it.
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true
  template {
    # A new label on each deploy starts fresh instances, which read the latest secret versions.
    labels                           = merge(local.labels, { release = var.release_id })
    service_account                  = google_service_account.api.email
    timeout                          = "900s"
    max_instance_request_concurrency = 250
    scaling {
      min_instance_count = 1
      max_instance_count = var.api_max_instances
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
      image = var.image
      # Starting the API migrates the database, so a release's schema lands before its worker.
      command = ["node", "dist/api/main.js"]
      # Tags Sentry and PostHog events with the environment they came from.
      env {
        name  = "SELFBENCH_ENVIRONMENT"
        value = var.environment
      }
      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secret_env
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
        limits = { cpu = "1", memory = "2Gi" }
        # Billing delivery and rate refreshes run between requests.
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
  depends_on = [
    google_secret_manager_secret_iam_member.api_reader,
    google_secret_manager_secret_iam_member.api_temporal_reader,
  ]
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
  # No MIME sniffing, and only the origin in cross-site referrers.
  custom_response_headers = [
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
  ]
  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }
}
# The results site's host reaches the same Cloud Run service through Cloud CDN. Only what the
# API marks public is kept, for as long as it says: pages and their data, never the app's
# responses, which stay on the backend above. The deploy clears this cache, since a page names
# its build's scripts.
resource "google_compute_backend_service" "results_site" {
  count                 = var.results_site_domain == null ? 0 : 1
  project               = var.project_id
  name                  = "${local.name}-results-site"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  compression_mode      = "AUTOMATIC"
  custom_response_headers = [
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
  ]
  enable_cdn = true
  # Every request, cache hits included.
  log_config {
    enable      = true
    sample_rate = 1
  }
  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS"
    # The last good copy is served for up to a day while the CDN refreshes it or the API errors,
    # but only for responses without s-maxage: scripts, styles, icons. Pages and the public API
    # send s-maxage, which forbids it, so they are never older than their lifetime, and fail
    # with the API once it runs out.
    serve_while_stale = 86400
    negative_caching  = false
    # Concurrent requests for the same expired copy at one location share one request to the API.
    request_coalescing = true
    # No public response depends on a query string, so none may split the cache or bypass it.
    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = false
    }
  }
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
  dynamic "host_rule" {
    for_each = google_compute_backend_service.results_site
    content {
      hosts        = [var.results_site_domain]
      path_matcher = "results-site"
    }
  }
  dynamic "path_matcher" {
    for_each = google_compute_backend_service.results_site
    content {
      name            = "results-site"
      default_service = path_matcher.value.id
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
