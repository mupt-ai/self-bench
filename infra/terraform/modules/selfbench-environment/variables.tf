variable "project_id" {
  description = "Existing, billing-linked project dedicated to this environment."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use an existing GCP project ID, not a project name or number."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be dev or prod."
  }
}
variable "region" {
  type = string
}
variable "create_cloud_sql" {
  description = "Proposed managed DB. False means an external managed database must be configured before release."
  type        = bool
  default     = true
}
variable "cloud_sql_tier" {
  description = "Cloud SQL machine tier; choose a larger tier only after reviewing cost and availability needs."
  type        = string
  default     = "db-f1-micro"
}
variable "cloud_sql_availability_type" {
  description = "Cloud SQL availability; REGIONAL materially increases cost."
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.cloud_sql_availability_type)
    error_message = "Cloud SQL availability must be ZONAL or REGIONAL."
  }
}
variable "cloud_sql_retained_backups" {
  description = "Number of retained Cloud SQL backups."
  type        = number
  default     = 7
  validation {
    condition     = var.cloud_sql_retained_backups >= 1 && var.cloud_sql_retained_backups <= 35
    error_message = "Cloud SQL retained backups must be between 1 and 35."
  }
}
variable "api_domains" {
  description = "Hostnames the API serves from Cloud Run behind the global load balancer, for example [\"app.selfbench.dev\", \"selfbench.dev\"]."
  type        = list(string)
  validation {
    condition     = length(var.api_domains) > 0 && alltrue([for domain in var.api_domains : can(regex("^[a-z0-9.-]+\\.[a-z]+$", domain))])
    error_message = "List at least one bare hostname for the API."
  }
}
variable "redirect_domains" {
  description = "Hostnames the load balancer permanently redirects to another host, for example { \"www.selfbench.dev\" = \"selfbench.dev\" }."
  type        = map(string)
  default     = {}
}
variable "image" {
  description = "The release image by immutable digest; the API and the worker run the same one."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+-docker\\.pkg\\.dev/[a-z0-9-]+/selfbench/selfbench@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Use an Artifact Registry selfbench image pinned by digest."
  }
}
variable "secret_versions" {
  description = "Pinned Secret Manager versions of the shared, api and worker env-file bundles, and of the Temporal API key KEDA reads when gke_workers is on."
  type        = object({ shared = number, api = number, worker = number, temporal = optional(number) })
  validation {
    condition     = !var.gke_workers || var.secret_versions.temporal != null
    error_message = "The GKE workers need a pinned version of the selfbench-temporal-api-key secret."
  }
}
variable "activity_concurrency" {
  description = "Temporal activity slots per worker instance."
  type        = number
  validation {
    condition     = var.activity_concurrency >= 1 && var.activity_concurrency <= 100
    error_message = "Activity concurrency must be between 1 and 100."
  }
}
variable "worker_instances" {
  description = "Worker pool instances; each polls with activity_concurrency slots."
  type        = number
  default     = 1
}
variable "api_max_instances" {
  description = "Upper bound on API instances; one always stays warm."
  type        = number
  default     = 3
}
variable "gke_workers" {
  description = "Run Harbor work on GKE Autopilot, scaled by KEDA on the Harbor queue backlog."
  type        = bool
  default     = false
}
variable "temporal_address" {
  description = "Temporal frontend host:port KEDA reads queue backlogs from; the same as SELFBENCH_TEMPORAL_ADDRESS."
  type        = string
  default     = ""
  validation {
    condition     = !var.gke_workers || can(regex("^[a-z0-9.-]+:[0-9]+$", var.temporal_address))
    error_message = "The GKE workers need the Temporal address as host:port."
  }
}
variable "temporal_namespace" {
  description = "Temporal namespace KEDA reads queue backlogs from; the same as SELFBENCH_TEMPORAL_NAMESPACE."
  type        = string
  default     = ""
  validation {
    condition     = !var.gke_workers || length(var.temporal_namespace) > 0
    error_message = "The GKE workers need the Temporal namespace."
  }
}
variable "harbor_worker_max_replicas" {
  description = "Most Harbor worker pods; each runs 10 Harbor activities, so 100 allows 1000 at once."
  type        = number
  default     = 100
}
