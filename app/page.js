'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState('');

  const handleJoin = (e) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    router.push(`/room/${trimmed}`);
  };

  return (
    <div className="min-h-screen bg-ink-950 flex flex-col">
      <nav className="flex items-center justify-between px-6 sm:px-10 py-5">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-signal-500" />
          <span className="font-mono font-bold text-white text-sm tracking-tight">STARK MEET</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/auth" className="text-mist-300 hover:text-white text-sm transition-colors">
            Connexion
          </Link>
          <Link
            href="/auth"
            className="bg-signal-500 hover:bg-signal-400 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
          >
            Créer un compte
          </Link>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="max-w-lg w-full text-center">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-500 mb-4">
            Visioconférence — sans compromis
          </p>
          <h1 className="font-mono text-4xl sm:text-5xl font-bold text-white leading-tight mb-5 text-balance">
            Vos réunions,<br />
            <span className="text-signal-400">sous votre contrôle.</span>
          </h1>
          <p className="text-mist-300 text-base mb-9 max-w-md mx-auto">
            Créez une salle, invitez qui vous voulez, décidez qui entre.
          </p>

          <form onSubmit={handleJoin} className="flex gap-2 max-w-sm mx-auto">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code de réunion"
              className="flex-1 bg-ink-900 border border-ink-700 rounded-md px-4 py-3 text-white text-sm font-mono placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors text-center tracking-wide"
            />
            <button
              type="submit"
              className="bg-signal-500 hover:bg-signal-400 text-white font-medium px-5 py-3 rounded-md text-sm transition-colors whitespace-nowrap"
            >
              Rejoindre
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
