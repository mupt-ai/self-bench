variable "project_id" {
  description = "Existing, billing-linked project dedicated to this environment."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id)) && startswith(var.project_id, "selfbench-${var.environment}-")
    error_message = "Use an existing selfbench-<environment>-<suffix> project ID."
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
variable "operator_members" {
  description = "Explicit user/group IAM members permitted to administer this environment through IAP."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for member in var.operator_members : can(regex("^(user|group):[^@[:space:]]+@[^@[:space:]]+$", member))])
    error_message = "Operators must be explicit user:email or group:email members."
  }
}
