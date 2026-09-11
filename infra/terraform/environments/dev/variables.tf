variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "zone" {
  type    = string
  default = "us-central1-a"
}
variable "boot_image" {
  type = string
}
variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}
variable "enable_public_web" {
  type    = bool
  default = false
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
variable "operator_members" {
  description = "Explicit user/group principals approved to administer this environment."
  type        = set(string)
}
