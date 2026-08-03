'use client';

import { useState } from 'react';
import { X, Mic, MicOff, UserX } from 'lucide-react';

/**
 * Panneau participants — combine la salle d'attente (si l'hôte doit
 * admettre/refuser) et la liste des participants déjà dans la réunion,
 * avec les actions de modération réservées à l'hôte.
 */
export default function ParticipantsList({
  onClose,
  participants,
  waitingParticipants,
  isHost,
  onAdmit,
  onDeny,
  onForceMute,
  onRemove,
}) {
  const admitted = participants || [];
  const waiting = waitingParticipants || [];

  // Retour visuel immédiat : la mise à jour Realtime peut prendre une
  // seconde à revenir, sans ça le bouton semble ne rien faire.
  const [processingIds, setProcessingIds] = useState(new Set());

  const runAction = async (id, action) => {
    setProcessingIds(prev => new Set(prev).add(id));
    try {
      await action?.(id);
    } catch (err) {
      console.error('Erreur action participant:', err);
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="absolute right-4 top-4 bottom-20 w-80 bg-ink-900 rounded-lg shadow-2xl border border-ink-700 flex flex-col z-50">
      <div className="flex items-center justify-between p-4 border-b border-ink-700">
        <div>
          <h3 className="text-white font-semibold">Participants</h3>
          <p className="text-ink-500 text-sm font-mono">{admitted.length} dans la réunion</p>
        </div>
        <button className="p-2 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors" onClick={onClose}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {isHost && waiting.length > 0 && (
          <div className="p-4 border-b border-ink-700">
            <p className="font-mono text-[11px] tracking-wide uppercase text-amber-500 mb-3">
              En attente d'admission · {waiting.length}
            </p>
            <div className="space-y-2">
              {waiting.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-ink-700 flex items-center justify-center flex-shrink-0 font-mono text-xs font-bold text-white">
                    {(p.display_name || '?').slice(0, 2).toUpperCase()}
                  </div>
                  <p className="flex-1 text-sm text-white truncate">{p.display_name}</p>
                  <button
                    onClick={() => runAction(p.id, onAdmit)}
                    disabled={processingIds.has(p.id)}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded bg-ok-500 text-ink-950 hover:brightness-110 transition disabled:opacity-50"
                  >
                    {processingIds.has(p.id) ? '…' : 'Admettre'}
                  </button>
                  <button
                    onClick={() => runAction(p.id, onDeny)}
                    disabled={processingIds.has(p.id)}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded bg-ink-800 text-ink-500 hover:text-white transition disabled:opacity-50"
                  >
                    Refuser
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="p-2">
          {admitted.map((p) => (
            <div key={p.id} className="flex items-center justify-between p-2.5 rounded-lg hover:bg-ink-800 transition-colors group">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-full bg-ink-700 flex items-center justify-center flex-shrink-0 font-mono text-xs font-bold text-white">
                  {(p.display_name || '?').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-medium truncate">{p.display_name}</p>
                    {(p.role === 'host' || p.role === 'co-host') && (
                      <span className="text-[10px] font-mono uppercase bg-signal-500/15 text-signal-300 px-1.5 py-0.5 rounded">
                        {p.role === 'host' ? 'Hôte' : 'Co-hôte'}
                      </span>
                    )}
                  </div>
                  {p.force_muted && <p className="text-ink-500 text-xs mt-0.5">Micro coupé par l'hôte</p>}
                </div>
              </div>

              {isHost && p.role !== 'host' && (
                <div className="flex items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onForceMute?.(p.id)}
                    className="h-7 w-7 text-ink-500 hover:text-white hover:bg-ink-700 rounded-md flex items-center justify-center"
                    title={p.force_muted ? 'Réautoriser le micro' : 'Couper le micro'}
                  >
                    {p.force_muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove?.(p.id)}
                    className="h-7 w-7 text-ink-500 hover:text-signal-400 hover:bg-ink-700 rounded-md flex items-center justify-center"
                    title="Exclure de la réunion"
                  >
                    <UserX className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
