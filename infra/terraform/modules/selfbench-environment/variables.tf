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
variable "enable_public_web" {
  description = "Open 80/443 only after domain, TLS proxy and authentication are configured."
  type        = bool
  default     = false
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
