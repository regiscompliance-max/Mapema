# Staging plan

**[DevOps + Architect + Compliance]** 18 Nov 2026. Nothing here has been created: no accounts, no spend. Deng (or his
developer) opens the cloud account; the build team never holds the root login.

## 1. Where to host

Checked 18 Nov 2026 (sources at the end):

| Option | In Kenya? | Managed Postgres with PITR | Notes |
| --- | --- | --- | --- |
| **AWS af-south-1 (Cape Town)** | No (South Africa) | Yes (RDS) | Nearest hyperscaler region with every managed piece we need (RDS PITR, KMS, Secrets Manager, ALB, CloudWatch). A Nairobi Local Zone is announced, not generally available. |
| Azure South Africa North / Google africa-south1 (Johannesburg) | No | Yes | Equivalent; no Kenya region (the Microsoft/G42 Kenya region is stalled). |
| Oracle Cloud Nairobi (hosted by iXAfrica) | Yes, when live | Yes | Announced 27 Jan 2026; no launch date. Revisit before production. |
| Kenyan VPS / colocation (e.g. Lineserve, Truehost, Safaricom/iXAfrica colocation) | Yes | No (self-managed) | Cheapest and in-country, but we would run Postgres, backups, PITR, patching and monitoring ourselves. |

**Recommendation (default):** staging on **AWS af-south-1** with synthetic data only. Production region is a
counsel + CBK question (see §2): the IaC is region-agnostic, so moving to an in-country provider later is a variable
change plus a data migration.

## 2. Data protection and residency (counsel to confirm)

- **DPA 2019 s.48–50 and the Data Protection (General) Regulations 2021:** transfers outside Kenya need a lawful basis and
  appropriate safeguards; sensitive personal data (e.g. KYC biometrics) needs consent and safeguards. **Reg. 26** requires
  in-Kenya processing (or a serving copy in Kenya) only for listed strategic-interest purposes (civil registration and identity, elections,
  public revenue and finance, protected computer systems, and basic education and health); private lending is not listed
  (Phase 0 C-18).
  ODPC published a cross-border transfer guidance note (2026); counsel should apply it.
- **CBK NDTCP Regulations 2026 reg. 31 (as summarised, Phase 0 C-10):** at least 30 days' notice to CBK before material
  outsourcing, which includes cloud hosting of the loan book and Fineract.
- **Staging holds no real personal data.** Seeds are synthetic (Phase 1+). Production needs: ODPC registration, DPIA,
  a processor agreement with the cloud provider (AWS DPA is part of its service terms), the vendor register entry and
  the CBK outsourcing notice.

## 3. Shape of staging

```
Internet -> ALB (TLS, WAF optional) -> nginx (masked logs, infra/proxy/nginx.conf)
            |- web (Next.js)        |- api (NestJS) + worker   |- Keycloak (admin console not public)
            private subnets: RDS PostgreSQL 17 (app db + keycloak db + fineract db, separate roles), Fineract 1.16.1
            S3 (artefact exports, backups copy, versioned, KMS), Secrets Manager, CloudWatch, ClamAV sidecar on the api host
```

## 4. Monthly cost (ESTIMATE, staging, on-demand, af-south-1, USD, before tax)

| Item | Size | Unit price (source) | Monthly |
| --- | --- | --- | --- |
| API + worker + ClamAV | EC2 t4g.medium | $0.043/h [1] | $31 |
| Web | EC2 t4g.medium | $0.043/h [1] | $31 |
| Keycloak | EC2 t4g.medium | $0.043/h [1] | $31 |
| Fineract | EC2 t4g.large (estimated 2x medium) | ~$0.086/h [1, estimated] | $63 |
| PostgreSQL | RDS db.t4g.medium Single-AZ | $0.082/h ($59.86/mo) [2][3] | $60 |
| Database storage + backups | 50 GB gp3, 7-day PITR | ~$0.15/GB-mo (estimate) | $8 |
| Load balancer | ALB + ~1 LCU | $0.03/h + $0.0095/LCU-h [4] | $29 |
| NAT gateway | 1 AZ | $0.057/h + $0.057/GB [5] | $45 |
| S3, KMS, Secrets Manager, CloudWatch logs/alarms, data transfer | low volume | estimate | $30 |
| **Total (estimate)** | | | **~$330 / month (about KES 43,000 at an assumed KES 129/USD)** |

- Production (Multi-AZ RDS at $0.164/h [2], two API hosts, larger Fineract) is roughly **2x: ~$650–750/month (estimate)**.
- 1-year reservations cut the RDS line to about $41/month [2].
- In-country VPS alternative: about **KES 3,240–5,600 per 2 vCPU / 4 GB VM per month** [6][7], so ~KES 15,000–25,000
  for five VMs, but with self-managed Postgres/PITR and no managed KMS.
- Not included: domain, pen test (separate RFP), provider fees, support plans, VAT.

Sources (checked 18 Nov 2026; prices change, confirm in the AWS pricing calculator before committing):
[1] devzero.io/instances/aws/t4g.medium and /regions/af-south-1 · [2] cloud-credits.org/prices/rds/db-t4g-medium/af-south-1
(updated 2026-10-19) · [3] bytebase.com/dbcost/rds/instance/db.t4g.medium (updated 16 Nov 2026) ·
[4] cloud-credits.org/prices/alb/af-south-1 · [5] cloud-credits.org/prices/nat-gateway/af-south-1, aws.amazon.com/vpc/pricing ·
[6] lineserve.co.ke/pricing · [7] truehost.co.ke/vps-hosting · Region facts: lineserve.net/blog/datacenters-in-kenya (2026),
datacenterdynamics.com (Microsoft/G42 Kenya stall), Reuters 10 May 2026 · DPA reg. 26: new.kenyalaw.org/akn/ke/act/ln/2021/263,
ODPC guidance note: odpc.go.ke (Guidance Note on Cross-border Data Transfers, 2026).

## 5. How it gets built (when Deng says go)

1. Deng creates the AWS account (root MFA, billing alarm at $400), an IAM Identity Center admin for himself, and a
   deploy role trusted by GitHub OIDC for `regiscompliance-max/Mapema` (no long-lived keys).
2. `infra/terraform` (skeleton in this branch) is applied by Deng's developer: `terraform init/plan/apply` with
   `env=staging`.
3. GitHub environment `staging` with required reviewer = Deng; `.github/workflows/deploy-staging.yml` is manual-only
   and refuses to run until the repo variable `STAGING_ENABLED=true` is set.
4. Run migrations, `node scripts/keycloak-configure.mjs`, seed the synthetic demo world, then the go-live checklist.
