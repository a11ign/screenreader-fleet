A11-183 step 1 of 2. `bootstrap-windows-worker.ps1` moves its Edge pin (version, enterprise MSI URL and SHA-256, all three together) from `155.0.4283.45` to `156.0.4314.42`, the newest Stable x64 build in `https://edgeupdates.microsoft.com/api/products?view=enterprise` (published 2026-10-22T19:20Z, re-read 2026-10-24). Control's `edge-pin-parity.test.ts` holds the bootstrap equal to the worker role's pin, so control (step 2) moves the role to the same three values once this release is published. No other file changes.

Acceptance:

```bash
f=src/provisioning/bootstrap-windows-worker.ps1
grep -q "'156.0.4314.42'" "$f" \
  && grep -q "62209208-6eb6-4f5e-bff5-feb45cfe41d3/MicrosoftEdgeEnterpriseX64.msi" "$f" \
  && grep -q "324d226c5ade08c2776645cfc2a7b12af9c08214abf18c6499410cd8ed92d1b3" "$f" \
  && ! grep -q "155.0.4283.45\|2e772119-b856-4562-ad9a-8422e4224d42\|46db09d14b85a0df8bca87fbe9c3224ccf54f97d776bedc2eebf4b0c2ccbf5b4" "$f" \
  && pnpm test
```
