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
variable "results_site_domain" {
  description = "The host of the public results site (selfbench.dev), one of api_domains. Its traffic goes through Cloud CDN, which keeps only what the API marks public; the other hosts are never cached. Null: no CDN."
  type        = string
  default     = null
  validation {
    condition     = var.results_site_domain == null || contains(var.api_domains, coalesce(var.results_site_domain, "-"))
    error_message = "The results site's host must be one of api_domains."
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
variable "release_id" {
  description = "Deploy run identity. It labels each Cloud Run revision, so every release starts instances that read the latest secret versions."
  type        = string
  default     = "manual"
  validation {
    condition     = can(regex("^[a-z0-9_-]{1,63}$", var.release_id))
    error_message = "Use a label-safe release ID: lowercase letters, digits, underscores or hyphens."
  }
}
variable "public_url" {
  description = "The app's public HTTPS origin, used for OAuth callbacks and sandbox callbacks."
  type        = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$", var.public_url))
    error_message = "Use an HTTPS origin such as https://app.selfbench.dev."
  }
}
variable "results_site_url" {
  description = "The public results site's HTTPS origin."
  type        = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9.-]+(:[0-9]+)?$", var.results_site_url))
    error_message = "Use an HTTPS origin such as https://selfbench.dev."
  }
}
variable "github_oauth_client_id" {
  description = "This environment's GitHub OAuth app client ID. Its client secret lives in selfbench-github-oauth-client-secret."
  type        = string
  validation {
    condition     = length(trimspace(var.github_oauth_client_id)) > 0
    error_message = "Set the GitHub OAuth app client ID."
  }
}
variable "stripe_price_id" {
  description = "Stripe metered price ID. Setting it turns on billing and requires the Stripe key and webhook secrets."
  type        = string
  default     = null
}
variable "billing_credit_admin_org_id" {
  description = "Numeric GitHub organization ID whose admins may grant credits and refunds. Null disables them."
  type        = number
  default     = null
  validation {
    condition     = var.billing_credit_admin_org_id == null || (var.billing_credit_admin_org_id > 0 && floor(var.billing_credit_admin_org_id) == var.billing_credit_admin_org_id)
    error_message = "Use a positive numeric GitHub organization ID."
  }
}
variable "managed_openrouter" {
  description = "Offer managed models through the platform OpenRouter key in selfbench-managed-openrouter-api-key."
  type        = bool
  default     = false
}
variable "managed_e2b" {
  description = "Offer managed sandboxes through the platform E2B key in selfbench-managed-e2b-api-key."
  type        = bool
  default     = false
}
variable "managed_modal" {
  description = "Verify managed runs through the platform Modal token secrets."
  type        = bool
  default     = false
}
variable "sentry_dsn" {
  description = "Server Sentry DSN. It is public by design, so it is deploy config rather than a secret."
  type        = string
  default     = null
}
variable "sentry_browser_dsn" {
  description = "Browser Sentry DSN. It is public by design, so it is deploy config rather than a secret."
  type        = string
  default     = null
}
variable "posthog_api_key" {
  description = "PostHog project API key. It is public by design, so it is deploy config rather than a secret."
  type        = string
  default     = null
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
  description = "Temporal frontend host:port for the app and KEDA."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+:[0-9]+$", var.temporal_address))
    error_message = "Use the Temporal address as host:port."
  }
}
variable "temporal_namespace" {
  description = "Temporal namespace for the app and KEDA."
  type        = string
  validation {
    condition     = length(var.temporal_namespace) > 0
    error_message = "Set the Temporal namespace."
  }
}
variable "harbor_worker_max_replicas" {
  description = "Most Harbor worker pods; each runs 10 Harbor activities, so 20 allows 200 at once. Also caps the pod spend (about $0.14 an hour each)."
  type        = number
  default     = 20
}
variable "worker_pool_polls_harbor" {
  description = "Whether the Cloud Run worker pool also runs Harbor work; turn off to leave it to the GKE workers."
  type        = bool
  default     = true
  validation {
    condition     = var.worker_pool_polls_harbor || var.gke_workers
    error_message = "Something must poll the Harbor queue: keep the pool on it or turn on gke_workers."
  }
}
