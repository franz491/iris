logging.ts - misc logging, with verbosity levels

## ASSUMPTIONS
- Implemented with verbosity levels (debug/info/warn/error/silent), configurable via IRIS_LOG_LEVEL env var or setLogLevel(); optional file sink via IRIS_LOG_FILE/setLogFile().
- Log format: `[timestamp] [LEVEL] [scope] message`, scope-based child loggers.
