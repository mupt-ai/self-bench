terraform {
  backend "gcs" {
    prefix = "selfbench/prod"
    # Bucket supplied explicitly via backend.hcl; never share dev/prod state buckets.
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
# The GKE worker cluster; unused while gke_workers is off. Credentials come from the plugin at
# each call, so the apply runs as the apply identity rather than a token saved in the plan.
provider "helm" {
  kubernetes = {
    host                   = module.selfbench.workers_cluster == null ? "" : "https://${module.selfbench.workers_cluster.endpoint}"
    cluster_ca_certificate = module.selfbench.workers_cluster == null ? "" : base64decode(module.selfbench.workers_cluster.cluster_ca_certificate)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "gke-gcloud-auth-plugin"
      args        = ["--use_application_default_credentials"]
    }
  }
}
module "selfbench" {
  source                      = "../../modules/selfbench-environment"
  project_id                  = var.project_id
  environment                 = "prod"
  region                      = var.region
  create_cloud_sql            = var.create_cloud_sql
  cloud_sql_tier              = var.cloud_sql_tier
  cloud_sql_availability_type = var.cloud_sql_availability_type
  cloud_sql_retained_backups  = var.cloud_sql_retained_backups
  api_domains                 = var.api_domains
  redirect_domains            = var.redirect_domains
  results_site_domain         = var.results_site_domain
  image                       = var.image
  release_id                  = var.release_id
  public_url                  = var.public_url
  results_site_url            = var.results_site_url
  github_oauth_client_id      = var.github_oauth_client_id
  stripe_price_id             = var.stripe_price_id
  managed_offering            = var.managed_offering
  sentry_dsn                  = var.sentry_dsn
  sentry_browser_dsn          = var.sentry_browser_dsn
  posthog_api_key             = var.posthog_api_key
  activity_concurrency        = var.activity_concurrency
  worker_instances            = var.worker_instances
  gke_workers                 = var.gke_workers
  task_images                 = var.task_images
  temporal_address            = var.temporal_address
  temporal_namespace          = var.temporal_namespace
  harbor_worker_max_replicas  = var.harbor_worker_max_replicas
}
output "deployment" {
  value = module.selfbench.deployment
}
