# The Temporal workers on GKE Autopilot, when gke_workers is on: a Deployment polls the workflow
# queue, and KEDA starts Harbor job pods from the Harbor queue's Temporal backlog. Cloud Run keeps
# only the API.
locals {
  gke              = var.gke_workers ? 1 : 0
  worker_namespace = "selfbench"
  worker_account   = "selfbench-worker"
  workload_pool    = "${var.project_id}.svc.id.goog"
}
data "google_project" "this" {
  count      = local.gke
  project_id = var.project_id
}
locals {
  # A Kubernetes service account as an IAM principal.
  kubernetes_principal = local.gke == 1 ? "principal://iam.googleapis.com/projects/${data.google_project.this[0].number}/locations/global/workloadIdentityPools/${local.workload_pool}/subject/ns" : ""
}

# Nodes pull images and write logs and metrics as their own account; the project's default
# compute account has no roles here.
resource "google_service_account" "gke_nodes" {
  count        = local.gke
  project      = var.project_id
  account_id   = "${local.name}-gke-nodes"
  display_name = "SelfBench ${var.environment} GKE nodes"
}
resource "google_project_iam_member" "gke_nodes" {
  count   = local.gke
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.gke_nodes[0].email}"
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
  subnetwork          = google_compute_subnetwork.app.id
  ip_allocation_policy {
    cluster_secondary_range_name  = "gke-pods"
    services_secondary_range_name = "gke-services"
  }
  # Pods mount each secret value straight from Secret Manager.
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

# Pods act as the runtime account, so its artifact, signing and secret grants carry over.
resource "google_service_account_iam_member" "runtime_workload_identity" {
  count              = local.gke
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_pool}[${local.worker_namespace}/${local.worker_account}]"
  # The cluster creates the workload identity pool these members name.
  depends_on = [google_container_cluster.workers]
}
# The Secret Manager add-on mounts values as the pod's own Kubernetes identity.
resource "google_secret_manager_secret_iam_member" "worker_pod_reader" {
  for_each   = var.gke_workers ? { for key, secret in local.runtime_secrets : key => secret if secret.enabled && secret.worker } : {}
  project    = var.project_id
  secret_id  = google_secret_manager_secret.value[each.key].secret_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "${local.kubernetes_principal}/${local.worker_namespace}/sa/${local.worker_account}"
  depends_on = [google_container_cluster.workers]
}
resource "google_secret_manager_secret_iam_member" "worker_pod_temporal_reader" {
  count      = local.gke
  project    = var.project_id
  secret_id  = google_secret_manager_secret.temporal_api_key.secret_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "${local.kubernetes_principal}/${local.worker_namespace}/sa/${local.worker_account}"
  depends_on = [google_container_cluster.workers]
}
resource "google_secret_manager_secret_iam_member" "keda_temporal_reader" {
  count      = local.gke
  project    = var.project_id
  secret_id  = google_secret_manager_secret.temporal_api_key.secret_id
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
  depends_on       = [google_container_cluster.workers]
}

resource "helm_release" "workers" {
  count            = local.gke
  name             = "selfbench-workers"
  chart            = "${path.module}/charts/selfbench-workers"
  namespace        = local.worker_namespace
  create_namespace = true
  # Waits for the workflow Deployment to roll (KEDA's Harbor jobs are not part of the release),
  # allowing for Autopilot to add a node.
  timeout = 900
  values = [yamlencode({
    image          = var.image
    environment    = var.environment
    release        = var.release_id
    runtimeAccount = google_service_account.runtime.email
    env            = local.shared_env
    secrets = {
      files = [for name, secret_id in local.worker_secret_env : {
        resourceName = "projects/${var.project_id}/secrets/${secret_id}/versions/latest"
        path         = name
      }]
      temporal = { id = google_secret_manager_secret.temporal_api_key.secret_id, version = "latest" }
    }
    temporal = {
      address   = var.temporal_address
      namespace = var.temporal_namespace
      queue     = "${local.name}-harbor"
    }
    maxReplicas         = var.harbor_worker_max_replicas
    workflowReplicas    = var.worker_instances
    activityConcurrency = var.activity_concurrency
  })]
  # The API migrates the schema on start; the workflow worker rolls only after it is ready.
  depends_on = [
    google_cloud_run_v2_service.api,
    helm_release.keda,
    google_service_account_iam_member.runtime_workload_identity,
    google_secret_manager_secret_iam_member.worker_pod_reader,
    google_secret_manager_secret_iam_member.worker_pod_temporal_reader,
    google_secret_manager_secret_iam_member.keda_temporal_reader,
  ]
}
