# Tâches visibles par défaut

Dans le suivi des chambres, les tâches initialement visibles sont **Cloisons chambre** et **Chape chambre**. Dans la salle de bain : **Étanchéité SDB**, **Enduit ciment — NOUR INOV**, **Dressage mur — BENTHAMI** et **Chape / forme de pente**. L'enduit ciment NOUR INOV reste réservé aux chambres standard, selon la règle existante.

Les autres tâches et leurs avancements ne sont pas supprimés. Elles passent sur **OFF** pour tous et restent disponibles dans **Gestion des tâches** pour qu'un administrateur puisse les remettre sur **ON**. Les exclusions individuelles déjà configurées restent en place.

Sur le projet Supabase existant, exécuter [`0029_default_tracking_tasks.sql`](../supabase/migrations/0029_default_tracking_tasks.sql) dans le SQL Editor avant de publier le site. La migration règle les tâches actuelles et celles des futurs projets. La relancer ne réinitialise pas les tâches qu'un administrateur a ensuite réactivées.
