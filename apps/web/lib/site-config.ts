/**
 * Public-site contact details. EVERY value here is a PLACEHOLDER that cannot reach a real person
 * (".example" is a reserved domain; the phone number has X digits). Swap them here in one edit,
 * set PLACEHOLDER_TAG to '' and rebuild (scripts/build-site.mjs). See infra/cloudflare-site/README.md.
 */
export const SITE_CONTACT = {
  complaintsEmail: 'complaints@your-domain.example',
  complaintsPhone: '+254 7XX XXX XXX',
  generalEmail: 'hello@your-domain.example',
  dataProtectionEmail: 'dpo@your-domain.example',
  postalAddress: 'P.O. Box XXXXX-00100, Nairobi',
} as const;
export const PLACEHOLDER_TAG = '(placeholder)';
/** Version of the draft privacy notice shown at the forms; stored with each submission. */
export const PRIVACY_NOTICE_VERSION = 'PN-2026-11-v1';

export const contactParams = () => ({
  email: `${SITE_CONTACT.complaintsEmail} ${PLACEHOLDER_TAG}`.trim(),
  phone: `${SITE_CONTACT.complaintsPhone} ${PLACEHOLDER_TAG}`.trim(),
  general: `${SITE_CONTACT.generalEmail} ${PLACEHOLDER_TAG}`.trim(),
  dpo: `${SITE_CONTACT.dataProtectionEmail} ${PLACEHOLDER_TAG}`.trim(),
  address: `${SITE_CONTACT.postalAddress} ${PLACEHOLDER_TAG}`.trim(),
});
