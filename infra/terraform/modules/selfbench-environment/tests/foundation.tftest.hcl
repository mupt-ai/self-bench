# Mock-only tests: apply means apply to a mock provider, NEVER GCP.
mock_provider "google" {}
variables {
  project_id  = "selfbench-dev-testing"
  environment = "dev"
  region      = "us-central1"
  zone        = "us-central1-a"
  boot_image  = "projects/debian-cloud/global/images/debian-12-bookworm-v20260901"
}
run "dev_foundation" {
  command = plan
  assert {
    condition     = length(google_compute_firewall.web) == 0
    error_message = "Public web access must be opt-in."
  }
  assert {
    condition     = google_compute_firewall.iap_ssh.source_ranges == toset(["35.235.240.0/20"])
    error_message = "SSH must be limited to IAP."
  }
  assert {
    condition     = google_storage_bucket.artifacts.public_access_prevention == "enforced" && google_storage_bucket.artifacts.uniform_bucket_level_access
    error_message = "Artifacts must remain private."
  }
  assert {
    condition     = google_storage_bucket.artifacts.versioning[0].enabled && !google_storage_bucket.artifacts.force_destroy
    error_message = "Artifact versions must be retained and destructive bucket deletion disabled."
  }
  assert {
    condition     = google_compute_instance.app.metadata["enable-oslogin"] == "TRUE" && google_compute_instance.app.metadata["block-project-ssh-keys"] == "TRUE"
    error_message = "OS Login must replace project SSH keys."
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
}
run "prod_foundation" {
  command = plan
  variables {
    project_id                  = "selfbench-prod-testing"
    environment                 = "prod"
    cloud_sql_tier              = "db-custom-1-3840"
    cloud_sql_availability_type = "ZONAL"
  }
  assert {
    condition     = google_compute_instance.app.deletion_protection && google_sql_database_instance.app[0].deletion_protection && google_sql_database_instance.app[0].settings[0].deletion_protection_enabled
    error_message = "Production compute/database must be deletion-protected."
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
run "public_web_opt_in" {
  command = plan
  variables { enable_public_web = true }
  assert {
    condition     = length(google_compute_firewall.web) == 1
    error_message = "Explicit public web opt-in should create one firewall rule."
  }
}
run "reject_unknown_environment" {
  command = plan
  variables { environment = "staging" }
  expect_failures = [var.environment]
}
run "reject_moving_image" {
  command = plan
  variables { boot_image = "projects/debian-cloud/global/images/family/debian-12" }
  expect_failures = [var.boot_image]
}
run "reject_cross_region_zone" {
  command = plan
  variables { zone = "us-east1-b" }
  expect_failures = [var.zone]
}
run "allow_operator_chosen_project" {
  command = plan
  variables { project_id = "community-production" }
  assert {
    condition     = google_compute_instance.app.project == "community-production"
    error_message = "The reusable module must accept an operator-chosen project ID."
  }
}
run "scoped_operator_and_signer" {
  command = plan
  variables { operator_members = ["user:operator@example.com"] }
  assert {
    condition     = length(google_iap_tunnel_instance_iam_member.operator_tunnel) == 1 && google_project_iam_member.operator_login["user:operator@example.com"].role == "roles/compute.osAdminLogin"
    error_message = "Only explicitly listed operators get administrative access."
  }
  assert {
    condition     = google_project_iam_custom_role.artifact_signer.permissions == toset(["iam.serviceAccounts.signBlob"])
    error_message = "GCS signing must not require a broad token creator/project admin grant."
  }
}
