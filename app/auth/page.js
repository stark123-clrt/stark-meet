'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Eye, EyeOff } from 'lucide-react';
import { createClient } from '@/lib/supabase';

/** Logo Google, en SVG intégré : aucune requête réseau, net à toute taille. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true" className="flex-none">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [formData, setFormData] = useState({ fullName: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Connexion Google. Un seul bouton pour se connecter ET s'inscrire : si le
   * compte n'existe pas, GoTrue le crée à la volée à partir de l'identité
   * Google, et la page de retour se charge de créer le profil applicatif.
   */
  const handleGoogle = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Doit figurer dans la liste d'URL autorisées de Supabase
          // (GOTRUE_URI_ALLOW_LIST), sinon le retour est refusé.
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (oauthError) throw oauthError;
      // Succès : le navigateur part chez Google, rien à faire de plus ici.
    } catch (err) {
      console.error('Erreur Google OAuth:', err);
      setError("La connexion Google n'est pas disponible pour le moment.");
      setGoogleLoading(false);
    }
  };

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password,
      });
      if (authError) throw authError;

      router.push('/dashboard');
    } catch (err) {
      setError('Email ou mot de passe incorrect');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');

    if (formData.password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
      });
      if (authError) throw authError;
      if (!authData.user) throw new Error('Erreur lors de la création du compte');

      const { error: profileError } = await supabase.from('profiles').upsert({
        id: authData.user.id,
        email: formData.email,
        full_name: formData.fullName,
      });
      if (profileError) throw profileError;

      await fetch('/api/auth/confirm-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: authData.user.id }),
      });

      // Connexion immédiate après inscription
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password,
      });
      if (loginError) throw loginError;

      router.push('/dashboard');
    } catch (err) {
      setError(err.message || 'Une erreur est survenue lors de l\'inscription');
    } finally {
      setLoading(false);
    }
  };

  const isRegister = mode === 'register';

  return (
    <div className="min-h-screen bg-ink-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-8">
          <span className="w-2.5 h-2.5 rounded-full bg-signal-500" />
          <span className="font-mono font-bold text-white tracking-tight">STARK MEET</span>
        </div>

        <div className="bg-ink-900 border border-ink-700 rounded-lg p-7">
          <h1 className="text-white text-xl font-semibold mb-1">
            {isRegister ? 'Créer votre compte' : 'Bienvenue'}
          </h1>
          <p className="text-ink-500 text-sm mb-6">
            {isRegister ? 'Pour créer et animer vos réunions.' : 'Connectez-vous pour accéder à vos réunions.'}
          </p>

          {error && (
            <div className="bg-signal-500/10 border border-signal-500/20 text-signal-300 px-3.5 py-2.5 rounded-md text-sm mb-4">
              {error}
            </div>
          )}

          {/* Un seul bouton pour se connecter et s'inscrire : Google ne fait
              pas la distinction, et le compte est créé au premier passage. */}
          <button
            type="button"
            onClick={handleGoogle}
            disabled={googleLoading || loading}
            className="w-full flex items-center justify-center gap-2.5 bg-white hover:bg-mist-100 disabled:opacity-60 disabled:cursor-not-allowed text-[#1f1f1f] font-medium py-2.5 rounded-md transition-colors text-sm"
          >
            <GoogleMark />
            {googleLoading ? 'Redirection…' : 'Continuer avec Google'}
          </button>

          <div className="flex items-center gap-3 my-5">
            <span className="flex-1 h-px bg-ink-700" />
            <span className="font-mono text-[10.5px] tracking-wide text-ink-600">OU</span>
            <span className="flex-1 h-px bg-ink-700" />
          </div>

          <form onSubmit={isRegister ? handleRegister : handleLogin} className="space-y-4">

            {isRegister && (
              <div>
                <label className="block text-xs font-medium text-mist-300 mb-1.5">Nom complet</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
                  <input
                    type="text"
                    name="fullName"
                    value={formData.fullName}
                    onChange={handleChange}
                    required
                    placeholder="Jean Dupont"
                    className="w-full pl-9 pr-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-mist-300 mb-1.5">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  placeholder="vous@exemple.com"
                  className="w-full pl-9 pr-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-mist-300 mb-1.5">Mot de passe</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  placeholder="••••••••"
                  className="w-full pl-9 pr-9 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-500 hover:text-white"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-signal-500 hover:bg-signal-400 disabled:opacity-50 text-white font-medium py-2.5 rounded-md transition-colors text-sm"
            >
              {loading ? 'Un instant…' : isRegister ? 'Créer mon compte' : 'Se connecter'}
            </button>
          </form>

          <p className="text-center text-ink-500 text-sm mt-5">
            {isRegister ? 'Déjà un compte ?' : "Pas encore de compte ?"}{' '}
            <button
              onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}
              className="text-signal-400 hover:text-signal-300 font-medium"
            >
              {isRegister ? 'Se connecter' : 'Créer un compte'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
