'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, Link2, ShieldCheck, MonitorUp, MessagesSquare,
  LayoutGrid, Hand, Lock, Server, Globe2, Check,
} from 'lucide-react';
import AuthForm from '@/components/auth/AuthForm';
import { parseMeetingCode } from '@/lib/meetingCode';
import { initialsOf, avatarColorFor } from '@/lib/identity';

// Contenu volontairement aligné sur ce que l'application sait réellement
// faire : une landing qui promet des fonctions inexistantes se retourne contre
// le produit dès le premier essai.
const FEATURES = [
  { icon: Link2, title: 'Un lien, et c\'est parti', text: 'Chaque réunion a son code. Vos invités ouvrent le lien dans leur navigateur — aucune installation, aucun compte requis.' },
  { icon: ShieldCheck, title: 'Salle d\'attente et modération', text: 'Vous admettez qui vous voulez, coupez un micro ou excluez quelqu\'un. La coupure est appliquée par le serveur, pas seulement affichée.' },
  { icon: MonitorUp, title: 'Partage d\'écran lisible', text: 'L\'écran partagé passe au premier plan et s\'affiche en entier. Chacun peut choisir de le remplir pour zoomer sur le contenu.' },
  { icon: MessagesSquare, title: 'Discussion et réactions', text: 'Messages en direct, emojis, réactions sous chaque message, et un compteur de non-lus pour ne rien manquer.' },
  { icon: LayoutGrid, title: 'Grille équitable', text: 'Tout le monde à la même taille, dans une disposition recalculée selon l\'espace disponible — jusque sur téléphone en portrait.' },
  { icon: Hand, title: 'Lever la main', text: 'Un geste visible sur la tuile et dans la liste des participants, les mains levées remontant en tête pour l\'hôte.' },
];

const SECURITY_POINTS = [
  'Flux audio et vidéo chiffrés par DTLS-SRTP, la norme de WebRTC.',
  'Serveur de média auto-hébergé : vos réunions ne transitent par aucun tiers.',
  'Aucune installation, aucune extension, aucun pisteur publicitaire.',
];

const SECURITY_STATS = [
  { value: 'DTLS-SRTP', label: 'Chiffrement des flux' },
  { value: 'Europe', label: 'Hébergement des serveurs' },
  { value: '0', label: 'Logiciel à installer' },
];

const PLANS = [
  {
    name: 'Gratuit',
    price: '0 €',
    period: 'pour toujours',
    featured: true,
    cta: 'Créer mon compte',
    lines: [
      'Réunions et durée illimitées',
      'Salle d\'attente et modération',
      'Partage d\'écran et discussion',
      'Réactions et lever de main',
    ],
  },
  {
    name: 'Équipe',
    price: 'Bientôt',
    period: 'en préparation',
    featured: false,
    cta: 'Être prévenu',
    lines: [
      'Compte-rendu rédigé par l\'IA',
      'Enregistrement des réunions',
      'Espaces et contacts partagés',
      'Administration centralisée',
    ],
  },
];

const CROWD = ['Ada Lovelace', 'Marc Dupont', 'Amina Diallo', 'Théo Martin'];

function Logo() {
  return (
    <span className="w-8 h-8 rounded-md bg-brand-500 flex items-center justify-center text-surface flex-none">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M22 8.6a1 1 0 0 0-1.5-.9L17 9.8V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.8l3.5 2.1a1 1 0 0 0 1.5-.9V8.6Z" />
      </svg>
    </span>
  );
}

/** Aperçu de l'interface de réunion, construit en HTML avec les tokens du
 *  projet plutôt qu'en image : toujours net, et rien à maintenir en binaire. */
