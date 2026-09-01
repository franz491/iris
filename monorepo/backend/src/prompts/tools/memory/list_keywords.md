List the visible keywords for one memory `type`. Use this before recall to find useful keys and before storage to reuse existing vocabulary.

Example — discover remembered user topics:

```json
{ "type": "self" }
```

Returns `{"keywords":["preferences","coffee",...]}`. An empty list means no visible memories of that type exist.
