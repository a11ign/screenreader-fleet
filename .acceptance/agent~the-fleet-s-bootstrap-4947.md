The bootstrap pins the role's Edge build (a11ign#4947, from a11ign#4939): `155.0.4283.45`, its MSI URL and its SHA-256, together, copied from `worker_edge_*` in `ansible/roles/worker/defaults/main.yml` at a11ign/control `main`.

Acceptance:
```bash
bash -c 'test "$(grep -c -F -e 155.0.4283.45 -e 2e772119-b856-4562-ad9a-8422e4224d42 -e 46db09d14b85a0df8bca87fbe9c3224ccf54f97d776bedc2eebf4b0c2ccbf5b4 src/provisioning/bootstrap-windows-worker.ps1)" -ge 3'
bash -c '! grep -n -F -e 152.0.4191.66 -e 5bcf8cd57351ddaa94419f800f8d90b8cbaf2b485b49d9ddb07d055b76a518df src/provisioning/bootstrap-windows-worker.ps1'
```
