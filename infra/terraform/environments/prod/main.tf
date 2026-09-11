terraform {
  backend "gcs" {
    prefix = "selfbench/prod"
    # Bucket supplied explicitly via backend.hcl; never share dev/prod state buckets.
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
module "selfbench" {
  source                      = "../../modules/selfbench-environment"
  operator_members            = var.operator_members
  project_id                  = var.project_id
  environment                 = "prod"
  region                      = var.region
  zone                        = var.zone
  boot_image                  = var.boot_image
  machine_type                = var.machine_type
  enable_public_web           = var.enable_public_web
  create_cloud_sql            = var.create_cloud_sql
  cloud_sql_tier              = var.cloud_sql_tier
  cloud_sql_availability_type = var.cloud_sql_availability_type
  cloud_sql_retained_backups  = var.cloud_sql_retained_backups
}
output "deployment" {
  value = module.selfbench.deployment
}
