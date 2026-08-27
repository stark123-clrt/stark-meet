/**
 * Copie de texte dans le presse-papiers, avec repli.
 *
 * `navigator.clipboard` n'existe que dans un contexte sécurisé : en HTTP sur
 * le réseau local, dans certaines WebView ou sur un navigateur ancien, l'appel
 * levait une exception que personne n'attrapait. Le bouton « Copier » ne
 * faisait alors rien du tout — et ne le disait pas.
 *
 * On tente donc l'API moderne, puis la sélection d'un champ hors écran, et on
 * renvoie enfin un booléen honnête pour que l'appelant puisse afficher le lien
 * à copier à la main quand les deux échouent.
 *
 * @param {string} text
 * @returns {Promise<boolean>} vrai si le texte est réellement dans le presse-papiers
 */
export async function copyText(text) {
  if (!text || typeof document === 'undefined') return false;

  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refus de permission, document non focalisé… on tente quand même le repli.
  }

  return legacyCopy(text);
}

/**
 * Repli historique : un champ hors écran que l'on sélectionne avant
 * `execCommand('copy')`. Déprécié mais toujours implémenté partout, et c'est
 * le seul chemin disponible hors contexte sécurisé.
 */
function legacyCopy(text) {
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    // `readonly` empêche le clavier virtuel de surgir sur mobile ; un champ en
    // `display:none`, lui, ne serait pas sélectionnable du tout.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    // Safari iOS ignore `select()` sur un champ en lecture seule : il faut
    // poser une plage de sélection explicite sur le nœud.
    const range = document.createRange();
    range.selectNodeContents(area);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    area.setSelectionRange(0, text.length);

    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (area?.parentNode) area.parentNode.removeChild(area);
  }
}
