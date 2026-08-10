/**
 * Garantit qu'un utilisateur authentifié possède bien sa ligne `profiles`.
 *
 * Indispensable pour la connexion Google : GoTrue crée l'utilisateur dans
 * `auth.users`, mais rien d'autre. Or `meetings.host_id` porte une clé
 * étrangère vers `profiles` — sans cette ligne, un compte Google ne pourrait
 * créer aucune réunion, et son nom n'apparaîtrait nulle part dans
 * l'application.
 *
 * L'inscription par email crée déjà son profil explicitement ; cette fonction
 * couvre tous les autres chemins d'entrée, et reste sans effet si le profil
 * existe déjà.
 */

/**
 * Déduit un nom affichable des métadonnées du fournisseur d'identité. Google
 * renseigne `full_name` et `name` ; en dernier recours on retombe sur la
 * partie locale de l'adresse email, jamais sur une chaîne vide (la colonne
 * `full_name` est NOT NULL).
 */
function displayNameFrom(user) {
  const metadata = user.user_metadata || {};
  const candidate = metadata.full_name || metadata.name || metadata.user_name;
  if (candidate && String(candidate).trim()) return String(candidate).trim();

  const email = user.email || '';
  return email.split('@')[0] || 'Utilisateur';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} user  l'utilisateur renvoyé par supabase.auth
 * @returns {Promise<object|null>} le profil, ou null en cas d'échec
 */
export async function ensureProfile(supabase, user) {
  if (!user?.id) return null;

  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('profiles')
    .insert({
      id: user.id,
      email: user.email,
      full_name: displayNameFrom(user),
      avatar_url: user.user_metadata?.avatar_url || null,
    })
    .select()
    .single();

  if (error) {
    // Course possible entre deux onglets qui se connectent en même temps :
    // l'un des deux perd l'insertion, mais le profil existe bel et bien.
    console.error('Création du profil impossible:', error);
    const { data: retry } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    return retry || null;
  }

  return created;
}
