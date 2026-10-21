# Accès aux outils par membre

L'administrateur règle les outils dans **Équipe et affectations → Membres inscrits → Outils accessibles**. Pour limiter un intervenant ou un lecteur au suivi des chambres, sélectionner **Suivi des chambres uniquement**. Le menu de choix n'apparaît plus pour ce membre : le suivi des chambres s'ouvre directement. Les administrateurs conservent l'accès aux deux outils.

Les nouveaux comptes invités ont uniquement accès au suivi des chambres. Lors de l'installation de la migration, les membres déjà inscrits conservent initialement leur accès actuel aux deux outils ; il faut donc limiter explicitement la personne concernée dans l'équipe. Un nouvel outil ajouté plus tard doit disposer de sa propre autorisation explicite côté interface et côté serveur : les membres limités n'y accèdent pas par défaut.

Pour publier cette version sur le projet Supabase existant, exécuter **une fois** [`0028_module_access.sql`](../supabase/migrations/0028_module_access.sql) dans le SQL Editor du projet **avant** de publier le site. Cette migration ajoute `allowed_tools`, les fonctions `set_member_tools` et `get_tool_data`, et place le catalogue des équipements dans un schéma privé. Elle peut être relancée sans réinitialiser les restrictions déjà choisies.

Ensuite, publier le commit du site et modifier l'accès du membre. Le repérage des équipements est alors chargé uniquement après contrôle serveur. La version compilée du site ne contient plus le catalogue des typologies d'équipements.
