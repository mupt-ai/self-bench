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
variable "zone" {
  type = string
  validation {
    condition     = startswith(var.zone, "${var.region}-")
    error_message = "The VM zone must belong to the chosen region."
  }
}
variable "boot_image" {
  description = "Explicit Debian 12 image self-link; choose and review a version, not a moving family."
  type        = string
  validation {
    condition     = can(regex("^projects/debian-cloud/global/images/debian-12-bookworm-v[0-9]+$", var.boot_image))
    error_message = "Use a versioned projects/debian-cloud/global/images/debian-12-bookworm-vYYYYMMDD image."
  }
}
variable "machine_type" {
  description = "Coordinator capacity, not sandbox capacity. Size after a measured dev run."
  type        = string
  default     = "e2-standard-2"
}
variable "boot_disk_size_gb" {
  description = "Boot disk size; holds Docker images for the current and previous release. Increase only."
  type        = number
  default     = 100
  validation {
    condition     = var.boot_disk_size_gb >= 100
    error_message = "The boot disk must be at least 100 GB; it was 50 GB when it filled in September 2026."
  }
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
variable "operator_members" {
  description = "Explicit user/group IAM members permitted to administer this environment through IAP."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for member in var.operator_members : can(regex("^(user|group):[^@[:space:]]+@[^@[:space:]]+$", member))])
    error_message = "Operators must be explicit user:email or group:email members."
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
