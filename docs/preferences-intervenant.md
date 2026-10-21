# Affichage personnel des tâches

Dans le suivi des chambres, un intervenant connecté ouvre **Mes tâches** dans l'en-tête. Il peut mettre sur **ON** ou **OFF** les types de tâches qui lui sont actuellement affectés, puis cliquer une seule fois sur **Enregistrer**. Le choix est conservé dans Supabase pour son compte, sur tous ses appareils. Il ne modifie ni l'avancement ni l'affichage des autres membres. Fermer la fenêtre avant l'enregistrement abandonne les choix en cours.

Sans choix personnel, seuls **Cloisons** et **Chape** sont ON pour la chambre ; seuls **Étanchéité**, **Enduit ciment**, **Dressage** et **Chape** sont ON pour la salle de bain. Tous les autres types sont OFF pour l'intervenant. Les anciens choix personnels restent prioritaires et ne sont pas effacés.

Les tâches masquées par l'administrateur pour le projet ou pour cet intervenant restent indisponibles : le réglage personnel ne permet pas de contourner ces décisions. Une tâche qui n'est plus affectée à l'intervenant ne peut plus être réglée par lui. Les tâches masquées personnellement restent dans **Mes tâches** pour pouvoir être remises sur ON.

Avant de publier le site, exécuter [`0030_worker_task_preferences.sql`](../supabase/migrations/0030_worker_task_preferences.sql), puis [`0031_batch_worker_task_preferences.sql`](../supabase/migrations/0031_batch_worker_task_preferences.sql) dans le SQL Editor Supabase, après la migration 0029. Si 0030 est déjà appliquée, exécuter seulement 0031. Il n'y a pas de fonction Edge à redéployer pour cette option.
