# CSV/SFTP drop host (S-16, Q-L)

**[DevOps + Security Engineer]** The app never pulls from a remote SFTP server (D-54). Buyers upload to an OpenSSH
host we run; files land in `ERP_DROP_ROOT/<connectionId>/incoming` and the importer takes them from there.

## Host configuration (OpenSSH, one Unix user per ERP connection)

```
# /etc/ssh/sshd_config.d/mapema-drop.conf
Match Group mapema-drop
    ChrootDirectory /srv/erp-drop/%u          # root-owned, 0755, not writable by the user
    ForceCommand internal-sftp -u 0027 -l INFO
    AuthenticationMethods publickey           # key-only; no passwords
    PasswordAuthentication no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
```

- `/srv/erp-drop/<user>/incoming` is owned by the user (0750); the API host mounts `/srv/erp-drop/<user>` as
  `ERP_DROP_ROOT/<connectionId>` read-write for the importer only.
- One key per buyer, rotated yearly; firewall the SFTP port to the buyer's published egress IPs where they have them.

## What the importer enforces (tested in packages/adapters/test/golive.test.ts)

- Only regular files: symlinks, FIFOs, directories, files whose real path leaves the folder and world-writable files are
  moved to `rejected/` as `unsafe_file` (never read).
- Every file is scanned before parsing (`ADAPTER_MODE_AV=clamd`, ClamAV `INSTREAM` over TCP to `CLAMD_HOST:CLAMD_PORT`).
  Infected files go to `quarantine/` and are listed on the import run as `infected` with the signature (ops sees it in
  the connection's run history; a push alert is a go-live checklist item); scanner errors leave the file in `incoming`
  (`scan_failed`) so nothing unscanned is processed. The mock scanner (EICAR only) is refused in production.
- Files are de-duplicated by SHA-256 and pass the same invoice checks as manual uploads.
