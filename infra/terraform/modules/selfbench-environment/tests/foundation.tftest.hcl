# Mock-only tests: apply means apply to a mock provider, NEVER GCP.
mock_provider "google" {}
mock_provider "helm" {}
variables {
  project_id             = "selfbench-dev-testing"
  environment            = "dev"
  region                 = "us-central1"
  api_domains            = ["app.selfbench.example", "selfbench.example"]
  image                  = "us-central1-docker.pkg.dev/selfbench-dev-testing/selfbench/selfbench@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  activity_concurrency   = 8
  public_url             = "https://app.selfbench.example"
  results_site_url       = "https://selfbench.example"
  github_oauth_client_id = "oauth-client"
  temporal_address       = "us-central1.gcp.api.temporal.io:7233"
  temporal_namespace     = "selfbench-dev.abc12"
}
run "dev_foundation" {
  command = plan
  assert {
    condition     = google_storage_bucket.artifacts.public_access_prevention == "enforced" && google_storage_bucket.artifacts.uniform_bucket_level_access
    error_message = "Artifacts must remain private."
  }
  assert {
    condition     = google_storage_bucket.artifacts.versioning[0].enabled && !google_storage_bucket.artifacts.force_destroy
    error_message = "Artifact versions must be retained and destructive bucket deletion disabled."
  }
  assert {
    condition     = !google_sql_database_instance.app[0].settings[0].ip_configuration[0].ipv4_enabled && google_sql_database_instance.app[0].settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "Cloud SQL must have no public address and require encrypted connections."
  }
  assert {
    condition     = google_artifact_registry_repository.app.docker_config[0].immutable_tags
    error_message = "Release tags must not be overwritten."
  }
  assert {
    condition     = length(google_secret_manager_secret.value) == 14 && output.deployment.task_queue == "selfbench-dev"
    error_message = "Each sensitive value has its own secret, and dev uses the matching queue."
  }
  assert {
    condition     = google_project_iam_custom_role.artifact_signer.permissions == toset(["iam.serviceAccounts.signBlob"])
    error_message = "GCS signing must not require a broad token creator/project admin grant."
  }
}
run "api_on_cloud_run" {
  command = plan
  variables {
    redirect_domains = { "www.selfbench.example" = "selfbench.example" }
  }
  assert {
    condition     = google_cloud_run_v2_service.api.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && google_cloud_run_v2_service.api.invoker_iam_disabled
    error_message = "Only the load balancer reaches the API, and it may invoke it for anyone."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    error_message = "The API reaches private Cloud SQL through the VPC."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].image == var.image && google_cloud_run_v2_service.api.template[0].containers[0].command == tolist(["node", "dist/api/main.js"]) && length(google_cloud_run_v2_service.api.template[0].volumes) == 0
    error_message = "The API reads env values directly, with no env-file bundle mounts."
  }
  assert {
    condition = {
      for env in google_cloud_run_v2_service.api.template[0].containers[0].env : env.name => env.value_source[0].secret_key_ref[0].secret
      if length(env.value_source) > 0
      } == {
      GITHUB_OAUTH_CLIENT_SECRET    = "selfbench-github-oauth-client-secret"
      SELFBENCH_API_TOKEN           = "selfbench-api-token"
      SELFBENCH_DATABASE_URL        = "selfbench-database-url"
      SELFBENCH_EVAL_CREDENTIAL_KEY = "selfbench-eval-credential-key"
      SELFBENCH_SANDBOX_SECRET      = "selfbench-sandbox-secret"
      SELFBENCH_SESSION_SECRET      = "selfbench-session-secret"
      SELFBENCH_TEMPORAL_API_KEY    = "selfbench-temporal-api-key"
    }
    error_message = "The API reads only its required per-value secrets, never the worker token."
  }
  assert {
    condition     = alltrue([for env in google_cloud_run_v2_service.api.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].version == "latest" if length(env.value_source) > 0])
    error_message = "Each deploy starts API instances on the latest secret versions."
  }
  assert {
    condition     = google_service_account.api.account_id == "selfbench-dev-api" && keys(google_secret_manager_secret_iam_member.api_reader) == ["api_token", "database_url", "eval_credential_key", "github_oauth_client_secret", "sandbox_secret", "session_secret"]
    error_message = "The API has its own identity and reads only API or shared secret values."
  }
  assert {
    condition     = length(google_certificate_manager_dns_authorization.api) == 3 && google_compute_url_map.api.path_matcher[0].default_url_redirect[0].host_redirect == "selfbench.example"
    error_message = "Every served or redirected host needs a certificate, and www redirects to the apex."
  }
}
run "results_site_cdn" {
  command = plan
  variables {
    redirect_domains    = { "www.selfbench.example" = "selfbench.example" }
    results_site_domain = "selfbench.example"
  }
  assert {
    condition     = length(google_compute_backend_service.results_site) == 1 && google_compute_backend_service.results_site[0].enable_cdn && google_compute_backend_service.results_site[0].compression_mode == "AUTOMATIC"
    error_message = "The results site's host goes through Cloud CDN, compressed."
  }
  assert {
    condition     = google_compute_backend_service.results_site[0].cdn_policy[0].cache_mode == "USE_ORIGIN_HEADERS" && !google_compute_backend_service.results_site[0].cdn_policy[0].negative_caching
    error_message = "The CDN keeps only what the API marks public, and never caches errors on its own."
  }
  assert {
    condition     = !google_compute_backend_service.results_site[0].cdn_policy[0].cache_key_policy[0].include_query_string && google_compute_backend_service.results_site[0].cdn_policy[0].serve_while_stale == 86400
    error_message = "Query strings never split the cache, and the last good copy is served through a day of errors."
  }
  assert {
    condition     = google_compute_backend_service.results_site[0].cdn_policy[0].request_coalescing
    error_message = "Concurrent requests for an expired copy share one request to the API."
  }
  assert {
    condition     = google_compute_backend_service.results_site[0].log_config[0].enable && google_compute_backend_service.results_site[0].log_config[0].sample_rate == 1
    error_message = "Every request to the results site is logged, cache hits included."
  }
  assert {
    condition     = one([for rule in google_compute_url_map.api.host_rule : rule.path_matcher if contains(tolist(rule.hosts), "selfbench.example")]) == "results-site" && google_compute_url_map.api.path_matcher[0].default_url_redirect[0].host_redirect == "selfbench.example"
    error_message = "Only the results site's host routes to the CDN backend; www still redirects."
  }
  assert {
    condition     = output.deployment.api.results_site_cdn.host == "selfbench.example"
    error_message = "The deploy needs the host and URL map to clear the CDN."
  }
}
run "no_results_site_cdn_by_default" {
  command = plan
  assert {
    condition     = length(google_compute_backend_service.results_site) == 0 && output.deployment.api.results_site_cdn == null && !coalesce(google_compute_backend_service.api.enable_cdn, false)
    error_message = "Without a results site host there is no CDN, and the app's backend is never cached."
  }
}
run "results_site_must_be_served" {
  command = plan
  variables {
    results_site_domain = "elsewhere.example"
  }
  expect_failures = [var.results_site_domain]
}
run "worker_pool" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.scaling[0].manual_instance_count == 1 && google_cloud_run_v2_worker_pool.worker.template[0].containers[0].image == var.image
    error_message = "The worker runs the same release image as a fixed pool."
  }
  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.template[0].containers[0].command == tolist(["node", "dist/temporal/worker-main.js"]) && length(google_cloud_run_v2_worker_pool.worker.template[0].volumes) == 0
    error_message = "The worker reads env values directly, with no env-file bundle mounts."
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_worker_pool.worker.template[0].containers[0].env : env.value if env.name == "SELFBENCH_ACTIVITY_CONCURRENCY"]) == "8"
    error_message = "The worker polls with the configured activity concurrency."
  }
  assert {
    condition = {
      for env in google_cloud_run_v2_worker_pool.worker.template[0].containers[0].env : env.name => env.value_source[0].secret_key_ref[0].secret
      if length(env.value_source) > 0
      } == {
      SELFBENCH_API_TOKEN           = "selfbench-worker-api-token"
      SELFBENCH_DATABASE_URL        = "selfbench-database-url"
      SELFBENCH_EVAL_CREDENTIAL_KEY = "selfbench-eval-credential-key"
      SELFBENCH_SANDBOX_SECRET      = "selfbench-sandbox-secret"
      SELFBENCH_TEMPORAL_API_KEY    = "selfbench-temporal-api-key"
    }
    error_message = "The worker reads its own token and shared values, never API-only secrets."
  }
  assert {
    condition     = keys(google_secret_manager_secret_iam_member.runtime_reader) == ["database_url", "eval_credential_key", "sandbox_secret", "worker_api_token"]
    error_message = "The worker must not read API-only secret values."
  }
}
run "optional_secret_values" {
  command = plan
  variables {
    managed_offering = true
    stripe_price_id  = "price_test"
  }
  assert {
    condition = toset(keys(google_secret_manager_secret_iam_member.api_reader)) == toset([
      "api_token", "database_url", "eval_credential_key", "github_oauth_client_secret",
      "managed_e2b_api_key", "managed_modal_token_id", "managed_modal_token_secret",
      "managed_openrouter_api_key", "sandbox_secret", "session_secret",
      "stripe_secret_key", "stripe_webhook_secret",
    ])
    error_message = "Enabled optional values are readable by the API, including both Stripe secrets."
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret_iam_member.runtime_reader), "stripe_secret_key") && contains(keys(google_secret_manager_secret_iam_member.runtime_reader), "managed_modal_token_secret")
    error_message = "Workers get managed provider values but never Stripe."
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_service.api.template[0].containers[0].env : env.value if env.name == "SELFBENCH_MANAGED_OFFERING"]) == "true"
    error_message = "The managed offering switch reaches the app."
  }
}
run "task_canary" {
  command = plan
  variables {
    task_canary = true
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret_iam_member.api_reader), "task_canary") && !contains(keys(google_secret_manager_secret_iam_member.runtime_reader), "task_canary")
    error_message = "Only the API, which serves published tasks, reads the canary."
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_service.api.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == "SELFBENCH_TASK_CANARY"]) == "selfbench-task-canary"
    error_message = "The API reads the canary from its secret, never from a plain value."
  }
}
run "byok_only_ignores_billing_inputs" {
  command = plan
  variables {
    stripe_price_id = "price_test"
  }
  assert {
    condition     = length([for key in keys(google_secret_manager_secret_iam_member.api_reader) : key if startswith(key, "managed_") || startswith(key, "stripe_")]) == 0
    error_message = "Without the managed offering, no managed or Stripe secret is readable."
  }
  assert {
    condition     = length([for env in google_cloud_run_v2_service.api.template[0].containers[0].env : env.name if contains(["SELFBENCH_MANAGED_OFFERING", "SELFBENCH_STRIPE_PRICE_ID"], env.name)]) == 0
    error_message = "Without the managed offering, the app gets neither the switch nor a Stripe price."
  }
}
run "prod_foundation" {
  command = plan
  variables {
    project_id                  = "selfbench-prod-testing"
    environment                 = "prod"
    image                       = "us-central1-docker.pkg.dev/selfbench-prod-testing/selfbench/selfbench@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    cloud_sql_tier              = "db-custom-1-3840"
    cloud_sql_availability_type = "ZONAL"
  }
  assert {
    condition     = google_cloud_run_v2_service.api.deletion_protection && google_cloud_run_v2_worker_pool.worker.deletion_protection && google_sql_database_instance.app[0].deletion_protection && google_sql_database_instance.app[0].settings[0].deletion_protection_enabled
    error_message = "Production services and database must be deletion-protected."
  }
  assert {
    condition     = google_sql_database_instance.app[0].settings[0].tier == "db-custom-1-3840"
    error_message = "Production pilot SQL must use the reviewed lower-cost tier."
  }
  assert {
    condition     = google_sql_database_instance.app[0].settings[0].availability_type == "ZONAL"
    error_message = "Production pilot SQL must be zonal until HA is explicitly approved."
  }
  assert {
    condition     = google_sql_database_instance.app[0].settings[0].backup_configuration[0].point_in_time_recovery_enabled
    error_message = "Proposed prod SQL must enable point-in-time recovery."
  }
  assert {
    condition     = output.deployment.task_queue == "selfbench-prod" && google_storage_bucket.artifacts.name == "selfbench-prod-testing-artifacts"
    error_message = "Production queue/bucket must not reuse dev."
  }
}
run "external_database" {
  command = plan
  variables { create_cloud_sql = false }
  assert {
    condition     = length(google_sql_database_instance.app) == 0 && length(google_service_networking_connection.sql) == 0 && output.deployment.database == null
    error_message = "External DB mode must not create Cloud SQL or SQL peering."
  }
}
run "reject_unknown_environment" {
  command = plan
  variables { environment = "staging" }
  expect_failures = [var.environment]
}
run "reject_moving_image" {
  command = plan
  variables { image = "us-central1-docker.pkg.dev/selfbench-dev-testing/selfbench/selfbench:latest" }
  expect_failures = [var.image]
}
run "reject_no_api_domain" {
  command = plan
  variables { api_domains = [] }
  expect_failures = [var.api_domains]
}
run "allow_operator_chosen_project" {
  command = plan
  variables { project_id = "community-production" }
  assert {
    condition     = google_cloud_run_v2_service.api.project == "community-production"
    error_message = "The reusable module must accept an operator-chosen project ID."
  }
}
run "gke_workers_off_by_default" {
  command = plan
  assert {
    condition     = length(google_container_cluster.workers) == 0 && length(helm_release.workers) == 0 && length(google_compute_subnetwork.app.secondary_ip_range) == 0
    error_message = "Harbor work stays on the Cloud Run pool until gke_workers is set."
  }
}
run "gke_workers" {
  command = plan
  variables {
    gke_workers = true

  }
  override_resource {
    target          = google_service_account.runtime
    override_during = plan
    values = {
      email = "selfbench-dev-runtime@selfbench-dev-testing.iam.gserviceaccount.com"
      name  = "projects/selfbench-dev-testing/serviceAccounts/selfbench-dev-runtime@selfbench-dev-testing.iam.gserviceaccount.com"
    }
  }
  assert {
    condition     = google_container_cluster.workers[0].enable_autopilot && toset([for range in google_compute_subnetwork.app.secondary_ip_range : range.range_name]) == toset(["gke-pods", "gke-services"])
    error_message = "Harbor workers run on Autopilot with pod and service ranges in the app subnet, next to Cloud SQL."
  }
  assert {
    condition     = length(google_service_account.gke_nodes) == 1 && google_artifact_registry_repository_iam_member.gke_nodes[0].role == "roles/artifactregistry.reader"
    error_message = "Nodes run as their own account, which can pull the release image."
  }
  assert {
    condition     = keys(google_secret_manager_secret_iam_member.worker_pod_reader) == ["database_url", "eval_credential_key", "sandbox_secret", "worker_api_token"]
    error_message = "Worker pods must not read API-only secret values."
  }
  assert {
    condition = yamldecode(helm_release.workers[0].values[0]).secrets == {
      files = [
        { resourceName = "projects/selfbench-dev-testing/secrets/selfbench-worker-api-token/versions/latest", path = "SELFBENCH_API_TOKEN" },
        { resourceName = "projects/selfbench-dev-testing/secrets/selfbench-database-url/versions/latest", path = "SELFBENCH_DATABASE_URL" },
        { resourceName = "projects/selfbench-dev-testing/secrets/selfbench-eval-credential-key/versions/latest", path = "SELFBENCH_EVAL_CREDENTIAL_KEY" },
        { resourceName = "projects/selfbench-dev-testing/secrets/selfbench-sandbox-secret/versions/latest", path = "SELFBENCH_SANDBOX_SECRET" },
        { resourceName = "projects/selfbench-dev-testing/secrets/selfbench-temporal-api-key/versions/latest", path = "SELFBENCH_TEMPORAL_API_KEY" },
      ]
      temporal = { id = "selfbench-temporal-api-key", version = "latest" }
    }
    error_message = "Worker pods and KEDA read the latest per-value secrets."
  }
  assert {
    condition     = yamldecode(helm_release.workers[0].values[0]).temporal.queue == "selfbench-dev-harbor" && yamldecode(helm_release.workers[0].values[0]).maxReplicas == 20
    error_message = "KEDA scales on the Harbor queue, up to 20 pods by default."
  }
}
run "worker_pool_leaves_harbor_to_gke" {
  command = plan
  variables {
    gke_workers              = true
    worker_pool_polls_harbor = false
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_worker_pool.worker.template[0].containers[0].env : env.value if env.name == "SELFBENCH_WORKER_ROLE"]) == "workflows"
    error_message = "The pool polls only the workflow queue once Harbor work is on GKE."
  }
}
run "harbor_queue_always_polled" {
  command = plan
  variables { worker_pool_polls_harbor = false }
  expect_failures = [var.worker_pool_polls_harbor]
}
run "temporal_settings_required" {
  command = plan
  variables {
    temporal_address   = ""
    temporal_namespace = ""
  }
  expect_failures = [var.temporal_address, var.temporal_namespace]
}
