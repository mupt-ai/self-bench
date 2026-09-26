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
  default = "db-custom-1-3840"
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
variable "redirect_domains" {
  type    = map(string)
  default = {}
}
variable "image" {
  description = "Set by the deploy workflow to the digest it just pushed."
  type        = string
}
variable "secret_versions" {
  description = "Set by the deploy workflow from infra/runtime/secret-versions/<env>.json."
  type        = object({ shared = number, api = number, worker = number, temporal = optional(number) })
}
variable "activity_concurrency" {
  type = number
}
variable "worker_instances" {
  type    = number
  default = 1
}
variable "gke_workers" {
  description = "Run the Temporal worker on GKE Autopilot with KEDA autoscaling."
  type        = bool
  default     = false
}
variable "temporal_address" {
  type    = string
  default = ""
}
variable "temporal_namespace" {
  type    = string
  default = ""
}
variable "harbor_worker_min_replicas" {
  type    = number
  default = 0
}
variable "harbor_worker_max_replicas" {
  type    = number
  default = 100
}
