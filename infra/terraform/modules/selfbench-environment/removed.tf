# The VM that ran the API and worker, and the static address attached to it. Terraform forgets
# both rather than destroying them (the VM is deletion-protected, and the address can't be
# released while attached); delete them with gcloud once the worker pool is polling.
removed {
  from = google_compute_instance.app
  lifecycle {
    destroy = false
  }
}
removed {
  from = google_compute_address.app
  lifecycle {
    destroy = false
  }
}
