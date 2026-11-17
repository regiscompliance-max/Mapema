'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/components/lang';
import { AuditorPortal } from '@/components/portals/auditor';
import { BuyerPortal } from '@/components/portals/buyer';
import { StaffPortal } from '@/components/portals/staff';
import { SupplierPortal } from '@/components/portals/supplier';
import { ErrorBox, useGet } from '@/components/ui';
import { clearSession, getSession } from '@/lib/session';

/** Role router: one sign-in, the portal matches the user's roles (staff > auditor > buyer > supplier). */
export default function AppHome() {
  const t = useT(); const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => { if (!getSession()) router.replace('/signin'); else setReady(true); }, [router]);
  const me = useGet<any>(ready ? '/me' : null);
  if (!ready) return null;
  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data) return <p>{t('portal.loading')}</p>;
  const roles: string[] = me.data.roles.map((r: any) => r.role);
  const org = me.data.roles.find((r: any) => r.orgId)?.orgId;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><p className="text-sm text-slate-600">{me.data.displayName} · {roles.join(', ')}</p>
        <button className="underline" onClick={() => { clearSession(); router.push('/'); }}>{t('portal.signout')}</button></div>
      {me.data.staff ? <StaffPortal roles={roles} /> : roles.includes('auditor') ? <AuditorPortal /> : roles.some((r) => r.startsWith('buyer_')) ? <BuyerPortal roles={roles} orgId={org} /> : <SupplierPortal orgId={org} />}
    </div>
  );
}
