resource "aws_kms_key" "data" {
  description         = "mapema ${var.env}: RDS, S3, Secrets Manager"
  enable_key_rotation = true
}

resource "aws_db_subnet_group" "db" {
  name       = "mapema-${var.env}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "pg" {
  identifier                   = "mapema-${var.env}"
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = var.db_instance_class
  allocated_storage            = 50
  storage_type                 = "gp3"
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.data.arn
  multi_az                     = var.db_multi_az
  db_subnet_group_name         = aws_db_subnet_group.db.name
  username                     = "mapema_owner"
  manage_master_user_password  = true                      # password lives in Secrets Manager, never in state
  backup_retention_period      = var.backup_retention_days # enables PITR (backup-and-restore.md)
  backup_window                = "00:30-01:30"             # 03:30-04:30 EAT
  copy_tags_to_snapshot        = true
  deletion_protection          = true
  performance_insights_enabled = true
  publicly_accessible          = false
  skip_final_snapshot          = false
  final_snapshot_identifier    = "mapema-${var.env}-final"
}

resource "aws_s3_bucket" "artefacts" { bucket_prefix = "mapema-${var.env}-artefacts-" }
resource "aws_s3_bucket_versioning" "artefacts" {
  bucket = aws_s3_bucket.artefacts.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "artefacts" {
  bucket                  = aws_s3_bucket.artefacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "artefacts" {
  bucket = aws_s3_bucket.artefacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

# Empty secret containers; values are put in by Deng, never by Terraform or CI.
resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(["STORAGE_ENCRYPTION_KEY", "OIDC_CLIENT_SECRET", "MPESA_CALLBACK_TOKEN", "BANK_WEBHOOK_SECRET", "FINERACT_PASSWORD"])
  name       = "mapema/${var.env}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}
