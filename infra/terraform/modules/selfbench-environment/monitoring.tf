# The Ops Agent (installed by deploy-host.sh) reports disk and memory; the runtime identity may
# only write metrics and logs.
resource "google_project_iam_member" "runtime_telemetry" {
  for_each = toset(["roles/monitoring.metricWriter", "roles/logging.logWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

locals {
  alerts = var.alert_email != null
  uptime = local.alerts && var.public_host != null
}

resource "google_monitoring_notification_channel" "email" {
  count        = local.alerts ? 1 : 0
  project      = var.project_id
  display_name = "SelfBench ${var.environment} alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
  depends_on   = [google_project_service.api]
}

resource "google_monitoring_uptime_check_config" "api" {
  count        = local.uptime ? 1 : 0
  project      = var.project_id
  display_name = "SelfBench ${var.environment} API health"
  timeout      = "10s"
  period       = "60s"
  http_check {
    path         = "/healthz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = var.public_host }
  }
  depends_on = [google_project_service.api]
}

resource "google_monitoring_alert_policy" "api_down" {
  count                 = local.uptime ? 1 : 0
  project               = var.project_id
  display_name          = "SelfBench ${var.environment} API is down"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  conditions {
    display_name = "/healthz failing from multiple regions"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
      trigger { count = 1 }
    }
  }
}

resource "google_monitoring_alert_policy" "disk_full" {
  count                 = local.alerts ? 1 : 0
  project               = var.project_id
  display_name          = "SelfBench ${var.environment} boot disk above 80%"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  documentation {
    content = "The API and worker share this disk; when it fills, generations fail with ENOSPC. Run `docker system df` on the VM and prune unused images."
  }
  conditions {
    display_name = "Root filesystem used"
    condition_threshold {
      filter          = "metric.type=\"agent.googleapis.com/disk/percent_used\" AND resource.type=\"gce_instance\" AND resource.label.instance_id=\"${google_compute_instance.app.instance_id}\" AND metric.label.device=\"/dev/sda1\" AND metric.label.state=\"used\""
      comparison      = "COMPARISON_GT"
      threshold_value = 80
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
      trigger { count = 1 }
    }
  }
}
