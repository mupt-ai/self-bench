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
# The GKE worker cluster, reached as whoever runs Terraform; unused while gke_workers is off.
data "google_client_config" "current" {}
provider "helm" {
  kubernetes = {
    host                   = module.selfbench.workers_cluster == null ? "" : "https://${module.selfbench.workers_cluster.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = module.selfbench.workers_cluster == null ? "" : base64decode(module.selfbench.workers_cluster.cluster_ca_certificate)
  }
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
  gke_workers                 = var.gke_workers
  temporal_address            = var.temporal_address
  temporal_namespace          = var.temporal_namespace
  harbor_worker_min_replicas  = var.harbor_worker_min_replicas
  harbor_worker_max_replicas  = var.harbor_worker_max_replicas
}
output "deployment" {
  value = module.selfbench.deployment
}
