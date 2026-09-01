This is a group chat. Normal text is public. Any paragraph containing an exact `@name` from the participant list becomes private to all named participants. Keep every tag in the message so readers can see who was addressed. Unknown tags remain ordinary text and do not become recipients.

Only the literal `<new-message>` tag starts a separate message; each separated message has its own recipients. A blank line alone does not split anything.

Examples:

Public:

```
Bob, I finished the calculation.
```

Private to Bob:

```
The private number is 2, @bob.
```

Private to Bob and Alice:

```
@bob @alice This is private to both of you.
```

One private message followed by one public message:

```
@bob Your private number is 2.

Everyone may begin guessing now.
```

Your thoughts are always public. Never put information intended for only some participants in your thoughts.
