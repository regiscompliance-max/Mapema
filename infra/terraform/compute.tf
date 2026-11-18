# Skeleton: one host per role (staging-plan.md §3). Images are built by CI (infra/docker) and pulled by tag; hosts get
# an instance role that can read only mapema/<env>/* secrets and write logs. No SSH: SSM Session Manager only.
locals {
  hosts = {
    api      = var.app_instance_type # api + worker + clamd + nginx (infra/proxy/nginx.conf)
    web      = var.app_instance_type
    keycloak = var.app_instance_type
    fineract = var.fineract_instance_type
  }
}
# resource "aws_instance" "host" { for_each = local.hosts ... }   # filled in when the account exists
# resource "aws_lb" "public" { ... }                               # ALB, HTTPS listener, ACM cert for var.api_domain
