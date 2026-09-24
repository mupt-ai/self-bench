# The VM that ran the API and worker. Terraform forgets it rather than destroying it (it is
# deletion-protected); delete it with gcloud once the worker pool is polling.
removed {
  from = google_compute_instance.app
  lifecycle {
    destroy = false
  }
}
