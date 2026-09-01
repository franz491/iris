error.ts - Error handling utilities

## ASSUMPTIONS
- AppError base class with a machine-readable `code` used to derive HTTP status codes in the API layer; NotFoundError/UnauthorizedError/ValidationError/ConfigError subclasses.
