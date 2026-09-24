# The VM that ran the API and worker, the static address attached to it, and the firewall rule
# that lets web traffic reach it. Terraform forgets all three rather than destroying them (the VM
# is deletion-protected, the address can't be released while attached, and without the firewall
# rule the VM stops serving before DNS has moved to the load balancer); delete them with gcloud
# once DNS points at the load balancer and the worker pool is polling.
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
removed {
  from = google_compute_firewall.web
  lifecycle {
    destroy = false
  }
}
