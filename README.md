# Grad Dossier 2027

The Fall 2027 graduate-applications dossier as a passphrase-locked web app on GitHub Pages. It works on phone and desktop, can be added to a home screen, and keeps working offline once opened.

## How privacy works here

GitHub Pages sites are public web pages, even when the repository is private. GitHub Free only publishes Pages from public repositories; a private repository needs a paid plan, and the site is still public either way.

So the site is encrypted instead:

- The readable dossier lives in `content/`, which is git-ignored. It never leaves this computer.
- `build.mjs` encrypts it with your passphrase (PBKDF2-SHA256, 600,000 iterations, AES-256-GCM). Only the ciphertext goes into `docs/`, which is the folder GitHub publishes.
- Your browser decrypts it locally after you type the passphrase. GitHub never sees the passphrase.

Anyone can download the encrypted file and try to guess the passphrase offline, so its strength is what protects you. Use four or more random words (for example from a password manager's passphrase generator), at least 12 characters. A public repository is fine for this setup; a private one also works if your plan supports Pages from private repositories.

## First publish (about ten minutes)

You need Node.js 18 or newer (`node -v` to check; `brew install node` if missing) and git.

1. **Create the repository.** On github.com, choose New repository. Name it, for example, `grad-dossier`. Leave it empty: no README, no licence, no .gitignore.
2. **Build and push.** In Terminal:

   ```sh
   cd ~/Root/grad-dossier
   ./publish.sh https://github.com/RavenSeldon/grad-dossier.git
   ```

   It asks for your passphrase twice, builds, commits, and pushes. If git asks you to sign in, use your GitHub username and a personal access token, or sign in through GitHub Desktop once.
3. **Turn on Pages.** In the repository, go to Settings, then Pages. Under Build and deployment, choose "Deploy from a branch", branch `main`, folder `/docs`, then Save.
4. **Open it.** After a minute or two the site is at `https://ravenseldon.github.io/grad-dossier/`. Unlock it, tick "Keep unlocked on this device" on devices you trust, and use Share → Add to Home Screen on your phone.

## Updating the dossier

1. Export the working document as Markdown and save it over `content/dossier.md`.
2. Edit `content/deadlines.json` if dates changed (it drives the timeline at the top).
3. Run `./publish.sh` and enter the same passphrase.

Using the same passphrase keeps every device you have unlocked working. A new passphrase locks them all, which is also how you revoke access.

## Ticked boxes

Ticks are saved in each browser only. Use "Save progress file" and "Load progress file" at the bottom of the page to move them between devices; loading merges by keeping whichever tick is newer and never deletes anything. A tick is tied to the task's wording, so rewording a task in the document clears that one tick.

## Checking a build

```sh
node test/verify.mjs      # encrypts with a test passphrase, decrypts it, checks no plaintext leaked
node build.mjs --preview  # readable copy in preview/ (git-ignored); open preview/index.html
```

## What is where

| Path | What it is | Published? |
| --- | --- | --- |
| `content/` | Readable dossier and deadlines | Never (git-ignored) |
| `app/` | Page, styles and script templates | Yes, as source |
| `docs/` | Encrypted build that GitHub Pages serves | Yes |
| `build.mjs` | Builds and encrypts | Yes |
| `publish.sh` | Builds, checks, commits and pushes | Yes |
| `dossier.salt` | Encryption salt; not secret | Yes |
| `vendor/` | [marked](https://github.com/markedjs/marked) Markdown renderer (MIT) | Yes |

The page asks search engines not to index it. That only discourages listing; the encryption is what keeps the content private.
