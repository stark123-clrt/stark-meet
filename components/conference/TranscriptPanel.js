'use client';

import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { initialsOf } from '@/lib/identity';

/**
 * Transcription en direct, sur deux niveaux de certitude.
 *
 * C'est le point important pour la lecture : Whisper réanalyse en continu, donc
 * son texte change encore quelques secondes après avoir été produit. Tout
 * afficher du même noir donnerait l'impression que le transcript se corrige
 * tout seul de façon erratique. On distingue donc :
 *
 *   · en NOIR ce que deux passes consécutives ont confirmé — définitif ;
 *   · en GRIS ITALIQUE l'hypothèse en cours — susceptible de changer.
 *
 * L'hypothèse d'un locuteur reste sous ses phrases confirmées, jamais au
 * milieu : la lecture doit rester chronologique.
 */
export default function TranscriptPanel({ finals, partials, className = '' }) {
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);

  // Défilement automatique, sauf si l'utilisateur a remonté pour relire : lui
  // arracher sa position à chaque nouvelle phrase rendrait la relecture
  // impossible pendant qu'on parle.
  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [finals, partials]);

  const isEmpty = finals.length === 0 && partials.length === 0;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={`overflow-y-auto scrollbar-hide px-4 py-3 ${className}`}
    >
      {isEmpty ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <Loader2 className="h-4 w-4 text-slate-400 animate-spin" />
          <p className="text-[12.5px] text-slate-500">En écoute…</p>
          <p className="text-[11.5px] text-slate-400 max-w-[220px]">
            Le texte apparaît quelques secondes après la parole, le temps de le confirmer.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {finals.map((segment) => (
            <Line key={segment.id} segment={segment} />
          ))}
          {partials.map((segment) => (
            <Line key={segment.id} segment={segment} tentative />
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ segment, tentative = false }) {
  return (
    <div className="flex gap-2.5">
      <span
        className="flex-none w-7 h-7 rounded-full bg-slate-100 text-slate-500 font-mono text-[10px] font-bold flex items-center justify-center"
        title={segment.displayName}
      >
        {initialsOf(segment.displayName)}
      </span>
      <div className="min-w-0 flex-1">
        <span className="block font-mono text-[9.5px] font-bold tracking-overline uppercase text-slate-500">
          {segment.displayName}
        </span>
        <p
          className={`text-[13px] leading-[1.55] ${
            tentative ? 'text-slate-400 italic' : 'text-slate-950'
          }`}
        >
          {segment.text}
        </p>
      </div>
    </div>
  );
}
