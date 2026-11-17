/** [Security Engineer] The CSRF token lives in module memory only (never in storage, never in a readable cookie). */
let csrf: string | null = null;
export const getCsrf = () => csrf;
export const setCsrf = (t: string | null) => { csrf = t; };
export const onUnauthenticated = () => { csrf = null; };
