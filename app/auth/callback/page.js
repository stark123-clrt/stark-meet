'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { ensureProfile } from '@/lib/ensureProfile';

/**
 * Retour de connexion Google.
 *
 * Google renvoie vers Supabase (`/auth/v1/callback`), qui crée la session puis
 * redirige ici. Cette page a deux responsabilités : récupérer la session, et
 * s'assurer que la ligne `profiles` existe — sans elle, la clé étrangère
 * `meetings.host_id` empêcherait le compte de créer la moindre réunion.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    const complete = async () => {
      const supabase = createClient();

      try {
        // Supabase renvoie soit un `?code=` (flux PKCE), soit les jetons dans
        // le fragment d'URL (flux implicite), selon la version du client. On
        // couvre les deux plutôt que de dépendre d'un réglage par défaut.
        const params = new URLSearchParams(window.location.search);

        const providerError = params.get('error_description') || params.get('error');
        if (providerError) throw new Error(providerError);

        const code = params.get('code');
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
        }

        // En flux implicite, `detectSessionInUrl` a déjà traité le fragment.
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) throw new Error('Session introuvable après la connexion');

        await ensureProfile(supabase, session.user);

        router.replace('/dashboard');
      } catch (err) {
        console.error('Erreur de connexion Google:', err);
        setError(err.message || 'La connexion a échoué');
      }
    };

    complete();
  }, [router]);

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      {error ? (
        <div className="text-center max-w-sm">
          <p className="font-display font-bold text-[18px] tracking-heading">Connexion impossible</p>
          <p className="text-slate-500 text-sm mt-1.5">{error}</p>
          <button
            onClick={() => router.replace('/auth')}
            className="mt-5 text-sm font-medium text-brand-500 hover:text-brand-600"
          >
            Revenir à la connexion
          </button>
        </div>
      ) : (
        <p className="text-slate-700 text-sm font-mono">Connexion en cours…</p>
      )}
    </div>
  );
}
