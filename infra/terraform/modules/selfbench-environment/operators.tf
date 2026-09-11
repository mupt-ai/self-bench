# Non-authoritative IAM additions; never replace an entire project policy/binding.
resource "google_project_iam_member" "operator_login" {
  for_each = var.operator_members
  project  = var.project_id
  role     = "roles/compute.osAdminLogin"
  member   = each.value
}
resource "google_service_account_iam_member" "operator_act_as" {
  for_each           = var.operator_members
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}
resource "google_iap_tunnel_instance_iam_member" "operator_tunnel" {
  for_each = var.operator_members
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.app.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}
