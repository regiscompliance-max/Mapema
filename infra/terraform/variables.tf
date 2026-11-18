variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production"
  }
}
variable "region" {
  type    = string
  default = "af-south-1" # Cape Town; nearest region with managed Postgres PITR (staging-plan.md §1)
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_multi_az" {
  type    = bool
  default = false # true in production
}
variable "backup_retention_days" {
  type    = number
  default = 7 # PITR window; production 35
}
variable "app_instance_type" {
  type    = string
  default = "t4g.medium"
}
variable "fineract_instance_type" {
  type    = string
  default = "t4g.large"
}
variable "api_domain" {
  type        = string
  description = "e.g. api.staging.<domain chosen by Deng>; placeholder until a domain is decided"
}
variable "alarm_email" {
  type        = string
  description = "on-call address for CloudWatch alarms (given by Deng)"
}
