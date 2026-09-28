# ISO Verification — archlinux-2026.08.01-x86_64.iso

- File:  ~/ai-arch/iso/archlinux-2026.08.01-x86_64.iso
- Size:  1597014016 bytes (1523 MiB)
- Source: https://mirror.arizona.edu/archlinux/iso/latest/archlinux-2026.08.01-x86_64.iso

## SHA256
- Actual:   4e82dced1c4fd3e498b22a853f8db2a4d262d32b97e7e07d97390d9e425ffe5e
- Expected: 4e82dced1c4fd3e498b22a853f8db2a4d262d32b97e7e07d97390d9e425ffe5e
- Result:   PASS (matches official sha256sums.txt fetched from mirror)

## GPG
- Signature: .sig, made Sat 01 Aug 2026 09:12:33 AM CDT
- Signer:  Pierre Schmitz <pierre@archlinux.org> (EDDSA)
- Fingerprint: 3E80 CA1A 8B89 F69C BA57 D98A 76A5 EF90 5444 9A5C
- Local result: Good signature
- Cross-check: fingerprint matches keyholder's published key (pierre-schmitz.com/gpg-keys)
  and the same key used to sign official Arch ISOs in community records.
- Result: PASS

## Notes
- Initial GPG run reported "No public key" (key not yet in keyring); after import,
  verification returns "Good signature". Trust warning ("not certified with a
  trusted signature") is expected for a freshly-imported key.
