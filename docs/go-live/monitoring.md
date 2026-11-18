# Monitoring and alerting

**[DevOps + Security Engineer]** 18 Nov 2026. CloudWatch (metrics, logs, alarms) -> SNS -> email/SMS to the on-call
person; Terraform skeleton in `infra/terraform/monitoring.tf`. Times EAT.

## Signals

| Signal | Source | Alert when | Severity |
| --- | --- | --- | --- |
| API up | `GET /v1/health` every minute (Route 53 health check or uptime monitor) | 2 failures in a row | P1 |
| Provider health | `/v1/health` providers list | any provider `ok: false` for 10 min | P2 |
| 5xx rate | ALB metrics | > 2% for 5 min | P1 |
| Latency | ALB p95 | > 2 s for 10 min | P3 |
| DB CPU / free storage / connections | RDS | > 80% 15 min / < 5 GiB / > 80% max | P2 |
| Outbox backlog | `SELECT count(*) FROM outbox WHERE status IN ('pending','failed') AND next_attempt_at < now() - interval '15 min'` | > 0 | P2 |
| Dead jobs | `outbox.status = 'dead'` | any new | P1 (money may be stuck) |
| Daily reconciliation | 06:30 EAT worker job | any `unexplained` break, or the run missing by 07:00 | P1 |
| M-Pesa pending payouts | advances `released` with no result after `MPESA_RESULT_TIMEOUT_MINUTES` + status query | any unknown after the query | P1 |
| ERP imports | `erp_import_run` | status `error`, a connection paused, or any file `infected` / `unsafe_file` | P2 |
| Audit chain | nightly `GET /v1/audit/verify` | `ok: false` | P1 (possible tampering) |
| Security events | audit log | spikes in `session.oidc_failed`, any `mpesa.callback_previous_token` after a rotation window, `BAD_CALLBACK_TOKEN` responses (401) on the M-Pesa webhooks, lending switch changes | P2 |
| Backups | RDS events | backup failure; monthly restore test not logged by the 10th | P2 |
| Certificates | ACM | expiry < 21 days | P3 |

## Logs

- JSON logs with request ids; tokens and secrets never logged (M-Pesa callback token masked in the API and in nginx,
  `infra/proxy/nginx.conf`). Retention 90 days hot, 1 year archived (counsel to confirm against the retention schedule).
- Access to logs is limited to admin/ops engineers; log access is itself logged by the cloud provider.

## Incident reporting

A significant cyber or fraud incident must be reported to CBK within **24 hours** (NDTCP reg. 66, as summarised in
Phase 0 C-14, counsel to confirm), and a personal-data breach to the ODPC within **72 hours** (DPA s.43). The P1
runbook starts the clock at detection.
