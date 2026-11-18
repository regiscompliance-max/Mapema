# Terraform skeleton (staging first) — NOT applied

**[DevOps]** Written on the go-live branch; never run against a real account (no accounts, no spend). It describes the
staging shape in `docs/go-live/staging-plan.md` on AWS af-south-1. Region, sizes and names are variables so a later
move (e.g. an in-country provider) changes inputs, not the app.

```
terraform -chdir=infra/terraform init -backend-config=backend-staging.hcl   # S3 state + DynamoDB lock, created by Deng
terraform -chdir=infra/terraform plan -var-file=staging.tfvars
```

Secrets are never Terraform inputs: the stack creates empty Secrets Manager entries; values are put in by Deng
(`aws secretsmanager put-secret-value`) so they are not in state files or CI logs.
