variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "create_cloud_sql" {
  type    = bool
  default = true
}
variable "cloud_sql_tier" {
  type    = string
  default = "db-f1-micro"
}
variable "cloud_sql_availability_type" {
  type    = string
  default = "ZONAL"
}
variable "cloud_sql_retained_backups" {
  type    = number
  default = 7
}
variable "api_domains" {
  type = list(string)
}
variable "results_site_domain" {
  type    = string
  default = null
}
variable "redirect_domains" {
  type    = map(string)
  default = {}
}
variable "image" {
  description = "Set by the deploy workflow to the digest it just pushed."
  type        = string
}
variable "import_runtime_secrets" {
  description = "Adopt secret containers created while moving an existing environment off env-file bundles."
  type        = bool
  default     = false
}
variable "release_id" {
  description = "Set by the deploy workflow from the GitHub run."
  type        = string
  default     = "manual"
}
variable "public_url" {
  type = string
}
variable "results_site_url" {
  type = string
}
variable "github_oauth_client_id" {
  type = string
}
variable "stripe_price_id" {
  type    = string
  default = null
}
variable "managed_offering" {
  type    = bool
  default = false
}
variable "sentry_dsn" {
  type    = string
  default = null
}
variable "sentry_browser_dsn" {
  type    = string
  default = null
}
variable "posthog_api_key" {
  type    = string
  default = null
}
variable "task_canary" {
  type    = bool
  default = false
}
variable "activity_concurrency" {
  type = number
}
variable "worker_instances" {
  type    = number
  default = 1
}
variable "gke_workers" {
  description = "Run the Temporal workers on GKE Autopilot, Harbor work scaled by KEDA."
  type        = bool
  default     = false
}
variable "temporal_address" {
  type = string
}
variable "temporal_namespace" {
  type = string
}
variable "harbor_worker_max_replicas" {
  type    = number
  default = 20
}
variable "task_images" {
  type    = bool
  default = false
}
