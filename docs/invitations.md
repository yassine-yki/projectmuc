# Inscription uniquement sur invitation

## Mise en service

1. Appliquer les migrations précédentes jusqu’à `0009`, puis `0010_invitation_accounts.sql` et `0011_finalize_invitations_outside_auth_trigger.sql` dans Supabase SQL Editor.
2. Déployer `supabase/functions/accept-invitation/index.ts` sous le nom `accept-invitation`. Avec la CLI Supabase connectée :

   `supabase functions deploy accept-invitation --project-ref pxfsughdqhgzgbtlpsyv --no-verify-jwt`

   Cette fonction est publique car l’invité n’a pas de compte. Elle exige le jeton secret d’invitation. La fonction SQL `complete_account_invitation` crée ensuite le profil, rattache le membre et consomme le lien dans une même transaction. Si cette transaction échoue, la fonction Edge supprime le compte Auth incomplet et laisse l’invitation disponible. `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont les variables serveur Supabase. Ne jamais mettre la clé service dans Vite/Vercel côté client.
3. Dans Auth, désactiver les nouvelles inscriptions publiques (« Allow new users to sign up »). Cette option est obligatoire : les créations légitimes passent par la fonction Edge avec la clé serveur.
4. Publier l’interface sur Vercel. Tester avec une invitation Lecture seule, puis vérifier qu’une deuxième création avec le même lien échoue.

Après une modification de la règle de mot de passe, republier **les deux parties** : le site sur Vercel et la fonction `accept-invitation` sur Supabase. Publier le site d’abord, puis redéployer la fonction ; pendant cet intervalle, l’ancien minimum reste appliqué à la création des comptes.

## Utilisation

Équipe → Inviter une personne → rôle → Créer un lien → Copier. Chaque lien expire après 48 heures et permet un seul compte. Les autres invitations restent valides ; Révoquer permet d’annuler un lien non utilisé. Le jeton brut n’est affiché qu’à sa création, et n’est stocké ni dans la table ni dans les métadonnées Auth. Le fragment d’URL est retiré à l’ouverture de la page : en cas de rechargement avant inscription, rouvrir le lien initial.

L’invité choisit un nom unique de 3 à 32 caractères (lettres non accentuées, chiffres, point, tiret, underscore) et un mot de passe de 3 caractères minimum, sans autre règle de composition. Il se connecte ensuite avec ces identifiants. L’application dérive un identifiant de mot de passe compatible avec Supabase Auth, dont le minimum interne est de six caractères ; les comptes créés auparavant continuent de fonctionner avec leur mot de passe habituel.

Supabase utilise en interne `nom@users.pistache.invalid` comme identifiant technique ; aucun e-mail réel n’est demandé ni envoyé. Il n’y a donc pas de récupération de mot de passe par e-mail pour ces nouveaux comptes. L’administration doit gérer une éventuelle réinitialisation par une procédure distincte ; elle n’est pas ajoutée ici.

Le lien est un secret transmissible : une personne qui le reçoit avant sa consommation peut l’utiliser. L’usage unique empêche sa réutilisation, pas son transfert préalable. Pas de suppression ou modification des comptes existants lors de la migration.

## Vérification

`pnpm test` couvre l’interface et la fonction Edge avec le client Auth simulé ; `pnpm run test:database` vérifie les droits, la consommation transactionnelle et le refus des liens réutilisés ou révoqués. Le déploiement Edge réel reste à tester dans Supabase.
