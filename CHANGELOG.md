# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.2.0] - 2026-04-16

### Changed
- Discovery is now local-only. Shelly Cloud enrichment has been removed entirely.
- Discovery always applies local friendly names and room metadata when available.
- Discovery tool inputs were simplified by removing now-obsolete enrichment options.

### Removed
- Cloud enrichment implementation and credential flow.
- Cloud setup script and cloud credential helpers.
- Cloud-related fields in device persistence and discovery responses.
- Cloud-related environment variables and documentation.

### Notes
- Existing users should ensure local discovery settings are present in `discovery.config.json`.
- Package version bumped to `0.2.0`.
