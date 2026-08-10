'use client';

import Link from 'next/link';
import AuthForm from '@/components/auth/AuthForm';

/**
 * Page d'authentification autonome.
 *
 * Le template intègre ce formulaire dans la section « inscription » de la
 * landing, mais cette route reste indispensable : le tableau de bord y redirige
 * tout visiteur non connecté. Les deux partagent le même composant.
 */
export default function AuthPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="border-b border-slate-200 bg-surface">
        <div className="max-w-[1280px] mx-auto px-6 h-[68px] flex items-center">
          <Link href="/" className="flex items-center gap-2.5 text-slate-950">
            <span className="w-8 h-8 rounded-md bg-brand-500 flex items-center justify-center text-surface">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M22 8.6a1 1 0 0 0-1.5-.9L17 9.8V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.8l3.5 2.1a1 1 0 0 0 1.5-.9V8.6Z" />
              </svg>
            </span>
            <span className="font-display font-bold text-[18px] tracking-heading">Stark Meet</span>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px]">
          <AuthForm defaultMode="signin" />
        </div>
      </main>
    </div>
  );
}
