/* ============================================================
   Rahul's CMS — publishes articles to the personal-rahul repo
   via the GitHub API. Vercel redeploys the site automatically
   after every publish.
   ============================================================ */
(function () {
  "use strict";

  var OWNER = "iamrahul1997";
  var REPO = "personal-rahul";
  var BRANCH = "main";
  /* The site's public address. When your custom domain is live, change
     this ONE line (e.g. "https://poudelrahul.com.np") — it only affects
     "View" links, image previews, and og:image URLs on NEW publishes.
     Nothing else in the CMS or site depends on the domain. */
  var SITE_URL = "https://personal-rahul.vercel.app";
  var API = "https://api.github.com";
  var TOKEN_KEY = "cms_gh_token";

  var AUTH_PATH = "cms/auth.json";
  var SESSION_KEY = "cms_session_token";

  var state = { index: [], editing: null, imageFile: null, imagePath: null };
  var quill = null;

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function token() {
    return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(TOKEN_KEY) || "";
  }
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, "")))); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function slugify(s) {
    return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  function setStatus(id, msg, isError) {
    var el = $(id);
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }
  function toast(msg, isError) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.setAttribute("role", "alert");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 12000 : 6000);
  }
  function monthYear() {
    return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  /* ---------------- GitHub API ---------------- */
  function gh(path, opts) {
    opts = opts || {};
    var method = (opts.method || "GET").toUpperCase();
    opts.headers = Object.assign({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token(),
      "X-GitHub-Api-Version": "2022-11-28",
    }, opts.headers || {});
    return fetch(API + path, opts).then(function (res) {
      if (res.status === 404) {
        /* For reads, 404 just means "file not there yet". For writes it
           means the token can't touch the repo — GitHub hides repos it
           won't authorize. Never treat that as success. */
        if (method === "GET") return null;
        throw new Error(
          "GitHub returned 404 on a write — your token can't access " + OWNER + "/" + REPO +
          ". Recreate it with Repository access: only personal-rahul, and Contents: Read and write, then run Settings → setup again."
        );
      }
      if (res.status === 401) {
        throw new Error("GitHub rejected the token (401 — revoked or expired). Run Settings → setup again with a fresh token.");
      }
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (body) {
        throw new Error("GitHub " + res.status + ": " + (body.message || "request failed"));
      });
      return res.status === 204 ? {} : res.json();
    });
  }
  function getFile(path) {
    return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path + "?ref=" + BRANCH);
  }
  function putFile(path, base64Content, message, sha) {
    var body = { message: message, content: base64Content, branch: BRANCH };
    if (sha) body.sha = sha;
    return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  function putText(path, text, message) {
    return getFile(path).then(function (existing) {
      return putFile(path, b64encode(text), message, existing && existing.sha);
    });
  }
  function deletePath(path, message) {
    return getFile(path).then(function (existing) {
      if (!existing) return null;
      return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path, {
        method: "DELETE",
        body: JSON.stringify({ message: message, sha: existing.sha, branch: BRANCH }),
      });
    });
  }

  /* ---------------- password auth (AES-GCM over the token) ---------------- */
  function bufToB64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
  function b64ToBuf(b64) {
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function deriveKey(password, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: 200000, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
      });
  }
  function encryptToken(tok, username, password) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(tok));
    }).then(function (data) {
      return { v: 1, user: username, salt: bufToB64(salt), iv: bufToB64(iv), data: bufToB64(data) };
    });
  }
  function decryptToken(blob, password) {
    return deriveKey(password, b64ToBuf(blob.salt)).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBuf(blob.iv) }, key, b64ToBuf(blob.data));
    }).then(function (buf) { return new TextDecoder().decode(buf); });
  }
  function fetchAuthBlob() {
    return fetch("https://raw.githubusercontent.com/" + OWNER + "/" + REPO + "/" + BRANCH + "/" + AUTH_PATH + "?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* ---------------- views ---------------- */
  function show(view) {
    ["view-login", "view-settings", "view-list", "view-editor"].forEach(function (v) {
      $(v).hidden = v !== view;
    });
    $("nav-logout").hidden = !sessionStorage.getItem(SESSION_KEY);
  }

  function loadIndex() {
    return getFile("content/index.json").then(function (file) {
      if (!file) {
        throw new Error(
          "Couldn't read the article list from " + OWNER + "/" + REPO +
          " — the token probably lacks access to the repo. Check Settings."
        );
      }
      state.index = JSON.parse(b64decode(file.content));
      return state.index;
    });
  }

  function renderList() {
    var box = $("article-rows");
    box.innerHTML = "";
    state.index.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "row-card";
      row.innerHTML =
        '<div><div class="title">' + esc(a.title) + '</div>' +
        '<div class="meta">' + esc(a.category) + " · " + esc(a.date) + " · " + a.minutes + " min</div></div>" +
        (a.featured ? '<span class="badge">Featured</span>' : "") +
        '<span class="spacer"></span>' +
        '<a class="btn" href="' + SITE_URL + '/articles/' + a.slug + '" target="_blank" rel="noopener">View</a>' +
        '<button class="btn" data-edit="' + a.slug + '" type="button">Edit</button>' +
        '<button class="btn btn-danger" data-del="' + a.slug + '" type="button">Delete</button>';
      box.appendChild(row);
    });
  }

  function categoryOptions(selected) {
    var cats = [];
    state.index.forEach(function (a) {
      if (cats.indexOf(a.category) === -1) cats.push(a.category);
    });
    if (!cats.length) cats = ["Geopolitics", "Technology", "Nepal"];
    var sel = $("f-category");
    sel.innerHTML = cats.map(function (c) {
      return '<option' + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  function openEditor(article) {
    state.editing = article ? article.slug : null;
    state.imageFile = null;
    state.imagePath = article ? article.image : null;
    $("editor-title").textContent = article ? "Edit article" : "New article";
    $("f-title").value = article ? article.title : "";
    $("f-slug").value = article ? article.slug : "";
    $("f-slug").disabled = !!article;
    $("f-date").value = article ? article.date : monthYear();
    $("f-minutes").value = article ? article.minutes : "";
    $("f-excerpt").value = article ? article.excerpt : "";
    $("f-featured").checked = article ? !!article.featured : false;
    $("f-meta-title").value = article ? (article.metaTitle || "") : "";
    $("f-meta-desc").value = article ? (article.metaDescription || "") : "";
    $("f-new-category").value = "";
    categoryOptions(article ? article.category : undefined);
    $("image-preview").hidden = !state.imagePath;
    if (state.imagePath) $("image-preview").src = SITE_URL + state.imagePath;
    $("image-note").textContent = state.imagePath ? "Current image shown. Choose a file to replace it." : "";
    $("f-image").value = "";
    quill.setContents([]);
    setStatus("editor-status", "");
    if (article) {
      setStatus("editor-status", "Loading content…");
      getFile("content/articles/" + article.slug + ".json").then(function (file) {
        var doc = JSON.parse(b64decode(file.content));
        quill.clipboard.dangerouslyPasteHTML(doc.html || "");
        setStatus("editor-status", "");
      }).catch(function (e) { setStatus("editor-status", e.message, true); });
    }
    show("view-editor");
  }

  /* ---------------- article page template ---------------- */
  function pageTemplate(doc) {
    var metaTitle = doc.metaTitle || (doc.title + " — Rahul Poudel");
    var metaDesc = doc.metaDescription || doc.excerpt;
    var cover = doc.image
      ? '\n      <div class="section-shell">\n        <img class="article-cover" src="' + doc.image + '" alt="" />\n      </div>'
      : "";
    var canonical = SITE_URL + "/articles/" + doc.slug;
    var ogImg = SITE_URL + (doc.image || "/assets/rahul-lake.jpg");
    var og =
      '\n    <link rel="canonical" href="' + canonical + '" />' +
      '\n    <meta property="og:type" content="article" />' +
      '\n    <meta property="og:url" content="' + canonical + '" />' +
      '\n    <meta property="og:image" content="' + ogImg + '" />' +
      '\n    <meta name="twitter:card" content="summary_large_image" />';
    return '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta name="description" content="' + esc(metaDesc) + '" />\n    <title>' + esc(metaTitle) + '</title>\n    <meta property="og:title" content="' + esc(metaTitle) + '" />\n    <meta property="og:description" content="' + esc(metaDesc) + '" />' + og + '\n    <link rel="preconnect" href="https://fonts.googleapis.com" />\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    <link\n      href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700&display=swap"\n      rel="stylesheet"\n    />\n    <link rel="icon" type="image/jpeg" href="../assets/rahul-portrait.jpg" />\n    <link rel="stylesheet" href="../styles.css" />\n  </head>\n  <body>\n    <a class="skip-link" href="#main">Skip to content</a>\n\n    <div class="nav-wrap">\n      <header class="site-header">\n        <a class="brand" href="/" aria-label="Rahul Poudel home">\n          <img class="brand-mark" src="../assets/rahul-portrait.jpg" alt="" />\n          <span>Rahul Poudel</span>\n        </a>\n        <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="primary-nav">\n          <span></span><span></span>\n          <span class="sr-only">Open menu</span>\n        </button>\n        <nav id="primary-nav" class="primary-nav" aria-label="Primary navigation">\n          <a href="/">Home</a>\n          <a href="/writing" aria-current="page">Writing</a>\n          <a href="/about">About</a>\n          <a href="/contact" class="nav-cta">Let\'s talk <span aria-hidden="true">↗</span></a>\n        </nav>\n      </header>\n    </div>\n\n    <main id="main">\n      <header class="article-hero section-shell">\n        <p class="eyebrow">' + esc(doc.category) + '</p>\n        <h1>' + esc(doc.title) + '</h1>\n        <div class="article-byline">\n          <span>By Rahul Poudel</span><span class="dot"></span>\n          <span>' + esc(doc.date) + '</span><span class="dot"></span>\n          <span>' + doc.minutes + ' min read</span>\n        </div>\n      </header>' + cover + '\n\n      <article class="article-body section-shell">\n' + doc.html + '\n      </article>\n\n      <div class="article-footer section-shell">\n        <a class="text-link" href="/writing"><span aria-hidden="true">←</span> All writing</a>\n        <a class="text-link" href="/contact">Discuss this essay <span aria-hidden="true">→</span></a>\n      </div>\n    </main>\n\n    <!-- ===== Newsletter ===== -->\n    <section class="newsletter">\n      <div class="halftone ht-news" aria-hidden="true"></div>\n      <div class="section-shell newsletter-inner" data-reveal>\n        <p class="eyebrow">Newsletter</p>\n        <h2>Get new essays in your inbox.</h2>\n        <p class="newsletter-blurb">No spam. Just geopolitics, technology, and Nepal—when there\'s something worth reading.</p>\n        <form class="newsletter-form" data-newsletter novalidate>\n          <label class="sr-only" for="nl-email">Email address</label>\n          <input id="nl-email" name="email" type="email" required placeholder="you@example.com" autocomplete="email" />\n          <button class="button button-primary" type="submit">Subscribe</button>\n        </form>\n        <p class="form-note" role="status" aria-live="polite"></p>\n      </div>\n    </section>\n\n    <footer class="site-footer">\n      <div class="section-shell footer-inner">\n        <div>\n          <a class="brand" href="/"><img class="brand-mark" src="../assets/rahul-portrait.jpg" alt="" /><span>Rahul Poudel</span></a>\n          <p>Global affairs, Nepal, and technology. © <span id="year"></span> Rahul Poudel</p>\n        </div>\n        <nav aria-label="Footer">\n          <a href="/writing">Writing</a>\n          <a href="/about">About</a>\n          <a href="/contact">Contact</a>\n          <a href="https://instagram.com/rahul.poudel_" target="_blank" rel="noopener">Instagram <span aria-hidden="true">↗</span></a>\n          <a href="https://github.com/iamrahul1997" target="_blank" rel="noopener">GitHub <span aria-hidden="true">↗</span></a>\n        </nav>\n      </div>\n    </footer>\n\n    <script src="../script.js"></script>\n  </body>\n</html>\n';
  }

  /* ---------------- sitemap ---------------- */
  function sitemapXML(list) {
    var urls = ["/", "/writing", "/about", "/contact"].map(function (p) { return SITE_URL + p; });
    list.forEach(function (a) { urls.push(SITE_URL + "/articles/" + a.slug); });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map(function (u) { return "  <url><loc>" + u + "</loc></url>"; }).join("\n") +
      "\n</urlset>\n";
  }

  /* ---------------- publish pipeline ---------------- */
  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function publish() {
    var title = $("f-title").value.trim();
    var slug = state.editing || slugify($("f-slug").value.trim() || title);
    var newCat = $("f-new-category").value.trim();
    var category = newCat || $("f-category").value;
    var html = quill.getSemanticHTML().trim();
    var text = quill.getText().trim();
    if (!title || !slug) return setStatus("editor-status", "Title (and slug) are required.", true);
    if (!category) return setStatus("editor-status", "Pick or create a category.", true);
    if (text.length < 40) return setStatus("editor-status", "The article body looks empty.", true);

    var minutes = parseInt($("f-minutes").value, 10) || Math.max(1, Math.round(text.split(/\s+/).length / 200));
    var doc = {
      slug: slug,
      title: title,
      category: category,
      date: $("f-date").value.trim() || monthYear(),
      minutes: minutes,
      excerpt: $("f-excerpt").value.trim() || text.slice(0, 160).trim() + "…",
      featured: $("f-featured").checked,
      image: state.imagePath,
      metaTitle: $("f-meta-title").value.trim() || null,
      metaDescription: $("f-meta-desc").value.trim() || null,
    };

    var btn = $("publish");
    btn.disabled = true;
    var chain = Promise.resolve();

    if (state.imageFile) {
      chain = chain.then(function () {
        setStatus("editor-status", "Uploading feature image…");
        var ext = (state.imageFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        var path = "assets/uploads/" + slug + "-cover-" + Date.now() + "." + ext;
        return readFileAsBase64(state.imageFile).then(function (b64) {
          return putFile(path, b64, "CMS: upload image for " + slug);
        }).then(function () {
          doc.image = "/" + path;
        });
      });
    }

    chain
      .then(function () {
        setStatus("editor-status", "Saving article content…");
        doc.html = html;
        return putText("content/articles/" + slug + ".json", JSON.stringify(doc, null, 2) + "\n", "CMS: save " + slug);
      })
      .then(function () {
        setStatus("editor-status", "Generating article page…");
        return putText("articles/" + slug + ".html", pageTemplate(doc), "CMS: publish page for " + slug);
      })
      .then(function () {
        setStatus("editor-status", "Updating article index…");
        return loadIndex().then(function (list) {
          var entry = {
            slug: doc.slug, title: doc.title, category: doc.category, date: doc.date,
            minutes: doc.minutes, excerpt: doc.excerpt, featured: doc.featured,
            image: doc.image, metaTitle: doc.metaTitle, metaDescription: doc.metaDescription,
          };
          var i = list.findIndex(function (a) { return a.slug === slug; });
          if (i >= 0) list[i] = entry; else list.unshift(entry);
          if (entry.featured) list.forEach(function (a) { if (a.slug !== slug) a.featured = false; });
          return putText("content/index.json", JSON.stringify(list, null, 2) + "\n", "CMS: update index for " + slug).then(function () {
            setStatus("editor-status", "Updating sitemap…");
            return putText("sitemap.xml", sitemapXML(list), "CMS: update sitemap");
          });
        });
      })
      .then(function () {
        setStatus("editor-status", "✅ Published! Vercel is deploying — live in ~30 seconds at /articles/" + slug);
        toast("✅ Published! Live in ~30 seconds at /articles/" + slug);
        state.editing = slug;
        $("f-slug").disabled = true;
        state.imageFile = null;
      })
      .catch(function (e) {
        setStatus("editor-status", e.message, true);
        toast("❌ Publish failed: " + e.message, true);
      })
      .then(function () { btn.disabled = false; });
  }

  function removeArticle(slug) {
    if (!confirm("Delete “" + slug + "” from the site? This removes the page and the article data.")) return;
    setStatus("list-status", "Deleting…");
    loadIndex()
      .then(function (list) {
        var next = list.filter(function (a) { return a.slug !== slug; });
        return putText("content/index.json", JSON.stringify(next, null, 2) + "\n", "CMS: remove " + slug + " from index").then(function () {
          return putText("sitemap.xml", sitemapXML(next), "CMS: update sitemap");
        });
      })
      .then(function () { return deletePath("content/articles/" + slug + ".json", "CMS: delete content for " + slug); })
      .then(function () { return deletePath("articles/" + slug + ".html", "CMS: delete page for " + slug); })
      .then(function () { return loadIndex(); })
      .then(function () { renderList(); setStatus("list-status", "Deleted. Vercel is redeploying the site."); toast("Deleted — site is redeploying."); })
      .catch(function (e) { setStatus("list-status", e.message, true); toast("❌ Delete failed: " + e.message, true); });
  }

  /* ---------------- wiring ---------------- */
  function goList() {
    setStatus("list-status", "Loading…");
    loadIndex().then(function () {
      renderList();
      setStatus("list-status", "");
      show("view-list");
    }).catch(function (e) {
      setStatus("list-status", e.message + " — check your token in Settings.", true);
      show("view-list");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    quill = new Quill("#quill", {
      theme: "snow",
      placeholder: "Write your essay…",
      modules: {
        toolbar: {
          container: [
            [{ header: 2 }],
            ["bold", "italic", "underline", "link"],
            ["blockquote"],
            [{ list: "ordered" }, { list: "bullet" }],
            ["image"],
            ["clean"],
          ],
          handlers: {
            image: function () {
              var input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = function () {
                var f = input.files[0];
                if (!f) return;
                setStatus("editor-status", "Uploading inline image…");
                var ext = (f.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
                var path = "assets/uploads/inline-" + Date.now() + "." + ext;
                readFileAsBase64(f).then(function (b64) {
                  return putFile(path, b64, "CMS: upload inline image");
                }).then(function () {
                  var range = quill.getSelection(true);
                  quill.insertEmbed(range.index, "image", "/" + path);
                  setStatus("editor-status", "");
                }).catch(function (e) { setStatus("editor-status", e.message, true); });
              };
              input.click();
            },
          },
        },
      },
    });

    $("nav-articles").onclick = goList;
    $("nav-settings").onclick = function () { show("view-settings"); };
    $("nav-logout").onclick = function () {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
      show("view-login");
    };

    $("login-btn").onclick = function () {
      var user = $("login-user").value.trim();
      var pass = $("login-pass").value;
      if (!user || !pass) return setStatus("login-status", "Enter your username and password.", true);
      setStatus("login-status", "Signing in…");
      fetchAuthBlob().then(function (blob) {
        if (!blob) {
          return setStatus("login-status",
            "No login has been created yet. Go to Settings, paste your GitHub token, choose a password, and click “Create login & connect”.", true);
        }
        if (blob.user !== user) { setStatus("login-status", "Wrong username or password.", true); return; }
        decryptToken(blob, pass).then(function (tok) {
          sessionStorage.setItem(SESSION_KEY, tok);
          setStatus("login-status", "Checking GitHub access…");
          return gh("/repos/" + OWNER + "/" + REPO).then(function (repo) {
            if (!repo) throw new Error("no-access");
            setStatus("login-status", "");
            $("login-pass").value = "";
            goList();
          }).catch(function () {
            sessionStorage.removeItem(SESSION_KEY);
            setStatus("login-status",
              "Password correct, but the saved GitHub token no longer works (revoked or expired). Go to Settings and run setup again with a fresh token.", true);
          });
        }).catch(function () {
          setStatus("login-status", "Wrong username or password.", true);
        });
      });
    };
    $("login-pass").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("login-btn").click();
    });

    $("setup-save").onclick = function () {
      var tok = $("token").value.trim();
      var user = $("setup-user").value.trim() || "admin";
      var pass = $("setup-pass").value;
      if (!tok) return setStatus("settings-status", "Paste your GitHub token first.", true);
      if (pass.length < 8) return setStatus("settings-status", "Password must be at least 8 characters.", true);
      if (pass !== $("setup-pass2").value) return setStatus("settings-status", "Passwords don't match.", true);
      setStatus("settings-status", "Checking token…");
      sessionStorage.setItem(SESSION_KEY, tok);
      gh("/repos/" + OWNER + "/" + REPO).then(function (repo) {
        if (!repo) throw new Error("Token can't see " + OWNER + "/" + REPO + " — check its repository access.");
        setStatus("settings-status", "Encrypting and saving your login…");
        return encryptToken(tok, user, pass);
      }).then(function (blob) {
        return putText(AUTH_PATH, JSON.stringify(blob, null, 2) + "\n", "CMS: update login");
      }).then(function () {
        $("token").value = ""; $("setup-pass").value = ""; $("setup-pass2").value = "";
        setStatus("settings-status", "✅ Login created. You're signed in — next time just use your password.");
        goList();
      }).catch(function (e) {
        sessionStorage.removeItem(SESSION_KEY);
        setStatus("settings-status", e.message, true);
      });
    };

    $("test-token").onclick = function () {
      var tok = $("token").value.trim();
      if (!tok) return setStatus("settings-status", "Paste a token to test.", true);
      setStatus("settings-status", "Testing…");
      fetch(API + "/repos/" + OWNER + "/" + REPO, {
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + tok },
      }).then(function (r) {
        setStatus("settings-status", r.ok ? "✅ Token works for " + OWNER + "/" + REPO : "Token rejected (" + r.status + ").", !r.ok);
      }).catch(function (e) { setStatus("settings-status", e.message, true); });
    };
    $("new-article").onclick = function () { openEditor(null); };
    $("back-to-list").onclick = goList;
    $("publish").onclick = publish;
    $("f-title").addEventListener("input", function () {
      if (!state.editing) $("f-slug").value = slugify($("f-title").value);
    });
    $("f-image").addEventListener("change", function () {
      var f = $("f-image").files[0];
      state.imageFile = f || null;
      if (f) {
        $("image-preview").src = URL.createObjectURL(f);
        $("image-preview").hidden = false;
        $("image-note").textContent = f.name;
      }
    });
    $("article-rows").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit]");
      var del = e.target.closest("[data-del]");
      if (edit) {
        var a = state.index.find(function (x) { return x.slug === edit.dataset.edit; });
        if (a) openEditor(a);
      } else if (del) {
        removeArticle(del.dataset.del);
      }
    });

    if (token()) {
      goList();
    } else {
      fetchAuthBlob().then(function (blob) {
        show(blob ? "view-login" : "view-settings");
      });
    }
  });
})();
