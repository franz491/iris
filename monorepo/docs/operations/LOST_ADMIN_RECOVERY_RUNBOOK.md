# Lost administrator recovery

Run this procedure on the backend machine when an administrator cannot sign in.
Recovery still requires an existing administrator actor; it is not a bypass or
bootstrap mechanism. Identify the account exactly by its normalized username or
email. If more than one account matches, the command fails closed.

Place the replacement credential in a regular file owned by the service account
with mode `0600` (or pipe it on stdin). Do not put it in shell arguments. Then run:

```sh
IRIS_RECOVERY_ACTOR=<admin-user-id> \
IRIS_RECOVERY_CONFIRM=LOST_ADMIN_RECOVERY \
iris recovery lost-admin <username-or-email> --credential-file /secure/new-credential
```

The command validates the canonical credential policy, updates the BetterAuth
credential, revokes every session for the target, and writes a bounded audit
event (`user.lost_admin_recovery`) containing identifiers only. The credential
is never printed or written to audit data. Delete the temporary credential file
after completion using the host's secure disposal procedure.
