files.ts - utilities for file download and upload through the frontend

## ASSUMPTIONS
- Frontend file up/download proxies through the files provider's sandbox: GET reads, PUT creates/overwrites. Text-only for now (binary storage deferred).

## ANSWERS
- Binary support is wanted soon, including image streaming; plan byte-safe storage in the files provider layer.

## IMPLEMENTED
- Binary-safe: provider read_file/create_file accept encoding=base64; API GET/PUT transfer raw bytes.
