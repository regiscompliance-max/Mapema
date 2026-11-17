'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { oidcCallback } from '@/lib/session';

export default function Callback() {
  const router = useRouter(); const [err, setErr] = useState('');
  useEffect(() => { oidcCallback(new URLSearchParams(location.search)).then(() => router.replace('/app'), (e) => setErr((e as Error).message)); }, [router]);
  return <p role={err ? 'alert' : 'status'}>{err || 'Signing you in…'}</p>;
}
