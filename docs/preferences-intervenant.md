# Affichage personnel des tâches

Dans le suivi des chambres, un intervenant connecté ouvre **Mes tâches** dans l'en-tête. Il peut mettre sur **ON** ou **OFF** les types de tâches qui lui sont actuellement affectés. Le choix est conservé dans Supabase pour son compte, sur tous ses appareils. Il ne modifie ni l'avancement ni l'affichage des autres membres.

Les tâches masquées par l'administrateur pour le projet ou pour cet intervenant restent indisponibles : le réglage personnel ne permet pas de contourner ces décisions. Une tâche qui n'est plus affectée à l'intervenant ne peut plus être réglée par lui. Les tâches masquées personnellement restent dans **Mes tâches** pour pouvoir être remises sur ON.

Avant de publier le site, exécuter [`0030_worker_task_preferences.sql`](../supabase/migrations/0030_worker_task_preferences.sql) dans le SQL Editor Supabase, après la migration 0029. Il n'y a pas de fonction Edge à redéployer pour cette option.
