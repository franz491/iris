Gives shell access to the AI into a docker container with a single folder mounted, no symlinks.

- shell_oneshot: send a command and receive the output, then close the shell
- shell_interactive: send a command and keep the shell open, allowing interaction or following commands. binds stdin, stdout, stderr into three streams, and returns them.

ADDITIONAL CONFIG
the shell folder, shell/ by default.

## ASSUMPTIONS
- shell_interactive returns a generated sessionId; the raw stdio streams are retrievable via an internal `__get_session` call until proper stream plumbing through the API exists.
- Sessions die with the container (--rm). "No symlinks" is enforced purely by mount isolation (outside targets don't exist in the container); no symlink stripping is performed.
- Same dockerExecutable/dockerImage/timeoutMs settings as files.
