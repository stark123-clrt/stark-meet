/**
 * Horaire d'une réunion : quand elle est censée finir, et si c'est fait.
 *
 * Cette logique est partagée par le tableau de bord (classer À venir /
 * Historique) et par l'écran de fin d'appel (distinguer « vous avez quitté »
 * de « l'appel est terminé »). La dupliquer produirait tôt ou tard deux
 * verdicts contradictoires sur la même réunion.
 */

/**
 * Fin prévue, déduite de `scheduled_at` + `duration_minutes`.
 * @returns {Date|null} null pour une réunion instantanée, qui n'a pas de fin
 *   programmée — elle se termine quand la salle se vide.
 */
export function meetingEndsAt(meeting) {
  if (!meeting?.scheduled_at) return null;

  const start = new Date(meeting.scheduled_at).getTime();
  const minutes = Number(meeting.duration_minutes) || 60;
  return new Date(start + minutes * 60000);
}

/** Vrai si l'heure de fin prévue est dépassée. Faux pour une instantanée. */
export function isPastScheduledEnd(meeting, now = Date.now()) {
  const end = meetingEndsAt(meeting);
  return !!end && now >= end.getTime();
}

/**
 * Une réunion est-elle définitivement close ?
 *
 * Règle calquée sur Teams :
 *  - **planifiée** : elle reste ouverte jusqu'à son heure de fin, même quand
 *    tout le monde est parti. Quitter avant l'heure, c'est quitter, pas
 *    terminer — les autres peuvent revenir.
 *  - **instantanée** : elle n'a pas d'horaire, donc elle se termine dès que la
 *    dernière personne s'en va.
 *
 * @param {object} meeting
 * @param {boolean} wasLastParticipant  la personne qui part était seule
 */
export function shouldCompleteMeeting(meeting, wasLastParticipant, now = Date.now()) {
  if (!wasLastParticipant) return false;
  if (meeting?.status === 'completed' || meeting?.status === 'cancelled') return false;

  // Sans horaire : la salle vide suffit.
  if (!meeting?.scheduled_at) return true;

  return isPastScheduledEnd(meeting, now);
}

/** Formate la plage horaire : « 11:00 — 12:00 ». */
export function formatTimeRange(meeting, timeZone) {
  if (!meeting?.scheduled_at) return null;

  const options = { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) };
  const start = new Date(meeting.scheduled_at).toLocaleTimeString('fr-FR', options);
  const end = meetingEndsAt(meeting)?.toLocaleTimeString('fr-FR', options);

  return end ? `${start} — ${end}` : start;
}
