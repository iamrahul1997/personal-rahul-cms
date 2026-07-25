# Rahul's CMS

A lightweight content manager for [personal-rahul](https://github.com/iamrahul1997/personal-rahul)
(the site at personal-rahul.vercel.app). Write essays in a rich-text editor,
add a feature image, set the meta title/description, and create or assign
categories — hitting **Publish** commits everything to the site repo and
Vercel deploys it automatically in ~30 seconds.

No database, no backend: the CMS is a static page that talks straight to the
GitHub API from your browser. Your token never leaves your machine.

## Deploy (one time)

1. On Vercel: **Add New → Project → import `personal-rahul-cms`** → Deploy.
   No build settings needed — it's plain HTML/JS.
2. Create a GitHub token at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories → `personal-rahul`**
   - Permissions: **Contents → Read and write**
3. Open your deployed CMS → it shows **Set up your login** → paste the token,
   choose a username (default `admin`) and a strong password → **Create login & connect**.

From then on you sign in with just the username + password, from any device.

## How the login works

Your password never gets stored anywhere. At setup, the CMS encrypts the
GitHub token with your password (PBKDF2 → AES-256-GCM, all in your browser)
and commits only the encrypted blob to the site repo (`cms/auth.json`).
Signing in downloads that blob and decrypts it locally; the token lives in
sessionStorage until you close the tab or log out. Wrong password = failed
decryption = no access. To change the password (or rotate the token), just
run Settings → setup again.

## What Publish does

1. Uploads the feature image (and any inline images) to `assets/uploads/` in the site repo
2. Saves the article data to `content/articles/<slug>.json`
3. Generates the article page `articles/<slug>.html` (with meta title,
   description, and og:image)
4. Updates `content/index.json` — the home page, writing page, and category
   filters pick it up automatically; marking an essay Featured un-features the others

## Run locally

```
python3 -m http.server 8730
```

Then open http://localhost:8730.
