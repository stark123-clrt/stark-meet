'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Eye, EyeOff } from 'lucide-react';
import { createClient } from '@/lib/supabase';

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [formData, setFormData] = useState({ fullName: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

          <form onSubmit={isRegister ? handleRegister : handleLogin} className="space-y-4">
            {error && (
              <div className="bg-signal-500/10 border border-signal-500/20 text-signal-300 px-3.5 py-2.5 rounded-md text-sm">
                {error}
              </div>
            )}

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
