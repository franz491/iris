# Quality-gate policy

Critical security modules and their minimum coverage are recorded in
`coverage-policy.json`. The Vitest critical gate reads the same module set and
thresholds from `backend/vitest.config.ts`; the CI contract check rejects a
configuration that drops a module or lowers a threshold. Improvements are
allowed, but thresholds are never ratcheted downward. This is intentionally a
critical-module gate rather than a misleading whole-repository percentage.

Dependency and toolchain updates are grouped monthly through Dependabot for
the pnpm and Cargo lockfiles. Installs use the committed lockfile and
`--frozen-lockfile`; every update requires review and the full verification
workflow. Automated major upgrades are disabled. An emergency security update
may use an expedited maintainer-reviewed change, but must still pass the same
verification gates before merge.

Hosted CI runs the complete Linux gate and a Windows/macOS smoke matrix. The
platform jobs use the same pinned Node/pnpm versions and frozen workspace
install, then run backend/frontend typechecks, tests, builds, and clean-output
checks. Rust fmt/Clippy/tests remain in the Linux native gate because the
repository's supported Rust toolchain is defined there.
