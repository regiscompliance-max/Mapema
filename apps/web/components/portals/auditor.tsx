'use client';
import { useState } from 'react';
import { download } from '@/lib/api';
import { useT } from '../lang';
import { Table, Tabs, useGet } from '../ui';
import { ReconBreaks, Reports, StaffOverview } from './phase2';

export function AuditorPortal() {
  const t = useT();
  const [tab, setTab] = useState('portfolio');
  const portfolio = useGet<any[]>(tab === 'portfolio' ? '/reports/portfolio' : null);
  const events = useGet<any[]>(tab === 'audit' ? '/audit/events?limit=200' : null);
  const tb = useGet<any>(tab === 'tb' ? '/ledger/trial-balance' : null);
  const verify = useGet<any>(tab === 'audit' ? '/audit/verify' : null);
  async function exportCsv() {
    await download('/audit/export', 'mapema-audit-export.csv');
  }
  return (
    <div>
      <h1 className="h2 mb-2">{t('auditor.title')}</h1>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'portfolio', label: 'Portfolio' }, { id: 'audit', label: 'Audit log' }, { id: 'tb', label: 'Trial balance' }, { id: 'overview', label: 'Dashboard' }, { id: 'reports', label: 'Reports' }, { id: 'recon', label: 'Reconciliation' }]} />
      {tab === 'overview' && <StaffOverview />}
      {tab === 'reports' && <Reports canGenerate={false} />}
      {tab === 'recon' && <ReconBreaks canOps={false} />}
      {tab === 'portfolio' && <Table rows={portfolio.data} cols={[{ key: 'invoice_number', label: 'Invoice' }, { key: 'supplier', label: 'Supplier' }, { key: 'buyer', label: 'Buyer' }, { key: 'status', label: 'Status' },
        { key: 'principal_cents', label: 'Advance', money: true }, { key: 'principal_repaid', label: 'Principal repaid', money: true }, { key: 'fees_repaid', label: 'Fees', money: true }, { key: 'interest_repaid', label: 'Interest', money: true }, { key: 'supplier_balance', label: 'Supplier balance', money: true }]} />}
      {tab === 'audit' && <div className="space-y-3"><p>Hash chain: <strong>{verify.data ? (verify.data.ok ? `intact (${verify.data.checked} events)` : `BROKEN at ${verify.data.brokenAt}`) : '…'}</strong> <button className="btn-secondary ml-2 !min-h-10 !py-2" onClick={exportCsv}>Export CSV</button></p>
        <Table rows={events.data} cols={[{ key: 'id', label: '#' }, { key: 'occurred_at', label: 'When', render: (r) => String(r.occurred_at).slice(0, 19) }, { key: 'actor_role', label: 'Actor' }, { key: 'action', label: 'Action' }, { key: 'entity_type', label: 'Entity' }]} /></div>}
      {tab === 'tb' && tb.data && <Table rows={Object.entries(tb.data.accounts).map(([k, v]) => ({ id: k, account: k, balance: v }))} cols={[{ key: 'account', label: 'Account' }, { key: 'balance', label: 'Balance (Dr +)', money: true }]} />}
    </div>
  );
}
