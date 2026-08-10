/**
 * Formatage des dates et durées du tableau de bord.
 *
 * Toutes les fonctions acceptent un fuseau horaire : c'est le réglage choisi
 * dans les préférences, et il doit s'appliquer partout de la même façon —
 * sinon un même horaire s'afficherait différemment d'un écran à l'autre.
 */

/** Le fuseau du navigateur, valeur de repli quand rien n'est configuré. */
export function detectTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
  } catch {
    return 'Europe/Paris';
  }
}

const options = (timeZone, extra) => ({ ...extra, ...(timeZone ? { timeZone } : {}) });

/** « 12 juin 2026, 11:00 » */
export function formatDateTime(iso, timeZone) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', options(timeZone, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }));
}

/** « 11:00 » */
export function formatTime(iso, timeZone) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', options(timeZone, {
    hour: '2-digit', minute: '2-digit',
  }));
}

/** « 12/06/2026 » */
export function formatShortDate(iso, timeZone) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', options(timeZone, {
    day: '2-digit', month: '2-digit', year: 'numeric',
  }));
}

/** Pastille de date des cartes « À venir » : { month: 'JUIN', day: '12' } */
export function formatDayBadge(iso, timeZone) {
  const date = iso ? new Date(iso) : new Date();
  return {
    month: date.toLocaleDateString('fr-FR', options(timeZone, { month: 'short' }))
      .replace('.', '')
      .toUpperCase(),
    day: date.toLocaleDateString('fr-FR', options(timeZone, { day: 'numeric' })),
  };
}

/** « 1 h 04 » ou « 12 min ». Renvoie '—' si la durée n'est pas connue. */
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';

  const totalMinutes = Math.max(1, Math.round(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${minutes} min`;
}

/**
 * Durée réellement écoulée d'une réunion, déduite des présences : du premier
 * arrivé au dernier parti. La colonne `duration_minutes` n'est qu'une durée
 * *prévue* à la création, elle ne dit pas ce qui s'est passé.
 */
export function meetingDuration(participants) {
  const starts = (participants || []).map((p) => p.joined_at).filter(Boolean).map((d) => new Date(d).getTime());
  const ends = (participants || []).map((p) => p.left_at).filter(Boolean).map((d) => new Date(d).getTime());
  if (starts.length === 0 || ends.length === 0) return null;

  return Math.max(...ends) - Math.min(...starts);
}