function AppPreview() {
  const tiles = ['Marc Dupont', 'Amina Diallo', 'Théo Martin'];
  return (
    <div className="absolute inset-0 p-4 sm:p-7 flex flex-col gap-3">
      <div className="flex-none flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-brand-500" />
        <span className="text-white/90 text-[13px] font-semibold">Point d&apos;équipe hebdo</span>
        <span className="font-mono text-[11px] text-white/45 border border-white/15 rounded px-2 py-0.5">XKR-42D</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] font-bold text-success-500">
          <span className="w-1.5 h-1.5 rounded-full bg-success-500" /> EN DIRECT
        </span>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-2 grid-rows-2 gap-3">
        {['Ada Lovelace', ...tiles].map((name, index) => {
          const color = avatarColorFor(name);
          return (
            <div
              key={name}
              className="relative rounded-lg overflow-hidden bg-white/[0.05] border border-white/10 flex items-center justify-center"
            >
              <span
                className="w-12 h-12 sm:w-16 sm:h-16 rounded-full flex items-center justify-center font-mono font-bold text-sm sm:text-lg"
                style={{ background: color.bg, color: color.fg }}
              >
                {initialsOf(name)}
              </span>
              <span className="absolute left-2.5 bottom-2 text-[11px] text-white/85">{name}</span>
              {index === 0 && (
                <span className="absolute inset-0 rounded-lg border-2 border-success-500 pointer-events-none" />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-none flex items-center justify-center gap-2.5">
        {[Link2, MonitorUp, MessagesSquare, Hand].map((Icon, i) => (
          <span key={i} className="w-9 h-9 rounded-full bg-white/[0.08] flex items-center justify-center text-white/70">
            <Icon className="h-4 w-4" />
          </span>
        ))}
        <span className="h-9 px-4 rounded-full bg-error-500 text-white text-[12px] font-semibold flex items-center">
          Quitter
        </span>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState('');

  const handleJoin = (event) => {
    event?.preventDefault();
    const code = parseMeetingCode(joinInput);
    if (!code) {
      setJoinError('Entrez un code de réunion ou collez le lien reçu.');
      return;
    }
    router.push(`/room/${code}`);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      {/* ---- En-tête collant ---- */}
      <header className="sticky top-0 z-20 bg-white/[0.72] backdrop-blur-xl backdrop-saturate-150 border-b border-slate-200">
        <div className="max-w-[1280px] mx-auto px-6 h-[68px] flex items-center gap-8">
          <Link href="#top" className="flex items-center gap-2.5 text-slate-950">
            <Logo />
            <span className="font-display font-bold text-[18px] tracking-heading">Stark Meet</span>
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-[14px] text-slate-700">
            <a href="#fonctionnalites" className="hover:text-slate-950 transition-colors">Fonctionnalités</a>
            <a href="#securite" className="hover:text-slate-950 transition-colors">Sécurité</a>
            <a href="#tarifs" className="hover:text-slate-950 transition-colors">Tarifs</a>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/auth"
              className="h-8 px-3 hidden sm:flex items-center rounded-sm text-[14px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
            >
              Se connecter
            </Link>
            <a
              href="#inscription"
              className="h-8 px-4 flex items-center rounded-sm bg-brand-500 text-surface text-[14px] font-medium hover:bg-brand-600 transition-colors"
            >
              Créer un compte
            </a>
          </div>
        </div>
      </header>

      {/* ---- Hero + inscription ---- */}
      <section id="top" className="relative overflow-hidden">
        <div className="hero-dots absolute inset-0 pointer-events-none" />

        <div className="relative max-w-[1280px] mx-auto px-6 pt-14 pb-16 lg:pt-20 grid lg:grid-cols-[1.05fr_.95fr] gap-10 lg:gap-16 items-center">
          <div>
            <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500 mb-5">
              Visioconférence d&apos;équipe
            </p>
            <h1 className="font-display font-bold text-[40px] sm:text-[52px] lg:text-[60px] leading-[1.04] tracking-display mb-5">
              Vos réunions, sans friction.
            </h1>
            <p className="text-[17px] sm:text-[18px] leading-relaxed text-slate-700 max-w-[520px] mb-8">
              Lancez un appel en un lien, partagez votre écran, discutez et modérez. Stark Meet
              fonctionne directement dans le navigateur, sans installation.
            </p>

            <div className="flex items-center gap-6 flex-wrap">
              <a
                href="#inscription"
                className="h-11 px-6 flex items-center rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 hover:shadow-brand-glow transition duration-200 ease-standard"
              >
                Commencer gratuitement
              </a>
              <a href="#fonctionnalites" className="inline-flex items-center gap-2 text-[15px] font-medium text-brand-500 hover:text-brand-600">
                Voir ce qu&apos;on peut faire
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>

            {/* Rejoindre par code — accepte aussi un lien collé. */}
            <form onSubmit={handleJoin} className="mt-8 max-w-[520px]">
              <p className="text-[13px] font-medium text-slate-700 mb-2.5">
                Vous avez déjà un code ? Rejoignez une réunion.
              </p>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={joinInput}
                  onChange={(e) => { setJoinInput(e.target.value); setJoinError(''); }}
                  placeholder="Code ou lien de réunion"
                  aria-label="Code ou lien de réunion"
                  className={`flex-1 min-w-0 h-11 px-3.5 rounded-sm border bg-surface text-[15px] placeholder:text-slate-500 outline-none transition-shadow duration-200 focus:shadow-focus ${
                    joinError ? 'border-error-500' : 'border-slate-200 focus:border-brand-500'
                  }`}
                />
                <button
                  type="submit"
                  className="h-11 px-5 flex-none rounded-sm border border-slate-200 bg-surface text-[15px] font-semibold text-slate-950 hover:bg-slate-100 transition-colors"
                >
                  Rejoindre
                </button>
              </div>
              {joinError && <p className="mt-2.5 text-[13px] text-error-500">{joinError}</p>}
            </form>

            <div className="mt-10 flex items-center gap-3.5">
              <div className="flex">
                {CROWD.map((name) => {
                  const color = avatarColorFor(name);
                  return (
                    <span
                      key={name}
                      className="-mr-2 w-8 h-8 rounded-full border-2 border-slate-50 flex items-center justify-center font-mono text-[10px] font-bold"
                      style={{ background: color.bg, color: color.fg }}
                      title={name}
                    >
                      {initialsOf(name)}
                    </span>
                  );
                })}
              </div>
              <p className="ml-2 text-[14px] text-slate-700">
                Votre équipe se réunit en un lien, sans rien installer.
              </p>
            </div>
          </div>

          <div id="inscription" className="scroll-mt-24">
            <AuthForm defaultMode="signup" />
          </div>
        </div>
      </section>

      {/* ---- Aperçu de l'application ---- */}
      <section className="max-w-[1280px] mx-auto px-6 pb-20">
        <div className="relative border border-slate-200 rounded-lg overflow-hidden bg-[#15161A] h-[360px] sm:h-[460px] lg:h-[520px]">
          <AppPreview />
        </div>
      </section>

      {/* ---- Fonctionnalités ---- */}
      <section id="fonctionnalites" className="border-t border-slate-200 bg-surface scroll-mt-[68px]">
        <div className="max-w-[1280px] mx-auto px-6 py-16 lg:py-20">
          <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500 mb-3">
            Fonctionnalités
          </p>
          <h2 className="font-display font-bold text-[30px] sm:text-[40px] leading-tight tracking-heading max-w-[600px] mb-12">
            Tout ce qu&apos;il faut pour une réunion, rien de plus.
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="border border-slate-200 rounded-lg p-6 transition-shadow duration-200 ease-standard hover:shadow-card-hover"
              >
                <span className="w-10 h-10 rounded-md bg-brand-50 text-brand-500 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="font-display font-semibold text-[17px] tracking-heading mb-2">{title}</h3>
                <p className="text-[14px] leading-relaxed text-slate-700">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Sécurité ---- */}
      <section id="securite" className="border-t border-slate-200 scroll-mt-[68px]">
        <div className="max-w-[1280px] mx-auto px-6 py-16 lg:py-20 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div>
            <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500 mb-3">
              Sécurité
            </p>
            <h2 className="font-display font-bold text-[30px] sm:text-[40px] leading-tight tracking-heading mb-6">
              Chiffré de bout en bout, hébergé en Europe.
            </h2>
            <ul className="flex flex-col gap-3.5">
              {SECURITY_POINTS.map((point) => (
                <li key={point} className="flex items-start gap-3 text-[15px] leading-relaxed text-slate-700">
                  <span className="mt-0.5 w-5 h-5 rounded-full bg-success-50 text-success-500 flex items-center justify-center flex-none">
                    <Check className="h-3 w-3" />
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            {SECURITY_STATS.map(({ value, label }, index) => {
              const Icon = [Lock, Globe2, Server][index];
              return (
                <div key={label} className="bg-surface border border-slate-200 rounded-lg p-5">
                  <Icon className="h-4 w-4 text-slate-500 mb-3" />
                  <p className="font-display font-bold text-[20px] tracking-heading">{value}</p>
                  <p className="text-[13px] text-slate-700 mt-1">{label}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---- Tarifs ---- */}
      <section id="tarifs" className="border-t border-slate-200 bg-surface scroll-mt-[68px]">
        <div className="max-w-[1280px] mx-auto px-6 py-16 lg:py-20">
          <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500 mb-3">
            Tarifs
          </p>
          <h2 className="font-display font-bold text-[30px] sm:text-[40px] leading-tight tracking-heading mb-12">
            Deux plans, c&apos;est tout.
          </h2>

          <div className="grid sm:grid-cols-2 gap-6 max-w-[820px]">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-lg p-7 border ${
                  plan.featured ? 'border-brand-500 shadow-card-hover' : 'border-slate-200'
                }`}
              >
                {plan.featured && (
                  <span className="absolute top-5 right-5 font-mono text-[10px] font-bold tracking-overline uppercase text-brand-500 bg-brand-50 rounded-xs px-2 py-1">
                    Populaire
                  </span>
                )}
                <h3 className="font-display font-semibold text-[18px] tracking-heading">{plan.name}</h3>
                <p className="mt-4 flex items-baseline gap-2">
                  <span className="font-display font-bold text-[36px] tracking-display">{plan.price}</span>
                  <span className="text-[14px] text-slate-500">{plan.period}</span>
                </p>

                <ul className="mt-6 flex flex-col gap-3">
                  {plan.lines.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-[14px] text-slate-700">
                      <Check className="mt-0.5 h-4 w-4 text-brand-500 flex-none" />
                      {line}
                    </li>
                  ))}
                </ul>

                <a
                  href="#inscription"
                  className={`mt-7 h-11 w-full flex items-center justify-center rounded-sm text-[15px] font-semibold transition-colors ${
                    plan.featured
                      ? 'bg-brand-500 text-surface hover:bg-brand-600'
                      : 'border border-slate-200 text-slate-950 hover:bg-slate-100'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Appel à l'action final ---- */}
      <section className="border-t border-slate-200">
        <div className="max-w-[1280px] mx-auto px-6 py-16 lg:py-20 text-center">
          <h2 className="font-display font-bold text-[28px] sm:text-[36px] tracking-heading mb-6">
            Votre première réunion dans une minute.
          </h2>
          <a
            href="#inscription"
            className="inline-flex h-11 px-6 items-center rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 hover:shadow-brand-glow transition duration-200 ease-standard"
          >
            Créer mon compte
          </a>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-surface">
        <div className="max-w-[1280px] mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="font-display font-bold text-[15px] tracking-heading">Stark Meet</span>
          </div>
          <p className="text-[13px] text-slate-500">
            Visioconférence auto-hébergée · {new Date().getFullYear()}
          </p>
        </div>
      </footer>
    </div>
  );
}
