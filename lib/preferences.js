/**
 * Préférences utilisateur, stockées dans `profiles.preferences` (JSONB).
 *
 * Les valeurs par défaut vivent ici et non dans un composant : le tableau de
 * bord les affiche, mais c'est le lobby de la réunion qui les applique. Deux
 * jeux de valeurs par défaut divergents produiraient des réglages qui semblent
 * enregistrés sans avoir d'effet.
 */

import { detectTimeZone } from './datetime';

export const DEFAULT_PREFERENCES = {
  waitingRoomDefault: true,  // salle d'attente activée à la création
  muteOnJoin: false,         // arriver micro coupé
  cameraOffOnJoin: false,    // arriver caméra coupée
  lockOnStart: false,        // verrouiller la salle dès le démarrage
  timeZone: null,            // null => fuseau du navigateur
};

/** Fusionne ce qui est stocké avec les valeurs par défaut. */
export function withDefaults(preferences) {
  const merged = { ...DEFAULT_PREFERENCES, ...(preferences || {}) };
  return { ...merged, timeZone: merged.timeZone || detectTimeZone() };
}

/** Libellés et explications des interrupteurs, dans l'ordre d'affichage. */
export const TOGGLES = [
  {
    key: 'waitingRoomDefault',
    label: 'Salle d\'attente par défaut',
    help: 'Les nouvelles réunions demandent votre accord avant de laisser entrer quelqu\'un.',
  },
  {
    key: 'muteOnJoin',
    label: 'Arriver micro coupé',
    help: 'Utile quand plusieurs personnes sont dans la même pièce : c\'est ce qui évite l\'effet larsen.',
  },
  {
    key: 'cameraOffOnJoin',
    label: 'Arriver caméra coupée',
    help: 'Vous rejoignez sans être vu, et activez la caméra quand vous êtes prêt.',
  },
  {
    key: 'lockOnStart',
    label: 'Verrouiller dès le démarrage',
    help: 'Plus personne ne peut entrer après vous, même avec le lien.',
  },
];
