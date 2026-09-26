# Mock-only tests: apply means apply to a mock provider, NEVER GCP.
mock_provider "google" {}
mock_provider "helm" {}
variables {
  project_id           = "selfbench-dev-testing"
  environment          = "dev"
  region               = "us-central1"
  api_domains          = ["app.selfbench.example", "selfbench.example"]
  image                = "us-central1-docker.pkg.dev/selfbench-dev-testing/selfbench/selfbench@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  secret_versions      = { shared = 7, api = 3, worker = 1 }
  activity_concurrency = 8
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
    condition     = length(google_secret_manager_secret.runtime) == 3 && output.deployment.task_queue == "selfbench-dev"
    error_message = "Keep three role-separated bundles and the matching dev queue."
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
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].image == var.image && google_cloud_run_v2_service.api.template[0].containers[0].command == tolist(["node", "--env-file=/secrets/shared/env", "--env-file=/secrets/api/env", "dist/api/main.js"])
    error_message = "The API runs the release image with its pinned env-files."
  }
  assert {
    condition     = toset([for volume in google_cloud_run_v2_service.api.template[0].volumes : "${volume.name}:${one(volume.secret[0].items).version}"]) == toset(["api:3", "shared:7"])
    error_message = "The API mounts the pinned shared and API bundles, never the worker's."
  }
  assert {
    condition     = google_service_account.api.account_id == "selfbench-dev-api" && keys(google_secret_manager_secret_iam_member.api_reader) == ["api", "shared"]
    error_message = "The API has its own identity and never reads the worker's secret."
  }
  assert {
    condition     = length(google_certificate_manager_dns_authorization.api) == 3 && google_compute_url_map.api.path_matcher[0].default_url_redirect[0].host_redirect == "selfbench.example"
    error_message = "Every served or redirected host needs a certificate, and www redirects to the apex."
  }
}
run "worker_pool" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.scaling[0].manual_instance_count == 1 && google_cloud_run_v2_worker_pool.worker.template[0].containers[0].image == var.image
    error_message = "The worker runs the same release image as a fixed pool."
  }
  assert {
    condition     = [for env in google_cloud_run_v2_worker_pool.worker.template[0].containers[0].env : env.value] == ["8"] && google_cloud_run_v2_worker_pool.worker.template[0].containers[0].command[3] == "dist/temporal/worker-main.js"
    error_message = "The worker polls with the configured activity concurrency."
  }
  assert {
    condition     = keys(google_secret_manager_secret_iam_member.runtime_reader) == ["shared", "worker"]
    error_message = "The worker must not read the API's secret."
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
    condition     = length(google_container_cluster.workers) == 0 && length(helm_release.workers) == 0 && output.workers_cluster == null
    error_message = "The GKE workers stay off until gke_workers is set."
  }
}
run "gke_workers" {
  command = plan
  variables {
    gke_workers        = true
    temporal_address   = "us-central1.gcp.api.temporal.io:7233"
    temporal_namespace = "selfbench-dev.abc12"
    secret_versions    = { shared = 7, api = 3, worker = 1, temporal = 2 }
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
    condition     = google_container_cluster.workers[0].enable_autopilot && google_container_cluster.workers[0].private_cluster_config[0].enable_private_nodes && google_container_cluster.workers[0].secret_manager_config[0].enabled
    error_message = "Workers run on Autopilot with private nodes and Secret Manager mounts."
  }
  assert {
    condition     = google_compute_router_nat.gke[0].source_subnetwork_ip_ranges_to_nat == "LIST_OF_SUBNETWORKS" && contains(local.apis, "container.googleapis.com")
    error_message = "Private nodes reach the internet through NAT, and the GKE API is enabled."
  }
  assert {
    condition     = google_service_account_iam_member.runtime_workload_identity[0].member == "serviceAccount:selfbench-dev-testing.svc.id.goog[selfbench/selfbench-worker]"
    error_message = "Only the worker's Kubernetes account acts as the runtime account."
  }
  assert {
    condition     = keys(google_secret_manager_secret_iam_member.worker_pod_reader) == ["shared", "worker"]
    error_message = "Worker pods must not read the API's secret."
  }
  assert {
    condition = yamldecode(helm_release.workers[0].values[0]).secrets == {
      shared   = "projects/selfbench-dev-testing/secrets/selfbench-shared-env/versions/7"
      worker   = "projects/selfbench-dev-testing/secrets/selfbench-worker-env/versions/1"
      temporal = { id = "selfbench-temporal-api-key", version = "2" }
    }
    error_message = "Worker pods and KEDA read pinned secret versions, never latest or the API's."
  }
  assert {
    condition     = yamldecode(helm_release.workers[0].values[0]).image == var.image && yamldecode(helm_release.workers[0].values[0]).temporal.taskQueue == "selfbench-dev" && yamldecode(helm_release.workers[0].values[0]).harbor == { slots = 10, minReplicas = 0, maxReplicas = 100 }
    error_message = "Workers run the release image on the environment's queue, with up to 1000 Harbor slots."
  }
}
run "gke_workers_need_temporal_settings" {
  command = plan
  variables { gke_workers = true }
  expect_failures = [var.secret_versions, var.temporal_address, var.temporal_namespace]
}
