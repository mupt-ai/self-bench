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
  }
  # Values only the managed offering reads. Operators create these with their versions before
  # turning it on; Terraform only grants access, so turning it off never deletes a value.
  managed_secrets = {
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
  }
  # Secrets nothing reads any more. Their containers stay, since secrets are never destroyed.
  retired_secrets = {
    task_canary = "selfbench-task-canary"
  }
  # The Modal account that builds accepted tasks' images before verification (portable-images.ts).
  # It is the platform's, whatever provider a run verifies on. Operators create both values before
  # turning task_image_builder on, as for the managed offering's.
  builder_secrets = {
    task_image_builder_modal_token_id = {
      id      = "selfbench-task-image-builder-modal-token-id"
      env     = "SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_ID"
      api     = false
      worker  = true
      enabled = var.task_images && var.task_image_builder
    }
    task_image_builder_modal_token_secret = {
      id      = "selfbench-task-image-builder-modal-token-secret"
      env     = "SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_SECRET"
      api     = false
      worker  = true
      enabled = var.task_images && var.task_image_builder
    }
  }
  readable_secrets = merge(local.runtime_secrets, local.managed_secrets, local.builder_secrets)
  secret_ids = merge(
    { for key, secret in google_secret_manager_secret.value : key => secret.secret_id },
    { for key, secret in local.managed_secrets : key => secret.id },
    { for key, secret in local.builder_secrets : key => secret.id },
  )
  temporal_secret = {
    id  = "selfbench-temporal-api-key"
    env = "SELFBENCH_TEMPORAL_API_KEY"
  }
  api_secret_env = merge(
    { (local.temporal_secret.env) = local.temporal_secret.id },
    { for secret in values(local.readable_secrets) : secret.env => secret.id if secret.enabled && secret.api },
  )
  worker_secret_env = merge(
    { (local.temporal_secret.env) = local.temporal_secret.id },
    { for secret in values(local.readable_secrets) : secret.env => secret.id if secret.enabled && secret.worker },
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
    SELFBENCH_CUSTOM_MODEL_HOSTS        = var.environment == "prod" ? "routing.dari.dev" : null
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
  for_each  = merge({ for key, secret in local.runtime_secrets : key => secret.id }, local.retired_secrets)
  project   = var.project_id
  secret_id = each.value
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
# Terraform used to own the managed offering's containers. It now forgets any still in state,
# leaving them and their values in place; a key already gone from state moves nothing.
moved {
  from = google_secret_manager_secret.value["stripe_secret_key"]
  to   = google_secret_manager_secret.managed["stripe_secret_key"]
}
moved {
  from = google_secret_manager_secret.value["stripe_webhook_secret"]
  to   = google_secret_manager_secret.managed["stripe_webhook_secret"]
}
moved {
  from = google_secret_manager_secret.value["managed_openrouter_api_key"]
  to   = google_secret_manager_secret.managed["managed_openrouter_api_key"]
}
moved {
  from = google_secret_manager_secret.value["managed_e2b_api_key"]
  to   = google_secret_manager_secret.managed["managed_e2b_api_key"]
}
moved {
  from = google_secret_manager_secret.value["managed_modal_token_id"]
  to   = google_secret_manager_secret.managed["managed_modal_token_id"]
}
moved {
  from = google_secret_manager_secret.value["managed_modal_token_secret"]
  to   = google_secret_manager_secret.managed["managed_modal_token_secret"]
}
removed {
  from = google_secret_manager_secret.managed
  lifecycle {
    destroy = false
  }
}

resource "google_secret_manager_secret_iam_member" "api_reader" {
  for_each  = { for key, secret in local.readable_secrets : key => secret if secret.enabled && secret.api }
  project   = var.project_id
  secret_id = local.secret_ids[each.key]
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
  for_each  = { for key, secret in local.readable_secrets : key => secret if secret.enabled && secret.worker }
  project   = var.project_id
  secret_id = local.secret_ids[each.key]
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
