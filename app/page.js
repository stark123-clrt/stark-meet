'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const PREVIEW_TILES = [
  { name: 'Léa Girard', bg: 'linear-gradient(155deg,#3a2a52,#1a1428)' },
  { name: 'Marc Nadeau', bg: 'linear-gradient(155deg,#1f4a45,#122120)' },
  { name: 'Ines Provost', bg: 'linear-gradient(155deg,#4a2f1c,#1c1410)' },
  { name: '+ 3 autres', bg: 'linear-gradient(155deg,#1c3350,#111a26)' },
];

const FEATURES = [
  { n: '01', text: "Salle d'attente — vous décidez qui entre, et quand." },
  { n: '02', text: 'Jusqu’à 16 participants vidéo, sans latence perceptible.' },
  { n: '03', text: 'Partage d’écran et chat intégrés, sans module externe.' },
];

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
      <nav className="flex items-center justify-between px-6 sm:px-14 py-5">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-signal-500 inline-block" />
          <span className="font-mono font-bold text-white text-sm tracking-wide">STARK MEET</span>
        </div>
        <div className="hidden md:flex items-center gap-9">
          <span className="text-sm text-mist-300">Fonctionnalités</span>
          <span className="text-sm text-mist-300">Tarifs</span>
          <span className="text-sm text-mist-300">Documentation</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/auth"
            className="hidden sm:inline text-sm text-white px-4 py-2.5 border border-ink-700 rounded transition-colors hover:bg-ink-800"
          >
            Connexion
          </Link>
          <Link
            href="/auth"
            className="text-sm font-semibold text-white px-4 py-2.5 bg-signal-500 hover:bg-signal-600 rounded transition-colors"
          >
            Créer un compte
          </Link>
        </div>
      </nav>

      <main className="flex-1 flex flex-col justify-center gap-12 sm:gap-14 px-6 sm:px-14 max-w-[1320px] mx-auto w-full py-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16 items-center">
          <div className="flex flex-col gap-6">
            <p className="font-mono text-xs font-semibold tracking-[0.1em] text-ink-500">
              VISIOCONFÉRENCE — SANS COMPROMIS
            </p>
            <h1 className="text-4xl sm:text-[52px] leading-[1.12] font-bold text-white text-balance">
              Vos réunions,
              <br />
              <span className="text-signal-500">sous votre contrôle.</span>
            </h1>
            <p className="text-base leading-relaxed text-mist-300 max-w-[460px]">
              Créez une salle en un clic, invitez qui vous voulez, décidez qui entre. Stark Meet
              donne à l'hôte les commandes qu'un vrai régisseur attend — pas un gadget de plus.
            </p>
            <form onSubmit={handleJoin} className="flex gap-2.5 mt-1">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code de réunion — ex. RD7-KX2"
                className="flex-1 max-w-[260px] font-mono text-sm text-white bg-transparent border border-ink-700 rounded px-4 py-3.5 outline-none focus:border-signal-500 transition-colors"
              />
              <button
                type="submit"
                className="text-sm font-semibold text-white px-6 py-3.5 bg-signal-500 hover:bg-signal-600 rounded transition-colors whitespace-nowrap"
              >
                Rejoindre
              </button>
            </form>
          </div>

          <div className="border border-ink-700 rounded-lg overflow-hidden bg-ink-900 shadow-[0_30px_70px_-24px_rgba(0,0,0,0.65)]">
            <div className="flex items-center justify-end px-3.5 py-2.5 border-b border-ink-700">
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ok-500">
                <span className="w-1.5 h-1.5 rounded-full bg-ok-500 inline-block" />
                EN DIRECT
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-white/[0.06]">
              {PREVIEW_TILES.map((t) => (
                <div
                  key={t.name}
                  className="aspect-[4/3] flex items-end p-3 text-[13px] text-white/75"
                  style={{ background: t.bg }}
                >
                  {t.name}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-10 pt-8 border-t border-ink-700">
          {FEATURES.map((f) => (
            <div key={f.n} className="flex flex-col gap-2">
              <span className="font-mono text-xs font-bold text-signal-500">{f.n}</span>
              <span className="text-[14.5px] leading-relaxed text-mist-300">{f.text}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
