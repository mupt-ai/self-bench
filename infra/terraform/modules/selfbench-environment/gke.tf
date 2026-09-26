# Harbor work on GKE Autopilot, when gke_workers is on: one Deployment polls the Harbor queue and
# KEDA sets its pod count from that queue's Temporal backlog. The workflow queue stays on the
# Cloud Run worker pool.
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
  # Pods mount their pinned env-file bundles straight from Secret Manager.
  secret_manager_config {
    enabled = true
  }
  depends_on = [google_project_service.api]
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
# The Secret Manager add-on mounts bundles as the pod's own Kubernetes identity.
resource "google_secret_manager_secret_iam_member" "worker_pod_reader" {
  for_each   = var.gke_workers ? toset(["shared", "worker"]) : toset([])
  project    = var.project_id
  secret_id  = google_secret_manager_secret.runtime["${each.value}-env"].secret_id
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
  # Replaced pods drain their Harbor work for hours; the release does not wait for them.
  wait = false
  values = [yamlencode({
    image          = var.image
    runtimeAccount = google_service_account.runtime.email
    secrets = {
      shared   = "projects/${var.project_id}/secrets/${google_secret_manager_secret.runtime["shared-env"].secret_id}/versions/${var.secret_versions.shared}"
      worker   = "projects/${var.project_id}/secrets/${google_secret_manager_secret.runtime["worker-env"].secret_id}/versions/${var.secret_versions.worker}"
      temporal = { id = google_secret_manager_secret.temporal_api_key.secret_id, version = tostring(var.secret_versions.temporal) }
    }
    temporal = {
      address   = var.temporal_address
      namespace = var.temporal_namespace
      queue     = "${local.name}-harbor"
    }
    maxReplicas = var.harbor_worker_max_replicas
  })]
  depends_on = [
    helm_release.keda,
    google_service_account_iam_member.runtime_workload_identity,
    google_secret_manager_secret_iam_member.worker_pod_reader,
    google_secret_manager_secret_iam_member.keda_temporal_reader,
  ]
}
