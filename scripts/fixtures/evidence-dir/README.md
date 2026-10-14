# Evidence-dir checker fixtures

These files are the tests of `scripts/assert-evidence-dir.mjs`. They are inert on disk: no file here holds a
value that any checker rule matches. Every planted value exists only as a placeholder inside a case operation and
is built, from fragments, in a temporary directory while `--selftest` runs.

## Layout

- `base-host/` is a phase-dir-shaped tree: `64-WALL-GATE.md` and `64-evidence/` with the host layouts of the
  earlier plans (baselines, wall, owner-store-host, relay, dkg-host, host-voter, scanner-bundle). It passes as is.
- `base-device/` holds `64-device-evidence/`: the summary, the camera-gate layout on its legal retry path, one
  rehearsal session of three runs, and the replay results file. It passes as is, and `--streak 3` passes on it.
- `cases/<name>.json` is one case each. A `pass-*` case expects a pass. A `fail-<token>[--<variant>]` case expects
  exactly the one token named, and the self-test asserts that the set of distinct tokens equals that one token.

## Case file

A single JSON object with the keys `base` (`base-host` or `base-device`), an optional `args` array (extra
checker arguments such as the git flag or the streak flag), `ops` (an ordered array) and `expect` (`PASS` or a
token). The checker is run on the case root, which holds the copied base plus the effect of the ops.

## Operations

Each op is an object with an `op` key. Paths are relative to the case root.

- `write` (`path`, `content`) and `append` (`path`, `content`).
- `delete` (`path`; a file or a directory) and `move` (`from`, `to`).
- `symlink` (`path`, `target`): the only way a link ever exists; no link is stored in this directory.
- `git-init`: initialise a repository in the case root and commit everything, with fixed identity, no signing, no
  hooks and no user or system config.
- `git-commit`: stage everything and commit with the same settings.
- `secrets-file` (`secret`): writes a secrets file next to the case root, outside it, and passes it to the
  checker as its single secrets-file argument.

## Placeholders

Written as the word PLANT with a kind, inside double braces, in an op's `content`. The materialiser replaces each one
with a synthetic string that is never a decodable code. The kinds, in words:

- Join codes: a first-version prefix, and a second-version prefix, each followed by a synthetic body.
- A cadre invitation prefix followed by a synthetic body.
- A JSON pair whose key is the invite private key name, with a synthetic value.
- A raw certificate chain: a long base64 DER run built from a repeated synthetic word.
- Inline image data: a data URL head followed by a short synthetic body.
- A vote needle in the tag-needle-id form.
- A known secret of forty characters, and a known window (sixteen characters taken from inside it).
- Device identifier pairs: a camelCase pair for the device evidence zone, and a PascalCase column pair for the host zone.
- Nonce pairs, in the same two forms.
- Attestation pairs: a statement pair with a long value, and a details column pair whose value is a JSON string.
- The raw capture wrapper of the association probe: version, probe id and a rows array.
- A tool-call markup tag.
- A phone data-clear command, as one pre-quoted remote adb string.
- A process-list command with the forbidden extended-regex flag.
- Four mention kinds that must PASS: a test title that merely names the join prefix, the invitation prefix with
  a trailing space, a sentence naming the invite private key word, and a code expression that assigns a probe
  token to the device id key.

## Adding a case

Add the file under `cases/`, name it for its token, and re-run `node scripts/assert-evidence-dir.mjs --selftest`.
The count in the final line is 46 case files plus the self-trip pass.
