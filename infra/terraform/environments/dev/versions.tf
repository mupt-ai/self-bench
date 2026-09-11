terraform {
  required_version = "= 1.14.2"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 7.46.1"
    }
  }
}
