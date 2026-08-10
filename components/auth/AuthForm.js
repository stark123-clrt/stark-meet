'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { ensureProfile } from '@/lib/ensureProfile';

/** Logo Google en SVG intégré — aucune requête réseau, net à toute taille. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="flex-none">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function Field({ label, error, ...props }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-slate-700 mb-1.5">{label}</span>
      <input
        {...props}
        className={`w-full h-11 px-3.5 rounded-sm border bg-surface text-[15px] text-slate-950 placeholder:text-slate-500 outline-none transition-shadow duration-200 ease-standard focus:shadow-focus ${
          error ? 'border-error-500' : 'border-slate-200 focus:border-brand-500'
        }`}
      />
      {error && <span className="block text-[12px] text-error-500 mt-1.5">{error}</span>}
    </label>
  );
}

/**
 * Formulaire d'inscription et de connexion.
 *
 * Extrait de la page /auth pour être partagé : le template intègre ce même
 * bloc dans la section « inscription » de la landing, et la route /auth reste
 * nécessaire pour y rediriger un visiteur non connecté.
 */
export default function AuthForm({ defaultMode = 'signup', onAuthenticated }) {
  const router = useRouter();
  const [mode, setMode] = useState(defaultMode); // 'signup' | 'signin'
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [terms, setTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isSignup = mode === 'signup';

  const change = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
    setError('');
  };

  const finish = async () => {
    if (onAuthenticated) return onAuthenticated();
    router.push('/dashboard');
  };

  /** Un seul bouton pour se connecter ET s'inscrire : Google ne distingue pas
   *  les deux, et le compte est créé au premier passage. */
  const handleGoogle = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          // Affiche toujours le sélecteur de compte : sans ça, un navigateur
          // déjà connecté à Google enferme dans une seule identité.
          queryParams: { prompt: 'select_account' },
        },
      });
      if (oauthError) throw oauthError;
    } catch (err) {
      console.error('Erreur Google OAuth:', err);
      setError("La connexion Google n'est pas disponible pour le moment.");
      setGoogleLoading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (isSignup) {
      if (form.password.length < 8) {
        setError('Le mot de passe doit contenir au moins 8 caractères.');
        return;
      }
      if (!terms) {
        setError("Vous devez accepter les conditions d'utilisation.");
        return;
      }
    }

    setLoading(true);
    const supabase = createClient();

    try {
      if (!isSignup) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: form.email,
          password: form.password,
        });
        if (signInError) throw new Error('Email ou mot de passe incorrect.');
        await finish();
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: form.email,
        password: form.password,
      });
      if (signUpError) throw signUpError;
      if (!data.user) throw new Error('Erreur lors de la création du compte.');

      await supabase.from('profiles').upsert({
        id: data.user.id,
        email: form.email,
        full_name: form.fullName.trim() || form.email.split('@')[0],
      });

      // L'instance self-hosted n'a pas de SMTP : sans cette confirmation
      // forcée, le compte ne pourrait jamais se connecter.
      await fetch('/api/auth/confirm-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: data.user.id }),
      });

      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      });
      if (loginError) throw loginError;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) await ensureProfile(supabase, user);

      await finish();
    } catch (err) {
      setError(err.message || 'Une erreur est survenue.');
    } finally {
      setLoading(false);
    }
  };

  const tabClass = (active) =>
    `flex-1 h-9 rounded-sm text-[14px] font-medium transition-colors duration-200 ease-standard ${
      active ? 'bg-surface text-slate-950 shadow-sm' : 'text-slate-700 hover:text-slate-950'
    }`;

  return (
    <div className="bg-surface border border-slate-200 rounded-lg p-8">
      <div className="flex gap-1 p-1 bg-slate-100 rounded-md mb-6">
        <button type="button" onClick={() => { setMode('signup'); setError(''); }} className={tabClass(isSignup)}>
          Créer un compte
        </button>
        <button type="button" onClick={() => { setMode('signin'); setError(''); }} className={tabClass(!isSignup)}>
          Se connecter
        </button>
      </div>

      <h2 className="font-display font-bold text-2xl tracking-heading text-slate-950 mb-1.5">
        {isSignup ? 'Créez votre espace' : 'Content de vous revoir'}
      </h2>
      <p className="text-[14px] text-slate-700 mb-6">
        {isSignup
          ? 'Votre première réunion dans une minute.'
          : 'Connectez-vous pour retrouver vos réunions.'}
      </p>

      <button
        type="button"
        onClick={handleGoogle}
        disabled={googleLoading || loading}
        className="w-full h-11 flex items-center justify-center gap-2.5 border border-slate-200 rounded-sm bg-surface text-[15px] font-medium text-slate-950 transition duration-200 ease-standard hover:bg-slate-50 hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed disabled:translate-y-0"
      >
        <GoogleMark />
        {googleLoading ? 'Redirection…' : 'Continuer avec Google'}
      </button>

      <div className="flex items-center gap-3 my-5">
        <span className="flex-1 h-px bg-slate-200" />
        <span className="text-[12px] text-slate-500">ou par e-mail</span>
        <span className="flex-1 h-px bg-slate-200" />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {isSignup && (
          <Field
            label="Nom complet"
            type="text"
            required
            placeholder="Adam Joseph"
            value={form.fullName}
            onChange={change('fullName')}
          />
        )}

        <Field
          label="Adresse e-mail"
          type="email"
          required
          placeholder="vous@entreprise.com"
          value={form.email}
          onChange={change('email')}
        />

        <Field
          label="Mot de passe"
          type="password"
          required
          placeholder="8 caractères minimum"
          value={form.password}
          onChange={change('password')}
        />

        {isSignup ? (
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded-xs border-slate-200 text-brand-500 focus:ring-brand-500"
            />
            <span className="text-[13px] leading-relaxed text-slate-700">
              J&apos;accepte les conditions d&apos;utilisation et la politique de confidentialité.
            </span>
          </label>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() =>
                setNotice(
                  "La réinitialisation par e-mail n'est pas encore active. Utilisez « Continuer avec Google » ou contactez l'hôte."
                )
              }
              className="text-[13px] text-brand-500 hover:text-brand-600"
            >
              Mot de passe oublié ?
            </button>
          </div>
        )}

        {error && (
          <p className="px-3.5 py-2.5 rounded-sm bg-error-50 text-error-500 text-[13px]">{error}</p>
        )}
        {notice && (
          <p className="px-3.5 py-2.5 rounded-sm bg-brand-50 text-brand-500 text-[13px]">{notice}</p>
        )}

        <button
          type="submit"
          disabled={loading || googleLoading}
          className="w-full h-11 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold transition duration-200 ease-standard hover:bg-brand-600 hover:shadow-brand-glow disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {loading ? 'Un instant…' : isSignup ? 'Créer mon compte' : 'Se connecter'}
        </button>
      </form>

      <p className="mt-5 text-[12px] leading-relaxed text-slate-500">
        Aucune carte bancaire requise. Réunions illimitées jusqu&apos;à 40 minutes sur le plan gratuit.
      </p>
    </div>
  );
}
