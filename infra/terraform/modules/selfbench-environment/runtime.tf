locals {
  # One Secret Manager secret per sensitive value. Keys are stable Terraform addresses; env
  # names can repeat because the API and worker bearer tokens are different values.
  runtime_secrets = {
    database_url = {
      id      = "selfbench-database-url"
      env     = "SELFBENCH_DATABASE_URL"
      api     = true
      worker  = true
      enabled = true
    }
    eval_credential_key = {
      id      = "selfbench-eval-credential-key"
      env     = "SELFBENCH_EVAL_CREDENTIAL_KEY"
      api     = true
      worker  = true
      enabled = true
    }
    sandbox_secret = {
      id      = "selfbench-sandbox-secret"
      env     = "SELFBENCH_SANDBOX_SECRET"
      api     = true
      worker  = true
      enabled = true
    }
    github_oauth_client_secret = {
      id      = "selfbench-github-oauth-client-secret"
      env     = "GITHUB_OAUTH_CLIENT_SECRET"
      api     = true
      worker  = false
      enabled = true
    }
    session_secret = {
      id      = "selfbench-session-secret"
      env     = "SELFBENCH_SESSION_SECRET"
      api     = true
      worker  = false
      enabled = true
    }
    api_token = {
      id      = "selfbench-api-token"
      env     = "SELFBENCH_API_TOKEN"
      api     = true
      worker  = false
      enabled = true
    }
    worker_api_token = {
      id      = "selfbench-worker-api-token"
      env     = "SELFBENCH_API_TOKEN"
      api     = false
      worker  = true
      enabled = true
    }
    stripe_secret_key = {
      id      = "selfbench-stripe-secret-key"
      env     = "SELFBENCH_STRIPE_SECRET_KEY"
      api     = true
      worker  = false
      enabled = var.managed_offering && var.stripe_price_id != null
    }
    stripe_webhook_secret = {
      id      = "selfbench-stripe-webhook-secret"
      env     = "SELFBENCH_STRIPE_WEBHOOK_SECRET"
      api     = true
      worker  = false
      enabled = var.managed_offering && var.stripe_price_id != null
    }
    managed_openrouter_api_key = {
      id      = "selfbench-managed-openrouter-api-key"
      env     = "SELFBENCH_MANAGED_OPENROUTER_API_KEY"
      api     = true
      worker  = true
      enabled = var.managed_offering
    }
    managed_e2b_api_key = {
      id      = "selfbench-managed-e2b-api-key"
      env     = "SELFBENCH_MANAGED_E2B_API_KEY"
      api     = true
      worker  = true
      enabled = var.managed_offering
    }
    managed_modal_token_id = {
      id      = "selfbench-managed-modal-token-id"
      env     = "SELFBENCH_MANAGED_MODAL_TOKEN_ID"
      api     = true
      worker  = true
      enabled = var.managed_offering
    }
    managed_modal_token_secret = {
      id      = "selfbench-managed-modal-token-secret"
      env     = "SELFBENCH_MANAGED_MODAL_TOKEN_SECRET"
      api     = true
      worker  = true
      enabled = var.managed_offering
    }
    # Not secret in what it marks, but kept out of the repository and the deploy logs, so a model
    # can only learn it from the published tasks themselves (src/public/task-canary.ts).
    task_canary = {
      id      = "selfbench-task-canary"
      env     = "SELFBENCH_TASK_CANARY"
      api     = true
      worker  = false
      enabled = var.task_canary
    }
  }
  temporal_secret = {
    id  = "selfbench-temporal-api-key"
    env = "SELFBENCH_TEMPORAL_API_KEY"
  }
  api_secret_env = merge(
    { (local.temporal_secret.env) = local.temporal_secret.id },
    { for secret in values(local.runtime_secrets) : secret.env => secret.id if secret.enabled && secret.api },
  )
  worker_secret_env = merge(
    { (local.temporal_secret.env) = local.temporal_secret.id },
    { for secret in values(local.runtime_secrets) : secret.env => secret.id if secret.enabled && secret.worker },
  )

  shared_env = merge(local.task_image_env, { for name, value in {
    SELFBENCH_API_HOST                  = "0.0.0.0"
    SELFBENCH_API_PORT                  = "8080"
    SELFBENCH_ARTIFACT_BACKEND          = "gcs"
    SELFBENCH_GCS_BUCKET                = google_storage_bucket.artifacts.name
    SELFBENCH_GCS_PREFIX                = "selfbench"
    SELFBENCH_TEMPORAL_ADDRESS          = var.temporal_address
    SELFBENCH_TEMPORAL_NAMESPACE        = var.temporal_namespace
    SELFBENCH_TEMPORAL_TLS              = "true"
    SELFBENCH_TASK_QUEUE                = local.name
    SELFBENCH_GENERATION_TASK_QUEUE     = local.name
    SELFBENCH_EVAL_TASK_QUEUE           = local.name
    SELFBENCH_EXECUTION_BACKEND         = "modal"
    SELFBENCH_HARBOR_ENVIRONMENT        = "modal"
    SELFBENCH_SANDBOX_CALLBACK_URL      = var.public_url
    SELFBENCH_MANAGED_OFFERING          = var.managed_offering ? "true" : null
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT = var.managed_offering ? local.name : null
    SENTRY_DSN                          = var.sentry_dsn
  } : name => value if value != null })
  api_env = merge(local.shared_env, { for name, value in {
    GITHUB_OAUTH_CLIENT_ID       = var.github_oauth_client_id
    SELFBENCH_PUBLIC_URL         = var.public_url
    SELFBENCH_RESULTS_SITE_URL   = var.results_site_url
    SELFBENCH_RESULTS_SITE_INDEX = var.environment == "prod" ? "true" : null
    SELFBENCH_STRIPE_PRICE_ID    = var.managed_offering ? var.stripe_price_id : null
    SENTRY_BROWSER_DSN           = var.sentry_browser_dsn
    POSTHOG_API_KEY              = var.posthog_api_key
  } : name => value if value != null })
}

# Terraform owns each secret container and who may read it. Values are added out of band with
# `gcloud secrets versions add`, so Terraform state never holds them.
resource "google_secret_manager_secret" "value" {
  for_each  = local.runtime_secrets
  project   = var.project_id
  secret_id = each.value.id
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.api]
}

resource "google_secret_manager_secret_iam_member" "api_reader" {
  for_each  = { for key, secret in local.runtime_secrets : key => secret if secret.enabled && secret.api }
  project   = var.project_id
  secret_id = google_secret_manager_secret.value[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "api_temporal_reader" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.temporal_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "runtime_reader" {
  for_each  = { for key, secret in local.runtime_secrets : key => secret if secret.enabled && secret.worker }
  project   = var.project_id
  secret_id = google_secret_manager_secret.value[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_secret_manager_secret_iam_member" "runtime_temporal_reader" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.temporal_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# The old env-file bundles stay in Secret Manager for rollback; this release no longer reads them.
removed {
  from = google_secret_manager_secret.runtime
  lifecycle {
    destroy = false
  }
}
