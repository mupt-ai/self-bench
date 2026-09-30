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
# Existing environments created these secret containers while moving off env-file bundles.
# Set import_runtime_secrets for that one migration; new environments let Terraform create them.
locals {
  imported_runtime_secrets = {
    database_url               = "selfbench-database-url"
    eval_credential_key        = "selfbench-eval-credential-key"
    sandbox_secret             = "selfbench-sandbox-secret"
    github_oauth_client_secret = "selfbench-github-oauth-client-secret"
    session_secret             = "selfbench-session-secret"
    api_token                  = "selfbench-api-token"
    worker_api_token           = "selfbench-worker-api-token"
    stripe_secret_key          = "selfbench-stripe-secret-key"
    stripe_webhook_secret      = "selfbench-stripe-webhook-secret"
    managed_openrouter_api_key = "selfbench-managed-openrouter-api-key"
    managed_e2b_api_key        = "selfbench-managed-e2b-api-key"
    managed_modal_token_id     = "selfbench-managed-modal-token-id"
    managed_modal_token_secret = "selfbench-managed-modal-token-secret"
  }
}
import {
  for_each = var.import_runtime_secrets ? local.imported_runtime_secrets : {}
  to       = module.selfbench.google_secret_manager_secret.value[each.key]
  id       = "projects/${var.project_id}/secrets/${each.value}"
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
  results_site_domain         = var.results_site_domain
  image                       = var.image
  release_id                  = var.release_id
  public_url                  = var.public_url
  results_site_url            = var.results_site_url
  github_oauth_client_id      = var.github_oauth_client_id
  stripe_price_id             = var.stripe_price_id
  billing_credit_admin_org_id = var.billing_credit_admin_org_id
  managed_openrouter          = var.managed_openrouter
  managed_e2b                 = var.managed_e2b
  managed_modal               = var.managed_modal
  sentry_dsn                  = var.sentry_dsn
  sentry_browser_dsn          = var.sentry_browser_dsn
  posthog_api_key             = var.posthog_api_key
  activity_concurrency        = var.activity_concurrency
  worker_instances            = var.worker_instances
  gke_workers                 = var.gke_workers
  temporal_address            = var.temporal_address
  temporal_namespace          = var.temporal_namespace
  harbor_worker_max_replicas  = var.harbor_worker_max_replicas
  worker_pool_polls_harbor    = var.worker_pool_polls_harbor
}
output "deployment" {
  value = module.selfbench.deployment
}
