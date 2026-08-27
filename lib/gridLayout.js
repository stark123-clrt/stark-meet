/**
 * Calcul de la meilleure grille pour N tuiles dans un espace donné.
 *
 * Aucune disposition n'est écrite en dur (« 4 personnes → 2 colonnes ») : on
 * évalue chaque nombre de colonnes possible et on retient celui qui donne les
 * plus grandes tuiles. Le même code gère donc 3 participants sur un grand
 * écran et 12 sur un téléphone en portrait, et se recalcule à chaque
 * redimensionnement.
 */

/**
 * @param {number} count        nombre de tuiles à placer
 * @param {number} width        largeur disponible en px
 * @param {number} height       hauteur disponible en px
 * @param {number} [aspectRatio]  format des tuiles ; deduit de l'orientation
 *                                du conteneur s'il n'est pas fourni
 * @param {number} gap          espace entre tuiles en px
 * @returns {{cols, rows, tileWidth, tileHeight}|null}
 */
export function bestGridLayout({ count, width, height, aspectRatio, gap = 12 }) {
  // Format par defaut deduit de l'espace disponible. Un 16/9 impose dans un
  // conteneur en portrait — un telephone tenu verticalement — donnait des
  // tuiles ecrasees, cernees de larges bandes vides : deux participants
  // occupaient deux minces bandeaux au milieu de l'ecran. Les applications
  // mobiles passent toutes en tuiles portrait dans ce cas.
  const ratio = aspectRatio || (height > width ? 3 / 4 : 16 / 9);
  if (!count || count < 1 || width <= 0 || height <= 0) return null;

  let best = null;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);

    // Espace réellement disponible par tuile, une fois les gouttières retirées.
    const availableWidth = (width - gap * (cols - 1)) / cols;
    const availableHeight = (height - gap * (rows - 1)) / rows;
    if (availableWidth <= 0 || availableHeight <= 0) continue;

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
