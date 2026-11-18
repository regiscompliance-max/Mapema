terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {} # bucket/key/region/dynamodb_table from backend-<env>.hcl
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "mapema", env = var.env, managed_by = "terraform", data = var.env == "production" ? "real" : "synthetic-only" }
  }
}
