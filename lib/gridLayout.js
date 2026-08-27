/**
 * Calcul de la meilleure grille pour N tuiles dans un espace donné.
 *
 * Aucune disposition n'est écrite en dur (« 4 personnes → 2 colonnes ») : on
 * évalue chaque nombre de colonnes possible et on retient celui qui donne les
 * plus grandes tuiles. Le même code gère donc 3 participants sur un grand
 * écran et 12 sur un téléphone en portrait, et se recalcule à chaque
 * redimensionnement.
 *
 * Les tuiles ne gardent PAS un format fixe : elles prennent la forme de la
 * place qu'on leur donne, dans des limites raisonnables. Un format imposé ne
 * remplit jamais un conteneur qui n'a pas cette forme — deux participants sur
 * un téléphone en portrait laissaient ainsi la moitié de la largeur vide. La
 * vidéo étant affichée en `object-cover`, elle recadre proprement : sur un
 * visage on ne perd rien d'utile, et on gagne toute la surface.
 */

// Bornes du format d'une tuile. Elles n'existent que pour éviter les cas
// extrêmes : un seul participant sur un écran très large donnerait sinon une
// meurtrière de 3 pour 1, qui rognerait le haut et le bas de son visage.
const MIN_RATIO = 3 / 4;
const MAX_RATIO = 16 / 9;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {number} count        nombre de tuiles à placer
 * @param {number} width        largeur disponible en px
 * @param {number} height       hauteur disponible en px
 * @param {number} [aspectRatio] format imposé ; par défaut la tuile épouse sa case
 * @param {number} gap          espace entre tuiles en px
 * @returns {{cols, rows, tileWidth, tileHeight}|null}
 */
export function bestGridLayout({ count, width, height, aspectRatio, gap = 12 }) {
  if (!count || count < 1 || width <= 0 || height <= 0) return null;

  let best = null;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);

    // Espace réellement disponible par tuile, une fois les gouttières retirées.
    const availableWidth = (width - gap * (cols - 1)) / cols;
    const availableHeight = (height - gap * (rows - 1)) / rows;
    if (availableWidth <= 0 || availableHeight <= 0) continue;

    // Le format visé est celui de la case elle-même : c'est ce qui la remplit
    // entièrement. Les bornes ne mordent que sur les cases très allongées.
    const ratio = aspectRatio || clamp(availableWidth / availableHeight, MIN_RATIO, MAX_RATIO);

    // La tuile est bridée par la largeur OU par la hauteur : on garde la
    // contrainte la plus serrée pour préserver le format.
    let tileWidth = availableWidth;
    let tileHeight = tileWidth / ratio;
    if (tileHeight > availableHeight) {
      tileHeight = availableHeight;
      tileWidth = tileHeight * ratio;
    }

    const area = tileWidth * tileHeight;
    if (!best || area > best.area) {
      best = { cols, rows, tileWidth, tileHeight, area };
    }
  }

  if (!best) return null;

  return {
    cols: best.cols,
    rows: best.rows,
    tileWidth: Math.floor(best.tileWidth),
    tileHeight: Math.floor(best.tileHeight),
  };
}
