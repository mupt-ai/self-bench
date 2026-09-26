# The Temporal worker on GKE Autopilot, when gke_workers is on. The workflow queue and the Harbor
# queue run as separate Deployments, and KEDA scales each on its Temporal backlog, so Harbor
# checks get pods as they queue instead of waiting for a fixed pool's slots.
locals {
  gke              = var.gke_workers ? 1 : 0
  worker_namespace = "selfbench"
  worker_account   = "selfbench-worker"
  # Clear of the app subnets (10.41/10.42.0.0/24) and the Cloud SQL peering ranges (10.92/16 in
  # prod, 10.252/16 in dev).
  gke_ranges = var.environment == "prod" ? {
    nodes = "10.44.0.0/20", services = "10.44.32.0/20", pods = "10.64.0.0/14"
    } : {
    nodes = "10.43.0.0/20", services = "10.43.32.0/20", pods = "10.68.0.0/14"
  }
  workload_pool = "${var.project_id}.svc.id.goog"
}
data "google_project" "this" {
  count      = local.gke
  project_id = var.project_id
}
locals {
  # A Kubernetes service account as an IAM principal, without a Google service account.
  kubernetes_principal = local.gke == 1 ? "principal://iam.googleapis.com/projects/${data.google_project.this[0].number}/locations/global/workloadIdentityPools/${local.workload_pool}/subject/ns" : ""
}

resource "google_compute_subnetwork" "gke" {
  count                    = local.gke
  project                  = var.project_id
  region                   = var.region
  name                     = "${local.name}-gke"
  network                  = google_compute_network.app.id
  ip_cidr_range            = local.gke_ranges.nodes
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = local.gke_ranges.pods
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = local.gke_ranges.services
  }
}
# Nodes have no public addresses; workers reach Temporal, the sandbox providers and GitHub
# through NAT.
resource "google_compute_router" "gke" {
  count   = local.gke
  project = var.project_id
  region  = var.region
  name    = "${local.name}-gke"
  network = google_compute_network.app.id
}
resource "google_compute_router_nat" "gke" {
  count                              = local.gke
  project                            = var.project_id
  region                             = var.region
  name                               = "${local.name}-gke"
  router                             = google_compute_router.gke[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.gke[0].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  # Hundreds of Harbor clients open many connections each to the same provider endpoints.
  min_ports_per_vm                    = 1024
  enable_endpoint_independent_mapping = false
  enable_dynamic_port_allocation      = true
  max_ports_per_vm                    = 65536
}

# Nodes run as their own account, with only logging, metrics and image pulls.
resource "google_service_account" "gke_nodes" {
  count        = local.gke
  project      = var.project_id
  account_id   = "${local.name}-gke-nodes"
  display_name = "SelfBench ${var.environment} GKE nodes"
}
resource "google_project_iam_member" "gke_nodes" {
  for_each = var.gke_workers ? toset(["roles/container.defaultNodeServiceAccount"]) : toset([])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.gke_nodes[0].email}"
}
resource "google_artifact_registry_repository_iam_member" "gke_nodes" {
  count      = local.gke
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.gke_nodes[0].email}"
}

resource "google_container_cluster" "workers" {
  count               = local.gke
  project             = var.project_id
  location            = var.region
  name                = "${local.name}-workers"
  resource_labels     = local.labels
  deletion_protection = var.environment == "prod"
  enable_autopilot    = true
  network             = google_compute_network.app.id
  subnetwork          = google_compute_subnetwork.gke[0].id
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }
  release_channel {
    channel = "REGULAR"
  }
  # Pods mount their pinned env-file bundles straight from Secret Manager.
  secret_manager_config {
    enabled = true
  }
  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.gke_nodes[0].email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }
  depends_on = [google_project_service.api, google_project_iam_member.gke_nodes]
}

# Worker pods act as the runtime account: its artifact, signing and secret grants carry over.
resource "google_service_account_iam_member" "runtime_workload_identity" {
  count              = local.gke
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_pool}[${local.worker_namespace}/${local.worker_account}]"
  # The cluster creates the project's workload identity pool these members name.
  depends_on = [google_container_cluster.workers]
}
# The Secret Manager add-on mounts bundles as the pod's own Kubernetes identity.
resource "google_secret_manager_secret_iam_member" "worker_pod_reader" {
  for_each   = var.gke_workers ? toset(["shared", "worker"]) : toset([])
  project    = var.project_id
  secret_id  = google_secret_manager_secret.runtime["${each.value}-env"].secret_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "${local.kubernetes_principal}/${local.worker_namespace}/sa/${local.worker_account}"
  depends_on = [google_container_cluster.workers]
}
# KEDA reads queue backlogs from Temporal with this key; loaded out of band like the bundles.
resource "google_secret_manager_secret" "temporal_api_key" {
  count     = local.gke
  project   = var.project_id
  secret_id = "selfbench-temporal-api-key"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}
resource "google_secret_manager_secret_iam_member" "keda_temporal_reader" {
  count      = local.gke
  project    = var.project_id
  secret_id  = google_secret_manager_secret.temporal_api_key[0].secret_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "${local.kubernetes_principal}/keda/sa/keda-operator"
  depends_on = [google_container_cluster.workers]
}

resource "helm_release" "keda" {
  count            = local.gke
  name             = "keda"
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = "2.20.2"
  namespace        = "keda"
  create_namespace = true
  wait             = true
  depends_on       = [google_container_cluster.workers]
}

resource "helm_release" "workers" {
  count            = local.gke
  name             = "selfbench-workers"
  chart            = "${path.module}/charts/selfbench-workers"
  namespace        = local.worker_namespace
  create_namespace = true
  # Pods drain Harbor work for hours on a rollout; the release does not wait for them.
  wait = false
  values = [yamlencode({
    image          = var.image
    serviceAccount = local.worker_account
    runtimeAccount = google_service_account.runtime.email
    secrets = {
      shared   = "projects/${var.project_id}/secrets/${google_secret_manager_secret.runtime["shared-env"].secret_id}/versions/${var.secret_versions.shared}"
      worker   = "projects/${var.project_id}/secrets/${google_secret_manager_secret.runtime["worker-env"].secret_id}/versions/${var.secret_versions.worker}"
      temporal = { id = google_secret_manager_secret.temporal_api_key[0].secret_id, version = tostring(var.secret_versions.temporal) }
    }
    temporal = {
      address   = var.temporal_address
      namespace = var.temporal_namespace
      taskQueue = local.name
    }
    workflows = {
      activityConcurrency = var.activity_concurrency
      maxReplicas         = var.workflow_worker_max_replicas
    }
    harbor = {
      slots       = var.harbor_worker_slots
      minReplicas = var.harbor_worker_min_replicas
      maxReplicas = var.harbor_worker_max_replicas
    }
  })]
  depends_on = [
    helm_release.keda,
    google_service_account_iam_member.runtime_workload_identity,
    google_secret_manager_secret_iam_member.worker_pod_reader,
    google_secret_manager_secret_iam_member.keda_temporal_reader,
    # The API migrates the schema on start; workers roll only after it is ready.
    google_cloud_run_v2_service.api,
  ]
}
