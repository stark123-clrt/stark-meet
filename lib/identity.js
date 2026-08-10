/**
 * Identité visuelle d'une personne : initiales et couleur d'avatar.
 *
 * Ces deux fonctions existaient en quatre exemplaires dans le projet, dont
 * deux versions naïves (`nom.slice(0, 2)`) qui affichaient « CH » pour
 * « Christian Ondiyo » au lieu de « CO ». Source unique désormais.
 */

/**
 * Initiales d'un nom : première lettre du prénom + première lettre du nom de
 * famille. Sur un nom simple, on retombe sur les deux premières lettres.
 *
 *   'Christian Ondiyo'      -> 'CO'
 *   'Christian Jean Ondiyo' -> 'CO'   (prénom + dernier mot)
 *   'Christian'             -> 'CH'
 *   ''                      -> '?'
 */
export function initialsOf(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return trimmed.substring(0, 2).toUpperCase();
}

// Teintes d'avatar : assez saturées pour se détacher d'une surface claire, assez
// sourdes pour ne pas concurrencer l'accent bleu de l'interface.
const AVATAR_COLORS = [
  { bg: '#4c3a6b', fg: '#d9ccf2' },
  { bg: '#1f5b53', fg: '#a8ecdd' },
  { bg: '#5c3a22', fg: '#f2d2b8' },
  { bg: '#24405f', fg: '#bcd9f2' },
  { bg: '#5a2f42', fg: '#f2c3d4' },
  { bg: '#3d4a24', fg: '#d9e8b8' },
];

/**
 * Couleur d'avatar stable pour une personne donnée. Déterministe : la même
 * graine (id ou nom) donne toujours la même couleur, sur tous les postes et
 * après un rechargement, sans rien stocker.
 */
export function avatarColorFor(seed) {
  const key = String(seed || '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
