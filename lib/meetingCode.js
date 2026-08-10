// Génère un code de réunion lisible et non-ambigu (pas de 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateMeetingCode() {
  const part = () =>
    Array.from({ length: 3 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `${part()}-${part()}`;
}

/**
 * Extrait un code de réunion de ce que l'utilisateur a saisi. Le champ
 * « Rejoindre » accepte indifféremment un code (`ABC-DEF`) ou un lien complet
 * collé depuis une invitation — c'est le geste le plus naturel, et exiger le
 * code seul serait une source d'échec inutile.
 *
 * @returns {string|null} le code normalisé en majuscules, ou null si absent
 */
export function parseMeetingCode(input) {
  const raw = (input || '').trim();
  if (!raw) return null;

  // Lien complet : on ne garde que le dernier segment de chemin.
  const withoutQuery = raw.split(/[?#]/)[0];
  const last = withoutQuery.replace(/\/+$/, '').split('/').pop() || '';

  const candidate = last.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return candidate.length >= 3 ? candidate : null;
}
