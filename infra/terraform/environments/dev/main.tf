terraform {
  backend "gcs" {
    prefix = "selfbench/dev"
    # Bucket supplied explicitly via backend.hcl; never share dev/prod state buckets.
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
module "selfbench" {
  source                      = "../../modules/selfbench-environment"
  project_id                  = var.project_id
  environment                 = "dev"
  region                      = var.region
  create_cloud_sql            = var.create_cloud_sql
  cloud_sql_tier              = var.cloud_sql_tier
  cloud_sql_availability_type = var.cloud_sql_availability_type
  cloud_sql_retained_backups  = var.cloud_sql_retained_backups
  api_domains                 = var.api_domains
  redirect_domains            = var.redirect_domains
  image                       = var.image
  secret_versions             = var.secret_versions
  activity_concurrency        = var.activity_concurrency
  worker_instances            = var.worker_instances
}
output "deployment" {
  value = module.selfbench.deployment
}
