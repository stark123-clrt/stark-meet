'use client';

import Link from 'next/link';
import { PhoneOff, Clock, Users, MessagesSquare } from 'lucide-react';
import { formatDuration } from '@/lib/datetime';

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="flex-1 bg-surface border border-slate-200 rounded-lg p-5 text-center">
      <Icon className="h-4 w-4 text-slate-500 mx-auto mb-2.5" />
      <p className="font-display font-bold text-[22px] tracking-heading tabular-nums">{value}</p>
      <p className="mt-1 text-[12.5px] text-slate-700">{label}</p>
    </div>
  );
}

/**
 * Écran de fin d'appel.
 *
 * Le template annonce ici un compte-rendu et un enregistrement disponibles sous
 * 24 heures. Ni l'un ni l'autre n'existe : on affiche les chiffres réels de la
 * réunion plutôt qu'une promesse que rien ne tiendra.
 */
export default function EndScreen({ meeting, stats, isHost, onRejoin }) {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-[560px] text-center">
        <span className="w-14 h-14 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center mx-auto mb-6">
          <PhoneOff className="h-6 w-6" />
        </span>

        <h1 className="font-display font-bold text-[28px] tracking-heading">Appel terminé</h1>
        <p className="mt-2 text-[15px] text-slate-700">{meeting?.title || 'Réunion'}</p>

        <div className="mt-8 flex gap-4">
          <Stat icon={Clock} label="Durée" value={formatDuration(stats?.durationMs)} />
          <Stat icon={Users} label="Participants" value={stats?.participants ?? '—'} />
          <Stat icon={MessagesSquare} label="Messages" value={stats?.messages ?? '—'} />
        </div>

        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <button
            onClick={onRejoin}
            className="flex-1 h-11 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 transition-colors"
          >
            Rejoindre à nouveau
          </button>
          <Link
            href={isHost ? '/dashboard' : '/'}
            className="flex-1 h-11 flex items-center justify-center rounded-sm border border-slate-200 bg-surface text-[15px] font-medium text-slate-950 hover:bg-slate-100 transition-colors"
          >
            {isHost ? 'Retour à mon espace' : 'Retour à l\'accueil'}
          </Link>
        </div>

        <p className="mt-6 text-[12.5px] leading-relaxed text-slate-500">
          Le compte-rendu automatique et l&apos;enregistrement arriveront avec le plan Équipe.
        </p>
      </div>
    </div>
  );
}
